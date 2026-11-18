import {
  Component,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  type App,
} from 'obsidian';
import {
  DEFAULT_PORT,
  STYLES_LANG,
  ANNOTATION_LANG,
  DEFAULT_STYLES,
  parseNote,
  quoteOf,
  styleConfigFromMarkdown,
  textFragmentUrl,
  type AnnotationData,
  type StyleConfig,
  type TextQuoteSelector,
  type ThemeInfo,
} from '@a08/core';
import { AnnotationServer, NoteService } from '@a08/server';
import { ObsidianVault } from './obsidian-vault.ts';
import { renderCard, renderStylesPreview } from './card.ts';

type Settings = {
  port: number;
  token: string;
  folder: string;
};

const DEFAULTS: Settings = { port: DEFAULT_PORT, token: '', folder: 'annotations' };

/** サイドパネルへ渡す Obsidian の CSS 変数 */
const THEME_VARS = [
  '--background-primary',
  '--background-primary-alt',
  '--background-secondary',
  '--background-secondary-alt',
  '--background-modifier-border',
  '--background-modifier-hover',
  '--background-modifier-form-field',
  '--text-normal',
  '--text-muted',
  '--text-faint',
  '--text-accent',
  '--text-accent-hover',
  '--text-on-accent',
  '--text-selection',
  '--interactive-accent',
  '--interactive-accent-hover',
  '--interactive-normal',
  '--interactive-hover',
  '--link-color',
  '--link-external-color',
  '--tag-color',
  '--tag-background',
  '--code-background',
  '--code-normal',
  '--blockquote-border-color',
  '--font-text',
  '--font-text-theme',
  '--font-monospace',
  '--font-interface',
  '--font-text-size',
  '--line-height-normal',
  '--h1-size',
  '--h2-size',
  '--h3-size',
  '--h4-size',
  '--radius-s',
  '--radius-m',
  '--color-accent',
  '--color-red',
  '--color-green',
  '--color-blue',
  '--color-yellow',
];

function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export default class AnnotationPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  service!: NoteService;
  server: AnnotationServer | null = null;
  styles: StyleConfig = DEFAULT_STYLES;
  private statusEl: HTMLElement | null = null;
  /** render() 中のノート本文（コードブロック処理からタグを引くため） */
  private renderTexts = new Map<string, string>();
  private serverError: string | null = null;

  async onload() {
    await this.loadSettings();
    this.service = new NoteService(new ObsidianVault(this.app), { folder: this.settings.folder });

    this.registerMarkdownCodeBlockProcessor(ANNOTATION_LANG, (source, el, ctx) => {
      const info = ctx.getSectionInfo(el);
      renderCard(source, el, {
        // サイドパネル用の描画（DOM に付いていない要素）では getSectionInfo が取れない
        noteText: info?.text ?? this.renderTexts.get(ctx.sourcePath) ?? null,
        styles: this.styles,
        dark: document.body.classList.contains('theme-dark'),
        onReveal: a => this.reveal(ctx.sourcePath, a),
      });
    });
    this.registerMarkdownCodeBlockProcessor(STYLES_LANG, (source, el) => {
      const { config, error } = styleConfigFromMarkdown('```' + STYLES_LANG + '\n' + source + '\n```');
      renderStylesPreview(config, el, document.body.classList.contains('theme-dark'), error);
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('a08-status');
    this.statusEl.onClickEvent(() => this.openSettings());
    this.registerInterval(window.setInterval(() => this.updateStatus(), 3000));

    this.addSettingTab(new AnnotationSettingTab(this.app, this));
    this.addCommand({
      id: 'restart-server',
      name: '註サーバーを再起動',
      callback: () => void this.restartServer(),
    });
    this.addCommand({
      id: 'copy-token',
      name: '拡張用の接続トークンをコピー',
      callback: () => void this.copyToken(),
    });
    this.addCommand({
      id: 'open-styles',
      name: 'ハイライト設定（_styles.md）を開く',
      callback: async () => {
        await this.service.ensureStylesFile();
        const f = this.app.vault.getAbstractFileByPath(this.service.stylesPath);
        if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
      },
    });
    this.addCommand({
      id: 'reveal-annotation-at-cursor',
      name: 'カーソル位置の註をブラウザで開く',
      editorCheckCallback: (checking, editor, view) => {
        const file = view.file;
        if (!file) return false;
        const line = editor.getCursor().line;
        const a = parseNote(editor.getValue()).annotations.find(x => x.startLine <= line && line <= x.endLine);
        if (!a) return false;
        if (!checking) this.reveal(file.path, a);
        return true;
      },
    });

    this.app.workspace.onLayoutReady(async () => {
      await this.service.ensureStylesFile().catch(e => console.error('[a08]', e));
      await this.reloadStyles();
      await this.service.rebuildIndex();
      this.registerVaultEvents();
      await this.startServer();
    });

    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        this.server?.broadcast('themeChanged', { theme: this.theme() });
      }),
    );
  }

  async onunload() {
    await this.server?.stop();
    this.server = null;
  }

  private registerVaultEvents() {
    const changed = async (path: string) => {
      const r = await this.service.fileChanged(path);
      if (r === 'styles') {
        await this.reloadStyles();
        this.server?.broadcast('stylesChanged', { styles: this.styles });
      } else if (r !== undefined) {
        this.server?.noteChanged(path, r);
      }
    };
    this.registerEvent(this.app.vault.on('modify', f => void changed(f.path)));
    this.registerEvent(this.app.vault.on('create', f => void changed(f.path)));
    this.registerEvent(
      this.app.vault.on('delete', f => {
        this.service.fileDeleted(f.path);
        if (this.service.isNotePath(f.path)) this.server?.noteChanged(f.path, null);
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (f, old) => {
        this.service.fileRenamed(old, f.path);
        if (this.service.isNotePath(old)) this.server?.noteChanged(old, null);
        void changed(f.path);
      }),
    );
  }

  async reloadStyles() {
    this.styles = await this.service.getStyles();
  }

  theme(): ThemeInfo {
    const cs = getComputedStyle(document.body);
    const vars: Record<string, string> = {};
    for (const v of THEME_VARS) {
      const val = cs.getPropertyValue(v).trim();
      if (val) vars[v] = val;
    }
    return { dark: document.body.classList.contains('theme-dark'), vars };
  }

  async render(path: string, content: string): Promise<string> {
    const el = document.createElement('div');
    const comp = new Component();
    comp.load();
    this.renderTexts.set(path, content);
    try {
      // frontmatter はプロパティ表示になるので除く
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)\r?\n/, '');
      await MarkdownRenderer.render(this.app, body, el, path, comp);
      // 埋め込みなどの非同期描画を少し待つ
      await new Promise(r => setTimeout(r, 50));
      // 画像などの vault 内リソースは app:// URL なので、拡張からは見えない。
      // data-href を残しておき、サイドパネル側で扱う
      return el.innerHTML;
    } finally {
      comp.unload();
      this.renderTexts.delete(path);
    }
  }

  reveal(path: string, a: AnnotationData) {
    const note = this.app.vault.getAbstractFileByPath(path);
    const q = a.selector.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
    const url = textFragmentUrl(a.source, quoteOf(a), q?.prefix, q?.suffix);
    if (this.server && this.server.clientCount > 0) {
      void (async () => {
        let uris: string[] = [a.source];
        if (note instanceof TFile) uris = [...new Set([a.source, ...parseNote(await this.app.vault.read(note)).uris])];
        this.server!.broadcast('reveal', { path, id: a.id, uris, source: a.source, url });
      })();
    } else if (a.source) {
      new Notice('ブラウザ拡張が接続されていません。Text Fragment で開きます。');
      window.open(url);
    }
  }

  async openInObsidian(path: string, id?: string) {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) throw new Error(`ノートがありません: ${path}`);
    let line: number | undefined;
    if (id) {
      const a = parseNote(await this.app.vault.read(f)).annotations.find(x => x.id === id);
      line = a?.startLine;
    }
    // 既に開いているタブがあればそれを使う
    let leaf = this.app.workspace.getLeavesOfType('markdown').find(l => (l.view as MarkdownView).file?.path === f.path);
    if (!leaf) leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(f, { active: true, eState: line != null ? { line } : undefined });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (line != null && leaf.view instanceof MarkdownView) {
      const editor = leaf.view.editor;
      editor.setCursor({ line, ch: 0 });
      editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
    }
    window.focus();
  }

  async startServer() {
    if (!this.settings.token) {
      this.settings.token = randomToken();
      await this.saveSettings();
    }
    this.serverError = null;
    const server = new AnnotationServer({
      port: this.settings.port,
      token: this.settings.token,
      service: this.service,
      hooks: {
        vaultName: () => this.app.vault.getName(),
        theme: () => this.theme(),
        render: (p, c) => this.render(p, c),
        openInObsidian: (p, id) => this.openInObsidian(p, id),
        openLink: async (link, sourcePath) => {
          await this.app.workspace.openLinkText(link, sourcePath, false);
          window.focus();
        },
        log: (m, ...a) => console.debug('[a08]', m, ...a),
      },
    });
    try {
      await server.start();
      this.server = server;
    } catch (e) {
      this.serverError = e instanceof Error ? e.message : String(e);
      new Notice(`註サーバーを起動できません（ポート ${this.settings.port}）: ${this.serverError}`);
      console.error('[a08]', e);
    }
    this.updateStatus();
  }

  async restartServer() {
    await this.server?.stop();
    this.server = null;
    this.service.folder = normalizePath(this.settings.folder);
    await this.service.rebuildIndex();
    await this.startServer();
    if (this.server) new Notice('註サーバーを再起動しました');
  }

  async copyToken() {
    await navigator.clipboard.writeText(this.settings.token);
    new Notice('接続トークンをコピーしました。拡張の設定画面に貼り付けてください。');
  }

  private updateStatus() {
    if (!this.statusEl) return;
    if (!this.server) {
      this.statusEl.setText('註: 停止');
      this.statusEl.setAttr('title', this.serverError ?? '');
    } else {
      const n = this.server.clientCount;
      this.statusEl.setText(n ? `註: 接続 ${n}` : '註: 待機中');
      this.statusEl.setAttr('title', `ws://127.0.0.1:${this.settings.port}`);
    }
  }

  private openSettings() {
    const s = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    s?.open();
    s?.openTabById(this.manifest.id);
  }

  async loadSettings() {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class AnnotationSettingTab extends PluginSettingTab {
  plugin: AnnotationPlugin;
  constructor(app: App, plugin: AnnotationPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const p = this.plugin;

    new Setting(containerEl)
      .setName('状態')
      .setDesc(
        p.server
          ? `ws://127.0.0.1:${p.settings.port} で待機中（接続中の拡張: ${p.server.clientCount}）`
          : '停止中',
      )
      .addButton(b => b.setButtonText('再起動').onClick(async () => {
        await p.restartServer();
        this.display();
      }));

    new Setting(containerEl)
      .setName('接続トークン')
      .setDesc('Chrome 拡張の設定画面に貼り付けます。再生成すると拡張側も貼り直しが必要です。')
      .addText(t => {
        t.setValue(p.settings.token).setDisabled(true);
        t.inputEl.style.width = '22em';
        t.inputEl.style.fontFamily = 'var(--font-monospace)';
      })
      .addButton(b => b.setButtonText('コピー').onClick(() => void p.copyToken()))
      .addButton(b =>
        b.setButtonText('再生成').setWarning().onClick(async () => {
          p.settings.token = randomToken();
          await p.saveSettings();
          await p.restartServer();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('ポート')
      .setDesc('変更後は「再起動」を押してください。拡張の設定も合わせます。')
      .addText(t =>
        t.setValue(String(p.settings.port)).onChange(async v => {
          const n = Number(v);
          if (Number.isInteger(n) && n > 1023 && n < 65536) {
            p.settings.port = n;
            await p.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('註ノートのフォルダ')
      .setDesc('変更後は「再起動」を押してください。')
      .addText(t =>
        t.setValue(p.settings.folder).onChange(async v => {
          p.settings.folder = v.trim() || 'annotations';
          await p.saveSettings();
        }),
      );
  }
}
