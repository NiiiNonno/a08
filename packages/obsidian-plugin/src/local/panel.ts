/**
 * 右のサイドバーに、開いているノートの註ノートを表示する（Chrome のサイドパネルにあたるもの）。
 *
 * 註ノートがあれば、そのノートを普通の markdown のタブとして開く（閲覧・編集は Obsidian のまま）。
 * なければ「まだ註がありません」の表示にする。本文のハイライトとは独立して動く。
 */
import { ItemView, MarkdownView, TFile, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { parseNote } from '@a08/core';
import type ObsidiannotPlugin from '../main.ts';
import type { LocalAnnotations } from './manager.ts';

export const EMPTY_VIEW = 'obsidiannot-local-empty';

/** サイドバーの註ノートは常に編集モード（Live Preview）で開く */
const EDIT_STATE = { mode: 'source', source: false };

class EmptyView extends ItemView {
  target: string | null = null;
  getViewType() {
    return EMPTY_VIEW;
  }
  getDisplayText() {
    return '黒曜伝';
  }
  getIcon() {
    return 'message-square-quote';
  }
  async setState(state: unknown, result: ViewStateResult) {
    this.target = (state as { target?: string } | null)?.target ?? null;
    this.draw();
    await super.setState(state, result);
  }
  getState() {
    return { target: this.target };
  }
  async onOpen() {
    this.draw();
  }
  private draw() {
    const el = this.contentEl;
    el.empty();
    el.addClass('obsidiannot-local-empty');
    el.createDiv({ cls: 'obsidiannot-local-empty-title', text: '黒曜伝' });
    if (this.target) {
      el.createDiv({ text: `${this.target.split('/').pop()!.replace(/\.md$/, '')} にはまだ註がありません。` });
      el.createDiv({ cls: 'obsidiannot-local-empty-hint', text: '本文を選ぶと出るボタンから、註・照を付けられます。' });
    } else {
      el.createDiv({ text: 'ノートを開くと、その註がここに表示されます。' });
    }
  }
}

export class LocalPanel {
  leaf: WorkspaceLeaf | null = null;
  private target: string | null = null;

  constructor(
    private plugin: ObsidiannotPlugin,
    private local: LocalAnnotations,
  ) {}

  private get app() {
    return this.plugin.app;
  }

  register() {
    this.plugin.registerView(EMPTY_VIEW, leaf => new EmptyView(leaf));
    this.plugin.addCommand({ id: 'open-local-panel', name: 'サイドバーに註を表示', callback: () => void this.open() });
    this.plugin.addRibbonIcon('message-square-quote', '黒曜伝: サイドバーに註を表示', () => void this.open());
    this.plugin.registerEvent(this.app.workspace.on('active-leaf-change', leaf => void this.onActive(leaf)));
    this.local.onChange = path => {
      if (path === this.target) this.updateBanner();
    };
  }

  /** 前回のレイアウトに残っている自分のタブを使う */
  adopt() {
    const ws = this.app.workspace;
    this.leaf =
      ws.getLeavesOfType(EMPTY_VIEW)[0] ??
      ws
        .getLeavesOfType('markdown')
        .find(l => l.getRoot() === ws.rightSplit && this.local.isNote((l.view as MarkdownView).file?.path ?? '')) ??
      null;
    // 開いているノートに註がなく follow が走らないときも、行番号を消す印は付けておく
    this.markLeaf();
    void this.onActive(ws.getMostRecentLeaf(ws.rootSplit));
  }

  private alive(): boolean {
    const l = this.leaf;
    if (!l) return false;
    const ws = this.app.workspace;
    return [...ws.getLeavesOfType(EMPTY_VIEW), ...ws.getLeavesOfType('markdown')].includes(l);
  }

  async open() {
    if (!this.alive()) {
      this.leaf = this.app.workspace.getRightLeaf(false);
      if (!this.leaf) return;
      await this.leaf.setViewState({ type: EMPTY_VIEW, state: { target: this.target } });
    }
    await this.follow();
    await this.app.workspace.revealLeaf(this.leaf!);
  }

  private async onActive(leaf: WorkspaceLeaf | null) {
    if (!leaf || leaf === this.leaf) return;
    const ws = this.app.workspace;
    if (leaf.getRoot() !== ws.rootSplit) return;
    const file = (leaf.view as { file?: TFile | null }).file;
    if (!file || !this.local.isTarget(file.path)) return;
    this.target = file.path;
    await this.follow();
  }

  /** サイドバーを、今の対象のノートの註ノートに合わせる */
  async follow() {
    if (!this.alive() || !this.leaf) return;
    const target = this.target;
    const note = target ? this.local.notesFor(target)[0] : undefined;
    const view = this.leaf.view;
    if (note) {
      if (!(view instanceof MarkdownView && view.file?.path === note && view.getMode() === 'source')) {
        await this.leaf.setViewState({ type: 'markdown', state: { ...EDIT_STATE, file: note }, active: false });
        // 中のリンクを押したときに、このタブが別のノートに移らないように
        this.leaf.setPinned(true);
      }
      this.markLeaf();
    } else if (!(view instanceof EmptyView) || view.target !== target) {
      await this.leaf.setViewState({ type: EMPTY_VIEW, state: { target }, active: false });
    }
    this.updateBanner();
  }

  /** サイドバーのタブだけに効く CSS（行番号を消すなど）のための印 */
  private markLeaf() {
    const view = this.leaf?.view;
    if (view instanceof MarkdownView) view.containerEl.addClass('obsidiannot-local-leaf');
  }

  /** 註ノートが作られた・変わったとき */
  async notesChanged() {
    await this.follow();
  }

  /** 新しい註のコメントを書けるよう、サイドバーで註ノートを編集モードにする */
  async editComment(notePath: string, id: string) {
    if (!this.alive()) await this.open();
    if (!this.leaf) return;
    await this.leaf.setViewState({ type: 'markdown', state: { ...EDIT_STATE, file: notePath }, active: true });
    this.leaf.setPinned(true);
    this.markLeaf();
    await this.app.workspace.revealLeaf(this.leaf);
    const view = this.leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const ed = view.editor;
    const a = parseNote(ed.getValue()).annotations.find(x => x.id === id);
    if (!a) return;
    // カード（とブロック ID 行）とコメントの間は一行空ける
    const head = a.headEndLine;
    const blankAfterHead = head + 1 <= ed.lastLine() && ed.getLine(head + 1).trim() === '';
    if (!blankAfterHead) ed.replaceRange('\n', { line: head, ch: ed.getLine(head).length });
    let line = head + 2;
    if (a.comment === '') {
      // コメントを書く行を用意する（次の註とは一行空ける）
      if (line > ed.lastLine()) ed.replaceRange('\n', { line: ed.lastLine(), ch: ed.getLine(ed.lastLine()).length });
      else if (ed.getLine(line).trim() !== '') ed.replaceRange('\n\n', { line, ch: 0 });
    }
    line = Math.min(line, ed.lastLine());
    ed.setCursor({ line, ch: ed.getLine(line).length });
    ed.scrollIntoView({ from: { line: a.startLine, ch: 0 }, to: { line, ch: 0 } }, true);
    ed.focus();
  }

  /** ハイライトから、対応するカードを見せる */
  async focusCard(path: string, id: string) {
    if (this.target !== path) {
      this.target = path;
    }
    if (!this.alive()) await this.open();
    else await this.follow();
    const leaf = this.leaf;
    if (!leaf) return;
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const card = view.containerEl.querySelector<HTMLElement>(`.obsidiannot-card[data-annotation-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.addClass('is-flash');
      window.setTimeout(() => card.removeClass('is-flash'), 1600);
      return;
    }
    // 編集モードで画面外のカードは描かれていないので、行へ移動する
    const a = parseNote(view.getViewData()).annotations.find(x => x.id === id);
    if (a) view.setEphemeralState({ line: a.startLine });
  }

  private updateBanner() {
    const leaf = this.leaf;
    if (!leaf || !this.alive()) return;
    const container = leaf.view.containerEl;
    container.querySelector('.obsidiannot-local-banner')?.remove();
    if (!this.target || !(leaf.view instanceof MarkdownView)) return;
    const { orphan, tentative } = this.local.problems(this.target);
    if (!orphan.length && !tentative.length) return;
    const banner = createDiv({ cls: 'obsidiannot-local-banner' });
    const item = (label: string, ids: string[]) => {
      if (!ids.length) return;
      const b = banner.createEl('button', { text: `${label} ${ids.length} 件` });
      let i = 0;
      b.addEventListener('click', () => {
        void this.focusCard(this.target!, ids[i % ids.length]);
        i++;
      });
    };
    item('見つからない註', orphan.map(a => a.id));
    item('推定', tentative.map(a => a.id));
    const header = container.querySelector('.view-header');
    if (header) header.after(banner);
    else container.prepend(banner);
  }
}
