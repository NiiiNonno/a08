import {
  Component,
  FileSystemAdapter,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  getLinkpath,
  normalizePath,
  setIcon,
  type App,
} from 'obsidian';
import {
  ANNOTATION_LANG,
  DEFAULT_PORT,
  DEFAULT_STYLES,
  DEFAULT_STYLES_YAML,
  parseNote,
  parseStyleConfig,
  quoteOf,
  textFragmentUrl,
  type AnnotationData,
  type Appearance,
  type StyleConfig,
  type TextQuoteSelector,
  type ThemeInfo,
} from '@a08/core';
import { AnnotationServer, NoteService, contentVersion } from '@a08/server';
import { ObsidianVault } from './obsidian-vault.ts';
import { isLocalSource, renderCard, renderStylesPreview, restyleCards } from './card.ts';
import { collectAppearance } from './appearance.ts';
import { LocalAnnotations } from './local/manager.ts';
import { LocalPanel } from './local/panel.ts';
import { SelectionAdder } from './local/adder.ts';
import { localEditorExtension } from './local/editor.ts';
import { isPdfView } from './local/pdf.ts';
import { buildLocalCss } from './local/styles.ts';

type Settings = {
  port: number;
  token: string;
  folder: string;
  /** タグ別ハイライトの設定（YAML） */
  stylesYaml: string;
  /** 註カードに引用の前後の文脈を出す */
  showContext: boolean;
  /** vault 内のノートへの註ノートの名前に付ける末尾（「ノート名 - local」） */
  localSuffix: string;
};

const DEFAULTS: Settings = {
  port: DEFAULT_PORT,
  token: '',
  folder: 'obsidiannot',
  stylesYaml: DEFAULT_STYLES_YAML,
  showContext: false,
  localSuffix: ' - local',
};

/** サイドパネルの枠（ヘッダーなど）に使う Obsidian の CSS 変数 */
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
  '--radius-s',
  '--radius-m',
  '--color-accent',
  '--color-red',
  '--color-green',
  '--color-blue',
  '--color-yellow',
];

const LOG = '[obsidiannot]';

function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export default class ObsidiannotPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  service!: NoteService;
  server: AnnotationServer | null = null;
  styles: StyleConfig = DEFAULT_STYLES;
  stylesError: string | undefined;
  private statusEl: HTMLElement | null = null;
  /** render() 中のノート本文（コードブロック処理からタグを引くため） */
  private renderTexts = new Map<string, string>();
  private serverError: string | null = null;
  private appearanceCache: Appearance | null = null;
  local!: LocalAnnotations;
  localPanel!: LocalPanel;
  private adder!: SelectionAdder;
  private localStyleEl: HTMLStyleElement | null = null;

  async onload() {
    await this.loadSettings();
    this.service = new NoteService(new ObsidianVault(this.app), { folder: this.settings.folder });
    this.local = new LocalAnnotations(this);
    this.localPanel = new LocalPanel(this, this.local);
    this.adder = new SelectionAdder(this, this.local);
    this.applyStylesYaml();
    this.setupLocal();

    this.registerMarkdownCodeBlockProcessor(ANNOTATION_LANG, (source, el, ctx) => {
      const info = ctx.getSectionInfo(el);
      renderCard(source, el, {
        // サイドパネル用の描画（DOM に付いていない要素）では getSectionInfo が取れない
        noteText: info?.text ?? this.renderTexts.get(ctx.sourcePath) ?? null,
        styles: this.styles,
        dark: document.body.classList.contains('theme-dark'),
        showContext: this.settings.showContext,
        onReveal: a => this.reveal(ctx.sourcePath, a),
        decorate: (card, a) => {
          if (isLocalSource(a.source)) this.local.decorateCard(card, ctx.sourcePath, String(a.id));
        },
      });
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('obsidiannot-status');
    this.statusEl.onClickEvent(() => this.openSettings());
    this.registerInterval(window.setInterval(() => this.updateStatus(), 3000));
    // アクセントカラーなど、body のインライン style の変更を拡張に伝える
    let lastInline = '';
    this.registerInterval(
      window.setInterval(() => {
        const inline = `${document.documentElement.style.cssText}\n${document.body.style.cssText}`;
        if (inline === lastInline) return;
        const first = lastInline === '';
        lastInline = inline;
        if (!first && this.server) {
          this.appearanceCache = null;
          this.server.broadcast('themeChanged', { theme: this.theme() });
        }
      }, 2000),
    );

    this.addSettingTab(new ObsidiannotSettingTab(this.app, this));
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
      await this.service.rebuildIndex();
      this.registerVaultEvents();
      this.localPanel.adopt();
      this.local.pdf.attachAll();
      await this.startServer();
    });

    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        this.appearanceCache = null;
        this.server?.broadcast('themeChanged', { theme: this.theme() });
      }),
    );
  }

  async onunload() {
    this.localStyleEl?.remove();
    for (const name of Array.from(CSS.highlights?.keys() ?? [])) if (name.startsWith('obsidiannot-')) CSS.highlights.delete(name);
    await this.server?.stop();
    this.server = null;
  }

  /** vault 内のノートへの註（ハイライト・サイドバー・選択時のボタン） */
  private setupLocal() {
    const local = this.local;
    this.registerEditorExtension(
      localEditorExtension({
        attached: (view, path) => local.editorAttached(view, path),
        idle: (view, path) => local.editorIdle(view, path),
        hasOrphans: path => local.problems(path).orphan.length > 0,
        clicked: (path, id) => void this.localPanel.focusCard(path, id),
      }),
    );
    this.registerMarkdownPostProcessor((el, ctx) => local.onSection(el, ctx));
    this.localPanel.register();
    this.adder.register();
    // 閲覧表示でハイライトを押したら、対応するカードを見せる
    this.registerDomEvent(document, 'click', ev => {
      const t = ev.target as HTMLElement | null;
      if (!t?.closest?.('.markdown-preview-view .obsidiannot-section')) return;
      if (!document.getSelection()?.isCollapsed) return;
      const hit = local.annotationAtPoint(ev.clientX, ev.clientY, document);
      if (hit) void this.localPanel.focusCard(hit.path, hit.id);
    });
    const run = (kind: 'chu' | 'sho') => (checking: boolean) => {
      const r = this.adder.selection();
      if (!r) return false;
      if (!checking) void local.create(kind, r);
      return true;
    };
    this.addCommand({ id: 'annotate-selection', name: '選択範囲に註を付ける', checkCallback: run('chu') });
    this.addCommand({ id: 'shine-selection', name: '選択範囲を照らす（リンクをコピー）', checkCallback: run('sho') });
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, _editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        const r = local.selectionIn(view);
        if (!r) return;
        menu.addItem(i => i.setTitle('註を付ける').setIcon('message-square-quote').onClick(() => void local.create('chu', r)));
        menu.addItem(i => i.setTitle('照らす（リンクをコピー）').setIcon('star').onClick(() => void local.create('sho', r)));
      }),
    );
    this.registerEvent(this.app.workspace.on('layout-change', () => local.prune()));
    // PDF のビュー: ページが描かれたらハイライトを描き、ハイライトを押したらカードを見せる
    this.registerEvent(this.app.workspace.on('file-open', () => local.pdf.attachAll()));
    this.register(() => local.pdf.destroy());
    this.registerDomEvent(document, 'click', ev => {
      const t = ev.target as HTMLElement | null;
      if (!t?.closest?.('.pdf-container, .pdf-viewer-container, .pdfViewer')) return;
      if (!document.getSelection()?.isCollapsed) return;
      const leaf = this.app.workspace.getLeavesOfType('pdf').find(l => l.view.containerEl.contains(t));
      if (!leaf || !isPdfView(leaf.view)) return;
      const hit = local.pdfAnnotationAt(leaf.view, ev.clientX, ev.clientY);
      if (!hit) return;
      // 押したハイライトの註ノートのブロックへのリンクをコピーし、カードを見せる
      void local.copyNoteLink(hit.path, hit.id).catch(e => new Notice(`リンクをコピーできません: ${e instanceof Error ? e.message : e}`));
      void this.localPanel.focusCard(hit.path, hit.id);
    });
    // 註ノートでコメントのタグを書き換えたら、カードの色・タグもすぐ変える（保存を待たない）
    let restyleTimer: number | undefined;
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, info) => {
        const path = info.file?.path;
        if (!path || !this.service.isNotePath(path)) return;
        window.clearTimeout(restyleTimer);
        restyleTimer = window.setTimeout(() => this.restyleCards(path, editor.getValue()), 300);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', file => {
        if (this.service.isNotePath(file.path)) {
          local.invalidateLinks();
          void this.localPanel.notesChanged();
        }
      }),
    );
  }

  private registerVaultEvents() {
    const changed = async (path: string) => {
      if (this.service.isNotePath(path)) {
        this.local.noteModified(path);
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) this.restyleCards(path, await this.app.vault.cachedRead(f));
      } else if (path.endsWith('.md') || path.toLowerCase().endsWith('.pdf')) this.local.fileModified(path);
      const r = await this.service.fileChanged(path);
      if (r !== undefined) this.server?.noteChanged(path, r);
    };
    this.registerEvent(this.app.vault.on('modify', f => void changed(f.path)));
    this.registerEvent(this.app.vault.on('create', f => void changed(f.path)));
    this.registerEvent(
      this.app.vault.on('delete', f => {
        this.service.fileDeleted(f.path);
        this.local.invalidateLinks();
        if (this.service.isNotePath(f.path)) this.server?.noteChanged(f.path, null);
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (f, old) => {
        this.service.fileRenamed(old, f.path);
        this.local.invalidateLinks();
        if (this.service.isNotePath(old)) this.server?.noteChanged(old, null);
        void changed(f.path);
      }),
    );
  }

  /** settings.stylesYaml を読み直す。壊れていれば既定値 */
  applyStylesYaml() {
    const { config, error } = parseStyleConfig(this.settings.stylesYaml || DEFAULT_STYLES_YAML);
    this.styles = config;
    this.stylesError = error;
    this.localStyleEl ??= document.head.createEl('style', { attr: { id: 'obsidiannot-local-styles' } });
    this.localStyleEl.textContent = buildLocalCss(config);
  }

  /** 註ノートを開いているビューのカードの色・タグを、ノートの本文に合わせる */
  restyleCards(path: string, text: string) {
    const dark = document.body.classList.contains('theme-dark');
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file?.path === path) restyleCards(v.containerEl, text, this.styles, dark);
    }
  }

  /** スタイル・表示設定の変更を反映する */
  refreshViews(stylesChanged: boolean) {
    if (stylesChanged) {
      this.server?.broadcast('stylesChanged', { styles: this.styles });
      this.local.reloadAll();
    }
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (v instanceof MarkdownView) v.previewMode.rerender(true);
    }
    this.app.workspace.updateOptions();
  }

  theme(): ThemeInfo {
    // アクセントカラーの変更は css-change が来ないことがあるので、インライン style の変化で取り直す
    const inline = `${document.documentElement.style.cssText}\n${document.body.style.cssText}`;
    if (this.appearanceCache && inline !== `${this.appearanceCache.rootStyle}\n${this.appearanceCache.bodyStyle}`) {
      this.appearanceCache = null;
    }
    const cs = getComputedStyle(document.body);
    const vars: Record<string, string> = {};
    for (const v of THEME_VARS) {
      const val = cs.getPropertyValue(v).trim();
      if (val) vars[v] = val;
    }
    return {
      dark: document.body.classList.contains('theme-dark'),
      vars,
      cssVersion: this.appearance().version,
    };
  }

  appearance(): Appearance {
    if (!this.appearanceCache) {
      const a = collectAppearance(document);
      this.appearanceCache = {
        ...a,
        version: contentVersion(`${a.bodyClass}\n${a.rootStyle}\n${a.bodyStyle}\n${a.css}`),
      };
    }
    return this.appearanceCache;
  }

  async render(path: string, content: string): Promise<string> {
    // 画面に付いていない要素では、コールアウトのアイコンなど一部が描かれないので、
    // 見えない場所に置いた要素に描く
    const host = document.body.createDiv({ cls: 'obsidiannot-offscreen markdown-preview-view markdown-rendered' });
    const el = host.createDiv();
    const comp = new Component();
    comp.load();
    this.renderTexts.set(path, content);
    try {
      // frontmatter はプロパティ表示になるので除く
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)\r?\n/, '');
      await MarkdownRenderer.render(this.app, body, el, path, comp);
      // 埋め込みなどの非同期描画を待つ（最大 0.5 秒）
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (!el.querySelector('.internal-embed:not(.is-loaded)')) break;
      }
      this.fillCalloutIcons(el);
      this.markResources(el, path);
      return el.innerHTML;
    } finally {
      comp.unload();
      host.remove();
      this.renderTexts.delete(path);
    }
  }

  /** アイコンが空のコールアウトに、種類ごとのアイコン（CSS 変数 --callout-icon）を入れる */
  private fillCalloutIcons(el: HTMLElement) {
    for (const iconEl of Array.from(el.querySelectorAll<HTMLElement>('.callout-icon'))) {
      if (iconEl.querySelector('svg')) continue;
      const callout = iconEl.closest<HTMLElement>('.callout');
      const name = callout ? getComputedStyle(callout).getPropertyValue('--callout-icon').trim() : '';
      setIcon(iconEl, name || 'lucide-pencil');
    }
  }

  /**
   * vault 内の画像は app:// URL なので拡張からは読めない。
   * vault 相対パスを data-obsidiannot-resource に入れておき、サイドパネルが getResource で取る。
   */
  private markResources(el: HTMLElement, sourcePath: string) {
    const adapter = this.app.vault.adapter;
    const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath().replace(/\\/g, '/').replace(/^\/+/, '') : null;
    for (const img of Array.from(el.querySelectorAll('img'))) {
      const src = img.getAttribute('src') ?? '';
      if (/^(https?:|data:|blob:)/i.test(src)) continue;
      let path: string | null = null;
      const embed = img.closest('.internal-embed')?.getAttribute('src');
      if (embed) {
        const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(embed.split('|')[0]), sourcePath);
        if (dest) path = dest.path;
      }
      if (!path && base && src.startsWith('app:')) {
        try {
          const abs = decodeURIComponent(new URL(src).pathname).replace(/^\/+/, '');
          if (abs.startsWith(`${base}/`)) path = abs.slice(base.length + 1);
        } catch {
          /* ignore */
        }
      }
      if (path) {
        img.setAttribute('data-obsidiannot-resource', path);
        img.removeAttribute('src');
      }
    }
  }

  /** ブロックへの内部リンク。ユーザーのリンク形式の設定（wikilink / markdown）に従う */
  linkTo(path: string, blockId: string): string {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) return this.app.fileManager.generateMarkdownLink(f, '', `#^${blockId}`);
    return `[[${path.split('/').pop()!.replace(/\.md$/, '')}#^${blockId}]]`;
  }

  reveal(path: string, a: AnnotationData) {
    if (isLocalSource(a.source)) {
      void this.local.reveal(path, String(a.id));
      return;
    }
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
        styles: () => this.styles,
        linkTo: (p, id) => this.linkTo(p, id),
        appearance: () => this.appearance(),
        render: (p, c) => this.render(p, c),
        openInObsidian: (p, id) => this.openInObsidian(p, id),
        openLink: async (link, sourcePath) => {
          await this.app.workspace.openLinkText(link, sourcePath, false);
          window.focus();
        },
        log: (m, ...a) => console.debug(LOG, m, ...a),
      },
    });
    try {
      await server.start();
      this.server = server;
    } catch (e) {
      this.serverError = e instanceof Error ? e.message : String(e);
      new Notice(`註サーバーを起動できません（ポート ${this.settings.port}）: ${this.serverError}`);
      console.error(LOG, e);
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
      this.statusEl.setAttr('title', `Obsidiannot — ws://127.0.0.1:${this.settings.port}`);
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

class ObsidiannotSettingTab extends PluginSettingTab {
  plugin: ObsidiannotPlugin;
  constructor(app: App, plugin: ObsidiannotPlugin) {
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
          p.settings.folder = v.trim() || DEFAULTS.folder;
          await p.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('vault 内のノートへの註ノートの名前')
      .setDesc('註ノートの名前を「対象のノート名＋この文字列」にします（同じ名前だとリンクが註ノート自身を指してしまうため）。既にある註ノートの名前は変わりません。')
      .addText(t =>
        t.setPlaceholder(DEFAULTS.localSuffix).setValue(p.settings.localSuffix).onChange(async v => {
          // 空だと対象と同じ名前になるので、既定値に戻す
          p.settings.localSuffix = v.trim() ? v : DEFAULTS.localSuffix;
          await p.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('引用の前後の文脈を表示')
      .setDesc('註カードで、引用の前後の文字列を薄く表示します。')
      .addToggle(t =>
        t.setValue(p.settings.showContext).onChange(async v => {
          p.settings.showContext = v;
          await p.saveSettings();
          p.refreshViews(false);
        }),
      );

    new Setting(containerEl).setName('ハイライトのスタイル').setHeading();
    const desc = containerEl.createDiv({ cls: 'setting-item-description' });
    desc.setText(
      'コメントに書いた #タグ ごとに、ブラウザでのハイライトの見た目を YAML で指定します。上にあるタグほど優先されます。入力をやめると、開いているページにすぐ反映されます。',
    );
    const editor = containerEl.createDiv({ cls: 'obsidiannot-styles-editor' });
    const ta = editor.createEl('textarea', { attr: { spellcheck: 'false' } });
    ta.value = p.settings.stylesYaml;
    const preview = containerEl.createDiv();
    const drawPreview = () => {
      preview.empty();
      renderStylesPreview(p.styles, preview, document.body.classList.contains('theme-dark'), p.stylesError);
    };
    drawPreview();
    let timer: number | undefined;
    ta.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        p.settings.stylesYaml = ta.value;
        p.applyStylesYaml();
        await p.saveSettings();
        drawPreview();
        p.refreshViews(true);
      }, 600);
    });
    new Setting(containerEl).addButton(b =>
      b.setButtonText('既定に戻す').onClick(async () => {
        p.settings.stylesYaml = DEFAULT_STYLES_YAML;
        ta.value = DEFAULT_STYLES_YAML;
        p.applyStylesYaml();
        await p.saveSettings();
        drawPreview();
        p.refreshViews(true);
      }),
    );
  }
}
