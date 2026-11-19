/**
 * vault 内のノート（ローカルのマークダウン）への註。
 *
 * - 註ノートは Web と同じく註フォルダに置き、`uris:` に対象のノートを `"[[path/to/note]]"` で書く
 *   （プロパティ内のリンクは、名前の変更時に Obsidian が書き換える）
 * - 位置は元のマークダウンでの引用文・前後の文脈・文字位置で記録する（@a08/core の anchor.ts）
 * - 編集表示は CodeMirror の装飾（editor.ts）、閲覧表示は CSS Custom Highlight API で描く
 */
import {
  MarkdownView,
  Notice,
  TFile,
  normalizePath,
  type MarkdownPostProcessorContext,
  type WorkspaceLeaf,
} from 'obsidian';
import type { EditorView } from '@codemirror/view';
import {
  align,
  anchorQuote,
  highlightName,
  mapRange,
  metaFromFrontmatter,
  parseNote,
  quoteAnchorOf,
  selectorsForRange,
  styleIndicesForTags,
  updateAnnotations,
  type Alignment,
  type AnchorStatus,
  type QuoteAnchor,
  type Selector,
  type TextQuoteSelector,
} from '@a08/core';
import type ObsidiannotPlugin from '../main.ts';
import { annoField, editorPath, setAnnos, setFlash, type EditorAnno } from './editor.ts';
import { FOCUS_HIGHLIGHT, TENTATIVE_HIGHLIGHT, styleKey } from './styles.ts';

export type Anno = {
  id: string;
  notePath: string;
  /** 保存されている引用文・文脈・位置 */
  quote: QuoteAnchor;
  /** 書き換えられる前の引用文（あれば） */
  original?: string;
  styleKey: string;
  start: number;
  end: number;
  status: AnchorStatus;
};

type Model = {
  path: string;
  notePaths: string[];
  annos: Anno[];
  /** annos の位置の基になった本文 */
  text: string;
  /** 閲覧表示の本文が text と違うとき用 */
  alt?: { text: string; annos: Anno[] };
};

/** 本文上の範囲（選択範囲など） */
export type SourceRange = { path: string; start: number; end: number; text: string };

const WRITE_DELAY = 3000;
const FLASH_MS = 1600;

export class LocalAnnotations {
  private models = new Map<string, Model>();
  private loading = new Map<string, Promise<Model | null>>();
  private linkIndex: Map<string, string[]> | null = null;
  /** 作ったばかりで metadataCache に載っていない対応 */
  private pendingLinks = new Map<string, string>();
  private sectionCtx = new WeakMap<HTMLElement, MarkdownPostProcessorContext>();
  private sectionRanges = new Map<HTMLElement, Array<{ id: string; name: string; range: Range }>>();
  private alignCache = new WeakMap<HTMLElement, { src: string; dst: string; al: Alignment }>();
  private lineCache: { text: string; offs: number[] } | null = null;
  private writeTimers = new Map<string, number>();
  private lastSelection: SourceRange | null = null;
  /** 註の状態が変わった（サイドバーの表示を更新するため） */
  onChange: (path: string) => void = () => undefined;

  constructor(private plugin: ObsidiannotPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  isNote(path: string): boolean {
    return this.plugin.service.isNotePath(path);
  }

  /** 註を付けられるノートか */
  isTarget(path: string | null | undefined): path is string {
    return !!path && path.endsWith('.md') && !this.isNote(path);
  }

  // ---- 註ノートと対象の対応 ----

  invalidateLinks() {
    this.linkIndex = null;
  }

  private resolveUri(uri: string, notePath: string): string | null {
    const m = uri.match(/^\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/);
    const linkpath = m ? m[1].trim() : /^[a-z][a-z0-9+.-]*:/i.test(uri.trim()) ? null : uri.trim();
    if (!linkpath) return null;
    const f =
      this.app.metadataCache.getFirstLinkpathDest(linkpath, notePath) ??
      this.app.vault.getAbstractFileByPath(normalizePath(linkpath));
    return f instanceof TFile ? f.path : null;
  }

  private buildLinkIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.isNote(f.path)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm) continue;
      for (const uri of metaFromFrontmatter(fm).uris) {
        const target = this.resolveUri(uri, f.path);
        if (!target) continue;
        const list = index.get(target) ?? [];
        if (!list.includes(f.path)) list.push(f.path);
        index.set(target, list);
      }
    }
    return index;
  }

  /** 対象のノートに対応する註ノート */
  notesFor(path: string): string[] {
    this.linkIndex ??= this.buildLinkIndex();
    const list = [...(this.linkIndex.get(path) ?? [])];
    const pending = this.pendingLinks.get(path);
    if (pending && !list.includes(pending) && this.app.vault.getAbstractFileByPath(pending)) list.push(pending);
    return list;
  }

  /** 註ノートが対象としているノート */
  targetsOf(notePath: string): string[] {
    this.linkIndex ??= this.buildLinkIndex();
    const out: string[] = [];
    for (const [t, notes] of this.linkIndex) if (notes.includes(notePath)) out.push(t);
    for (const [t, n] of this.pendingLinks) if (n === notePath && !out.includes(t)) out.push(t);
    return out;
  }

  // ---- 読み込みと位置探し ----

  model(path: string): Model | undefined {
    return this.models.get(path);
  }

  private views(path: string): MarkdownView[] {
    return this.app.workspace
      .getLeavesOfType('markdown')
      .map(l => l.view)
      .filter((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === path);
  }

  private editorsOf(path: string): EditorView[] {
    const out: EditorView[] = [];
    for (const v of this.views(path)) {
      const cm = (v.editor as unknown as { cm?: EditorView }).cm;
      if (cm && editorPath(cm) === path) out.push(cm);
    }
    return out;
  }

  /** 開いているビューの本文（未保存の変更を含む）。なければ null */
  private openText(path: string): string | null {
    const cm = this.editorsOf(path)[0];
    if (cm) return cm.state.doc.toString();
    const v = this.views(path)[0];
    return v ? v.getViewData() : null;
  }

  /** 対象のノートの註を読み込み直す */
  load(path: string, text?: string): Promise<Model | null> {
    const run = this.doLoad(path, text).finally(() => {
      if (this.loading.get(path) === run) this.loading.delete(path);
    });
    this.loading.set(path, run);
    return run;
  }

  private ensure(path: string): Promise<Model | null> {
    return this.models.has(path) ? Promise.resolve(this.models.get(path)!) : (this.loading.get(path) ?? this.load(path));
  }

  private async doLoad(path: string, textIn?: string): Promise<Model | null> {
    if (!this.isTarget(path)) return null;
    const notePaths = this.notesFor(path);
    const annos: Anno[] = [];
    for (const np of notePaths) {
      const f = this.app.vault.getAbstractFileByPath(np);
      if (!(f instanceof TFile)) continue;
      const parsed = parseNote(await this.app.vault.cachedRead(f));
      for (const a of parsed.annotations) {
        const quote = quoteAnchorOf(a.selector);
        if (!quote) continue;
        const idx = styleIndicesForTags(this.plugin.styles, a.tags);
        annos.push({
          id: a.id,
          notePath: np,
          quote,
          original: typeof a.original === 'string' ? a.original : undefined,
          styleKey: styleKey(idx[0]),
          start: -1,
          end: -1,
          status: 'orphan',
        });
      }
    }
    let text = textIn ?? this.openText(path);
    if (text == null) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return null;
      text = await this.app.vault.cachedRead(f);
    }
    // 開いている間に本文が変わっていれば、そちらに合わせる
    const now = this.openText(path);
    if (now != null) text = now;
    const model: Model = { path, notePaths, annos, text };
    this.anchorAll(model.annos, text, this.hintsFor(path));
    this.models.set(path, model);
    this.publish(model);
    return model;
  }

  /** 位置の手がかり（エディタ内で追跡している位置か、前回の位置） */
  private hintsFor(path: string): Map<string, { from: number; to: number }> {
    const hints = new Map<string, { from: number; to: number }>();
    const prev = this.models.get(path);
    if (prev) for (const a of prev.annos) if (a.status !== 'orphan') hints.set(a.id, { from: a.start, to: a.end });
    const cm = this.editorsOf(path)[0];
    if (cm) for (const a of cm.state.field(annoField).annos) if (a.status !== 'orphan') hints.set(a.id, { from: a.from, to: a.to });
    return hints;
  }

  private anchorAll(annos: Anno[], text: string, hints: Map<string, { from: number; to: number }>) {
    for (const a of annos) {
      const h = hints.get(a.id);
      if (h && h.to > h.from && text.slice(h.from, h.to) === a.quote.exact) {
        a.start = h.from;
        a.end = h.to;
        a.status = 'ok';
        continue;
      }
      const r = anchorQuote(text, { ...a.quote, start: h?.from ?? a.quote.start });
      if (r.status === 'orphan') {
        a.status = 'orphan';
        a.start = a.end = -1;
      } else {
        a.status = r.status;
        a.start = r.start;
        a.end = r.end;
      }
    }
  }

  // ---- 表示の更新 ----

  private editorAnnos(model: Model): EditorAnno[] {
    return model.annos
      .filter(a => a.status !== 'orphan')
      .map(a => ({ id: a.id, from: a.start, to: a.end, status: a.status, styleKey: a.styleKey }));
  }

  private publish(model: Model) {
    for (const cm of this.editorsOf(model.path)) {
      if (cm.state.doc.length === model.text.length && cm.state.doc.toString() === model.text) {
        cm.dispatch({ effects: setAnnos.of(this.editorAnnos(model)) });
      } else {
        // 本文が先に進んでいる（読み込み中に打鍵があった）
        this.anchorAll(model.annos, cm.state.doc.toString(), this.hintsFor(model.path));
        model.text = cm.state.doc.toString();
        cm.dispatch({ effects: setAnnos.of(this.editorAnnos(model)) });
      }
    }
    this.rehighlightReading(model.path);
    this.redecorateCards(model.notePaths);
    this.onChange(model.path);
  }

  /** エディタができたとき */
  editorAttached(view: EditorView, path: string) {
    if (!this.isTarget(path)) return;
    const m = this.models.get(path);
    if (m && view.state.doc.toString() === m.text) view.dispatch({ effects: setAnnos.of(this.editorAnnos(m)) });
    else void this.load(path, view.state.doc.toString());
  }

  /** 打鍵が止まったとき: 確認が必要な註だけ確かめる */
  editorIdle(view: EditorView, path: string) {
    const model = this.models.get(path);
    if (!model) return;
    const text = view.state.doc.toString();
    const tracked = new Map(view.state.field(annoField).annos.map(a => [a.id, a]));
    let touched = false;
    for (const a of model.annos) {
      const e = tracked.get(a.id);
      if (!e) {
        // 見つからない註は探し直す（誤って消した文を戻したとき・貼り直したときに戻る）
        if (a.status === 'orphan' && this.recover(a, text)) touched = true;
        continue;
      }
      if (!e.dirty) {
        a.start = e.from;
        a.end = e.to;
        continue;
      }
      touched = true;
      if (e.to > e.from && text.slice(e.from, e.to) === a.quote.exact) {
        a.start = e.from;
        a.end = e.to;
        if (a.status !== 'tentative') a.status = 'ok';
        continue;
      }
      const r = anchorQuote(text, { ...a.quote, start: e.from });
      if (r.status === 'ok' || r.status === 'changed') {
        a.status = r.status;
        a.start = r.start;
        a.end = r.end;
      } else if (e.to > e.from) {
        // 引用文も前後も大きく書き換えられたが、編集の追跡で範囲はわかっている
        a.status = 'tentative';
        a.start = e.from;
        a.end = e.to;
      } else if (r.status === 'tentative') {
        a.status = 'tentative';
        a.start = r.start;
        a.end = r.end;
      } else {
        a.status = 'orphan';
        a.start = a.end = -1;
      }
    }
    model.text = text;
    model.alt = undefined;
    const annos = this.editorAnnos(model);
    for (const cm of this.editorsOf(path)) cm.dispatch({ effects: setAnnos.of(annos) });
    this.redecorateCards(model.notePaths);
    this.onChange(path);
    if (touched) this.scheduleWrite(path);
  }

  /**
   * 見つからない註を、今の本文で探し直す。引用文と前後の文脈で確かに見つかったとき（ok / changed）だけ戻す。
   * 推定（tentative）では戻さない: 打鍵の途中の文に、似ているだけの位置を当ててしまうため。
   */
  private recover(a: Anno, text: string): boolean {
    const r = anchorQuote(text, a.quote);
    if (r.status !== 'ok' && r.status !== 'changed') return false;
    a.status = r.status;
    a.start = r.start;
    a.end = r.end;
    return true;
  }

  /** 対象のノートがエディタの外で変わったとき */
  fileModified(path: string) {
    if (!this.models.has(path)) return;
    // エディタで開いていれば、エディタ側で追跡している
    if (this.editorsOf(path).length) return;
    void this.load(path);
  }

  /** 註ノートが変わったとき */
  noteModified(notePath: string) {
    this.invalidateLinks();
    for (const [path, m] of this.models) {
      if (m.notePaths.includes(notePath) || this.notesFor(path).includes(notePath)) void this.load(path);
    }
  }

  /** タグのスタイルが変わったときなど */
  reloadAll() {
    for (const p of [...this.models.keys()]) void this.load(p);
  }

  /** 開いていないノートのモデルを捨てる */
  prune() {
    const open = new Set(
      this.app.workspace
        .getLeavesOfType('markdown')
        .map(l => (l.view as MarkdownView).file?.path)
        .filter(Boolean),
    );
    for (const p of this.models.keys()) if (!open.has(p)) this.models.delete(p);
    for (const el of this.sectionRanges.keys()) if (!el.isConnected) this.clearSection(el);
  }

  // ---- 書き戻し ----

  private scheduleWrite(path: string) {
    window.clearTimeout(this.writeTimers.get(path));
    this.writeTimers.set(
      path,
      window.setTimeout(() => void this.writeBack(path), WRITE_DELAY),
    );
  }

  /** 位置・文脈が変わった註を、註ノートに書き戻す（推定・見つからないものは書かない） */
  private async writeBack(path: string) {
    this.writeTimers.delete(path);
    const model = this.models.get(path);
    if (!model) return;
    // 註ノートを編集中なら後にする
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file && model.notePaths.includes(active.file.path) && active.getMode() === 'source') {
      this.scheduleWrite(path);
      return;
    }
    const byNote = new Map<string, Map<string, { selector: Selector[]; original?: string }>>();
    for (const a of model.annos) {
      if (a.status !== 'ok' && a.status !== 'changed') continue;
      const sel = selectorsForRange(model.text, a.start, a.end);
      const q = sel[0] as TextQuoteSelector;
      if (q.exact === a.quote.exact && q.prefix === a.quote.prefix && q.suffix === a.quote.suffix && a.start === a.quote.start) continue;
      // 位置だけずれたものは、ほかの変更があるときに一緒に書く
      const onlyMoved = q.exact === a.quote.exact && q.prefix === a.quote.prefix && q.suffix === a.quote.suffix;
      const m = byNote.get(a.notePath) ?? new Map();
      m.set(a.id, {
        selector: sel,
        original: q.exact !== a.quote.exact && a.original == null ? a.quote.exact : undefined,
        ...(onlyMoved ? { onlyMoved: true } : {}),
      });
      byNote.set(a.notePath, m);
    }
    for (const [notePath, updates] of byNote) {
      if ([...updates.values()].every(u => (u as { onlyMoved?: boolean }).onlyMoved)) continue;
      await this.writeSelectors(notePath, updates);
    }
  }

  private async writeSelectors(notePath: string, updates: Map<string, { selector: Selector[]; original?: string }>) {
    const f = this.app.vault.getAbstractFileByPath(notePath);
    if (!(f instanceof TFile)) return;
    await this.app.vault.process(f, content =>
      updateAnnotations(content, a => {
        const u = updates.get(a.id);
        if (!u) return null;
        const others = a.selector.filter(s => s.type !== 'TextQuoteSelector' && s.type !== 'TextPositionSelector');
        return { ...a, selector: [...u.selector, ...others], ...(u.original != null ? { original: u.original } : {}) };
      }).text,
    );
  }

  // ---- 閲覧表示 ----

  /** 閲覧表示のかたまりが描かれたとき（registerMarkdownPostProcessor から） */
  onSection(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    if (!this.isTarget(ctx.sourcePath)) return;
    // サイドバー用の描画など、本文の一部でないものは getSectionInfo が取れない
    if (!ctx.getSectionInfo(el)) return;
    this.sectionCtx.set(el, ctx);
    el.addClass('obsidiannot-section');
    if (this.models.has(ctx.sourcePath)) this.highlightSection(el);
    else void this.ensure(ctx.sourcePath).then(() => this.highlightSection(el));
  }

  private highlights(): HighlightRegistry | null {
    return typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
  }

  private highlightFor(name: string): Highlight | null {
    const reg = this.highlights();
    if (!reg) return null;
    let h = reg.get(name);
    if (!h) {
      h = new Highlight();
      reg.set(name, h);
    }
    return h;
  }

  private clearSection(el: HTMLElement) {
    const list = this.sectionRanges.get(el);
    if (!list) return;
    for (const r of list) this.highlights()?.get(r.name)?.delete(r.range);
    this.sectionRanges.delete(el);
  }

  private lineOffsets(text: string): number[] {
    if (this.lineCache?.text === text) return this.lineCache.offs;
    const offs = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) offs.push(i + 1);
    this.lineCache = { text, offs };
    return offs;
  }

  /** かたまりの、本文での範囲 */
  private sectionBounds(text: string, lineStart: number, lineEnd: number): { start: number; end: number } {
    const offs = this.lineOffsets(text);
    const start = offs[Math.min(lineStart, offs.length - 1)];
    const end = lineEnd + 1 < offs.length ? offs[lineEnd + 1] - 1 : text.length;
    return { start, end };
  }

  /** 閲覧表示の本文が model.text と違うときは、別に位置を求める */
  private annosForText(model: Model, text: string): Anno[] {
    if (text === model.text) return model.annos;
    if (model.alt?.text === text) return model.alt.annos;
    const annos = model.annos.map(a => ({ ...a }));
    this.anchorAll(annos, text, new Map());
    model.alt = { text, annos };
    return annos;
  }

  private textNodes(el: HTMLElement): Text[] {
    const out: Text[] = [];
    const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
    return out;
  }

  private alignmentFor(el: HTMLElement, src: string, nodes: Text[]): Alignment {
    const dst = nodes.map(n => n.data).join('');
    const c = this.alignCache.get(el);
    if (c && c.src === src && c.dst === dst) return c.al;
    const al = align(src, dst);
    this.alignCache.set(el, { src, dst, al });
    return al;
  }

  private domRange(nodes: Text[], start: number, end: number): Range | null {
    let acc = 0;
    let sn: Text | null = null;
    let so = 0;
    for (const n of nodes) {
      const len = n.data.length;
      if (!sn && start < acc + len) {
        sn = n;
        so = start - acc;
      }
      if (sn && end <= acc + len) {
        const r = n.ownerDocument.createRange();
        r.setStart(sn, so);
        r.setEnd(n, end - acc);
        return r;
      }
      acc += len;
    }
    return null;
  }

  private highlightSection(el: HTMLElement) {
    this.clearSection(el);
    const ctx = this.sectionCtx.get(el);
    const info = ctx?.getSectionInfo(el);
    const model = ctx && this.models.get(ctx.sourcePath);
    if (!ctx || !info || !model) return;
    const { start: secStart, end: secEnd } = this.sectionBounds(info.text, info.lineStart, info.lineEnd);
    const annos = this.annosForText(model, info.text).filter(
      a => a.status !== 'orphan' && a.start < secEnd && a.end > secStart,
    );
    if (!annos.length) return;
    const nodes = this.textNodes(el);
    const al = this.alignmentFor(el, info.text.slice(secStart, secEnd), nodes);
    const list: Array<{ id: string; name: string; range: Range }> = [];
    for (const a of annos) {
      const r = mapRange(al.srcToDst, Math.max(a.start, secStart) - secStart, Math.min(a.end, secEnd) - secStart);
      if (!r) continue;
      const range = this.domRange(nodes, r.start, r.end);
      if (!range) continue;
      const name =
        a.status === 'tentative'
          ? TENTATIVE_HIGHLIGHT
          : a.styleKey === 'default'
            ? highlightName('default')
            : highlightName(Number(a.styleKey.slice(1)));
      this.highlightFor(name)?.add(range);
      list.push({ id: a.id, name, range });
    }
    if (list.length) this.sectionRanges.set(el, list);
  }

  private rehighlightReading(path: string) {
    for (const v of this.views(path)) {
      for (const el of Array.from(v.previewMode.containerEl.querySelectorAll<HTMLElement>('.obsidiannot-section'))) {
        this.highlightSection(el);
      }
    }
    for (const el of this.sectionRanges.keys()) if (!el.isConnected) this.clearSection(el);
  }

  /** 閲覧表示の位置（DOM）から本文の位置へ */
  private pointToSource(node: Node, offset: number, side: 'start' | 'end'): { path: string; offset: number; text: string } | null {
    const base = node instanceof Element ? node : node.parentElement;
    const el = base?.closest<HTMLElement>('.obsidiannot-section');
    const ctx = el && this.sectionCtx.get(el);
    const info = el && ctx?.getSectionInfo(el);
    if (!el || !ctx || !info) return null;
    const { start: secStart, end: secEnd } = this.sectionBounds(info.text, info.lineStart, info.lineEnd);
    const nodes = this.textNodes(el);
    const al = this.alignmentFor(el, info.text.slice(secStart, secEnd), nodes);
    const pre = el.ownerDocument.createRange();
    pre.setStart(el, 0);
    pre.setEnd(node, offset);
    const dstOff = pre.toString().length;
    const map = al.dstToSrc;
    let src = -1;
    if (side === 'start') {
      for (let j = dstOff; j < map.length; j++) if (map[j] >= 0) { src = map[j]; break; }
      if (src < 0) src = secEnd - secStart;
    } else {
      for (let j = dstOff - 1; j >= 0; j--) if (map[j] >= 0) { src = map[j] + 1; break; }
      if (src < 0) src = 0;
    }
    return { path: ctx.sourcePath, offset: secStart + src, text: info.text };
  }

  /** ビューの選択範囲を本文の範囲にする */
  selectionIn(view: MarkdownView): SourceRange | null {
    const path = view.file?.path;
    if (!this.isTarget(path)) return null;
    if (view.getMode() === 'source') {
      const ed = view.editor;
      if (!ed.somethingSelected()) return null;
      const a = ed.posToOffset(ed.getCursor('from'));
      const b = ed.posToOffset(ed.getCursor('to'));
      if (b <= a) return null;
      return { path, start: a, end: b, text: ed.getValue() };
    }
    const sel = view.containerEl.ownerDocument.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!view.previewMode.containerEl.contains(range.commonAncestorContainer)) return null;
    const s = this.pointToSource(range.startContainer, range.startOffset, 'start');
    const e = this.pointToSource(range.endContainer, range.endOffset, 'end');
    if (!s || !e || s.path !== path || e.path !== path || s.text !== e.text) return null;
    // 前後の空白は含めない
    let start = s.offset;
    let end = e.offset;
    while (start < end && /\s/.test(s.text[start])) start++;
    while (end > start && /\s/.test(s.text[end - 1])) end--;
    return end > start ? { path, start, end, text: s.text } : null;
  }

  rememberSelection(r: SourceRange) {
    this.lastSelection = r;
  }

  /** 閲覧表示でクリックした位置にある註 */
  annotationAtPoint(x: number, y: number, doc: Document): { path: string; id: string } | null {
    const caret = doc.caretRangeFromPoint?.(x, y);
    if (!caret) return null;
    const el = (caret.startContainer instanceof Element ? caret.startContainer : caret.startContainer.parentElement)?.closest<HTMLElement>('.obsidiannot-section');
    const list = el && this.sectionRanges.get(el);
    const ctx = el && this.sectionCtx.get(el);
    if (!list || !ctx) return null;
    for (const r of list) {
      try {
        if (r.range.isPointInRange(caret.startContainer, caret.startOffset)) return { path: ctx.sourcePath, id: r.id };
      } catch {
        /* 別の木の点 */
      }
    }
    return null;
  }

  // ---- 註の作成・移動・再配置 ----

  /** 註（chu）・照（sho）を作る */
  async create(kind: 'chu' | 'sho', r: SourceRange): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(r.path);
    if (!(file instanceof TFile)) return;
    const folder = this.plugin.service.folder;
    const link = `[[${this.app.metadataCache.fileToLinktext(file, folder ? `${folder}/_.md` : '_.md', true)}]]`;
    const notePath = this.notesFor(r.path)[0];
    const res = await this.plugin.service.createAnnotation({
      uris: [link],
      // 註ノートが対象と同じ名前だと [[名前]] が註ノート自身を指すので、末尾を付ける
      title: `${file.basename}${this.plugin.settings.localSuffix || ' - local'}`,
      source: link,
      selector: selectorsForRange(r.text, r.start, r.end),
      ...(notePath ? { path: notePath } : {}),
    });
    this.pendingLinks.set(r.path, res.note.path);
    this.invalidateLinks();
    await this.load(r.path);
    if (kind === 'sho' && res.blockId) {
      const l = this.plugin.linkTo(res.note.path, res.blockId);
      await navigator.clipboard.writeText(l);
      new Notice(`照: リンクをコピーしました ${l}`);
    }
    if (kind === 'chu') await this.plugin.localPanel.editComment(res.note.path, res.id);
  }

  private findAnno(notePath: string, id: string): { model: Model; anno: Anno } | null {
    for (const model of this.models.values()) {
      const anno = model.annos.find(a => a.id === id && a.notePath === notePath);
      if (anno) return { model, anno };
    }
    return null;
  }

  /** 本文で選んだ範囲に、註を移す */
  async relocate(notePath: string, id: string) {
    const found = this.findAnno(notePath, id);
    const sel = this.lastSelection;
    if (!found) return;
    // 選択範囲が古くなっていないか（その後に本文が変わっていれば使わない）
    const current = sel ? (this.openText(sel.path) ?? found.model.text) : null;
    if (!sel || sel.path !== found.model.path || current !== sel.text) {
      new Notice('本文で新しい位置を選んでから押してください');
      return;
    }
    await this.place(found.anno, sel.text, sel.start, sel.end);
  }

  /** 推定の位置で確定する */
  async confirm(notePath: string, id: string) {
    const found = this.findAnno(notePath, id);
    if (!found || found.anno.status === 'orphan') return;
    await this.place(found.anno, found.model.text, found.anno.start, found.anno.end);
  }

  private async place(anno: Anno, text: string, start: number, end: number) {
    const selector = selectorsForRange(text, start, end);
    const exact = (selector[0] as TextQuoteSelector).exact;
    const original = exact !== anno.quote.exact && anno.original == null ? anno.quote.exact : undefined;
    // 表示はすぐに直す。記録が前と同じ（消した文を戻して同じ範囲を選んだときなど）だと
    // 註ノートは書き換わらず読み込み直しも起きないので、書き込みを待たない
    const model = this.findAnno(anno.notePath, anno.id)?.model;
    anno.quote = quoteAnchorOf(selector)!;
    if (original != null) anno.original = original;
    anno.status = 'ok';
    anno.start = start;
    anno.end = end;
    const fresh = model?.text === text;
    if (model && fresh) {
      model.alt = undefined;
      this.publish(model);
    }
    await this.writeSelectors(anno.notePath, new Map([[anno.id, { selector, original }]]));
    // 本文が model より先に進んでいたときは、書き込んだ記録から探し直す
    if (model && !fresh) await this.load(model.path);
    new Notice('註の位置を更新しました');
  }

  /** 註ノートのカードから、本文の該当箇所へ移動する */
  async reveal(notePath: string, id: string) {
    let found = this.findAnno(notePath, id);
    if (!found) {
      for (const t of this.targetsOf(notePath)) await this.ensure(t);
      found = this.findAnno(notePath, id);
    }
    const target = found?.model.path ?? this.targetsOf(notePath)[0];
    const file = target && this.app.vault.getAbstractFileByPath(target);
    if (!(file instanceof TFile)) {
      new Notice('註の対象のノートが見つかりません');
      return;
    }
    const leaf = this.mainLeafFor(target);
    if ((leaf.view as MarkdownView).file?.path !== target) await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const model = await this.ensure(target);
    const anno = model?.annos.find(a => a.id === id && a.notePath === notePath);
    if (!model || !anno || anno.status === 'orphan') {
      new Notice('本文の中に註の位置が見つかりません');
      return;
    }
    const view = leaf.view as MarkdownView;
    if (view.getMode() === 'source') {
      const pos = view.editor.offsetToPos(anno.start);
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: view.editor.offsetToPos(anno.end) }, true);
      this.flashEditor(target, id);
    } else {
      const line = this.lineOffsets(model.text).findLastIndex(o => o <= anno.start);
      view.setEphemeralState({ line: Math.max(0, line) });
      window.setTimeout(() => this.flashReading(target, id), 300);
    }
  }

  private mainLeafFor(path: string): WorkspaceLeaf {
    const ws = this.app.workspace;
    const main = ws.getLeavesOfType('markdown').filter(l => l.getRoot() === ws.rootSplit);
    return (
      main.find(l => (l.view as MarkdownView).file?.path === path) ??
      ws.getMostRecentLeaf(ws.rootSplit) ??
      ws.getLeaf('tab')
    );
  }

  private flashEditor(path: string, id: string) {
    for (const cm of this.editorsOf(path)) cm.dispatch({ effects: setFlash.of(id) });
    window.setTimeout(() => {
      for (const cm of this.editorsOf(path)) if (cm.state.field(annoField).flash === id) cm.dispatch({ effects: setFlash.of(null) });
    }, FLASH_MS);
  }

  private flashReading(path: string, id: string) {
    const h = this.highlightFor(FOCUS_HIGHLIGHT);
    if (!h) return;
    const ranges: Range[] = [];
    for (const [el, list] of this.sectionRanges) {
      if (this.sectionCtx.get(el)?.sourcePath !== path) continue;
      for (const r of list) if (r.id === id) ranges.push(r.range);
    }
    for (const r of ranges) h.add(r);
    ranges[0]?.startContainer.parentElement?.scrollIntoView({ block: 'center' });
    window.setTimeout(() => ranges.forEach(r => h.delete(r)), FLASH_MS);
  }

  // ---- カード ----

  /** 註カードに状態（見つからない・推定）と操作ボタンを付ける */
  decorateCard(card: HTMLElement, notePath: string, id: string) {
    card.dataset.notePath = notePath;
    card.querySelector('.obsidiannot-local-status')?.remove();
    card.querySelector('.obsidiannot-original')?.remove();
    card.removeClass('is-orphan', 'is-tentative');
    const found = this.findAnno(notePath, id);
    if (!found) return;
    const { anno } = found;
    if (anno.original != null) {
      const meta = card.querySelector('.obsidiannot-meta');
      meta?.createSpan({ cls: 'obsidiannot-original', text: '書き換えあり', attr: { title: `元の引用: ${anno.original}` } });
    }
    if (anno.status !== 'orphan' && anno.status !== 'tentative') return;
    card.addClass(anno.status === 'orphan' ? 'is-orphan' : 'is-tentative');
    const box = card.createDiv({ cls: 'obsidiannot-local-status' });
    box.createSpan({ text: anno.status === 'orphan' ? '本文の中に見つかりません' : '位置を推定しました' });
    const button = (label: string, title: string, fn: () => Promise<void>) => {
      const b = box.createEl('button', { text: label, attr: { title } });
      b.addEventListener('mousedown', ev => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      b.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        void fn();
      });
    };
    if (anno.status === 'tentative') button('ここで確定', '推定した位置を正しい位置として記録します', () => this.confirm(notePath, id));
    button('選択範囲に再配置', '本文で選んだ範囲を、この註の位置にします', () => this.relocate(notePath, id));
  }

  private redecorateCards(notePaths: string[]) {
    for (const card of Array.from(document.querySelectorAll<HTMLElement>('.obsidiannot-card[data-note-path]'))) {
      const np = card.dataset.notePath!;
      if (notePaths.includes(np) && card.dataset.annotationId) this.decorateCard(card, np, card.dataset.annotationId);
    }
  }

  /** 見つからない・推定の註の数 */
  problems(path: string): { orphan: Anno[]; tentative: Anno[] } {
    const m = this.models.get(path);
    return {
      orphan: m?.annos.filter(a => a.status === 'orphan') ?? [],
      tentative: m?.annos.filter(a => a.status === 'tentative') ?? [],
    };
  }
}
