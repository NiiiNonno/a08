/**
 * Obsidian の PDF ビューアへの註。
 *
 * PDF ビューアの中身は公開の API ではないので、触るのは次のものだけにする（Obsidian の内部の関数は書き換えない）:
 * - view.viewer.child.pdfViewer（PDF.js の app）: eventBus と pdfViewer
 * - pdfViewer.pdfDocument: 文字の取り出し（getTextContent）
 * - pdfViewer.getPageView(i).textLayer: 文字の層の要素（textDivs）
 *
 * 位置は PDF 全体の文字列（@a08/core の PdfTextModel）で持つ。描画のときは、ページの文字の層の文字列と
 * ページの文字列を突き合わせて（同じなら素通し、違えば align で対応づけ）DOM の範囲にする。
 * そのため文字の層の番号（data-idx）の数え方が Obsidian の版で変わっても影響を受けない。
 *
 * ハイライトはページの上に矩形を重ねて描く（PDF++ と同じ方式。位置はページに対する割合なので拡大縮小に追従し、
 * ページが描き直されたら textlayerrendered で描き直す）。
 */
import { TFile, apiVersion, type App, type View } from 'obsidian';
import { PdfTextModel, align, pageText, type Alignment, type AnchorStatus, type PdfTextItem } from '@a08/core';

// ---------------------------------------------------------------- Obsidian / PDF.js の内部（使う分だけ）

type TextLayerBuilderLike = {
  div?: HTMLElement;
  /** Obsidian 1.8 以降 */
  textLayer?: { textDivs?: HTMLElement[] } | null;
  /** Obsidian 1.7 以前 */
  textDivs?: HTMLElement[];
};
type PageViewLike = { id: number; div: HTMLDivElement; pageLabel?: string | null; textLayer?: TextLayerBuilderLike | null };
type PdfDocLike = {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(opts?: object): Promise<{ items: unknown[] }> }>;
  getPageLabels?(): Promise<string[] | null>;
};
type PdfViewerLike = {
  pdfDocument: PdfDocLike | null;
  pagesCount: number;
  getPageView(index: number): PageViewLike | undefined;
  scrollPageIntoView(params: { pageNumber: number }): void;
};
type EventBusLike = {
  on(name: string, cb: (data: { pageNumber?: number }) => void): void;
  off(name: string, cb: (data: { pageNumber?: number }) => void): void;
};
type PdfChildLike = { pdfViewer?: { eventBus?: EventBusLike; pdfViewer?: PdfViewerLike | null } | null; containerEl?: HTMLElement };
export type PdfViewLike = View & {
  file: TFile | null;
  viewer?: { child?: PdfChildLike | null; then?(cb: (child: PdfChildLike) => void): void };
};

export function isPdfView(v: View | null | undefined): v is PdfViewLike {
  return !!v && v.getViewType() === 'pdf';
}

function pdfViewerOf(view: PdfViewLike): PdfViewerLike | null {
  return view.viewer?.child?.pdfViewer?.pdfViewer ?? null;
}

function textDivsOf(pv: PageViewLike): HTMLElement[] | null {
  const tl = pv.textLayer;
  if (!tl) return null;
  const divs = tl.textLayer?.textDivs ?? tl.textDivs;
  if (Array.isArray(divs) && divs.length) return divs;
  // 見えない（PDF.js 本来の、textDivs が非公開の）版: 文字の層の要素から拾う。
  // 文字の要素は層の直下か marked content の span の中にある（検索の強調の span はその中）
  const root = tl.div;
  if (!root?.isConnected) return null;
  return Array.from(root.querySelectorAll<HTMLElement>('span')).filter(
    el => !el.classList.contains('markedContent') && (el.parentElement === root || el.parentElement?.classList.contains('markedContent')),
  );
}

/** 文字の層の番号（data-idx）の数え始め。PDF++ と同じ扱い（Obsidian 1.8.0 だけ 1 から） */
const TEXT_DIV_FIRST_IDX = apiVersion === '1.8.0' ? 1 : 0;

// ---------------------------------------------------------------- 文字の層とページの文字列の対応

type LayerText = {
  divs: HTMLElement[];
  /** 各 div の、層の文字列での開始位置 */
  starts: number[];
  text: string;
  /** ページの文字列 → 層の文字列（同じなら null） */
  al: Alignment | null;
};

function layerTextOf(divs: HTMLElement[], page: string, cache: WeakMap<HTMLElement, LayerText>): LayerText {
  // 層が描き直されると要素が変わるので、最初の要素で覚える
  const c = cache.get(divs[0]);
  if (c && c.divs.length === divs.length && c.divs[c.divs.length - 1] === divs[divs.length - 1]) return c;
  const starts: number[] = [];
  let text = '';
  for (const d of divs) {
    starts.push(text.length);
    text += d.textContent ?? '';
    // 行末の項目の後には <br> が入る（ページの文字列では改行）
    if (d.nextSibling?.nodeName === 'BR') text += '\n';
  }
  const lt: LayerText = { divs, starts, text, al: text === page ? null : align(page, text) };
  cache.set(divs[0], lt);
  return lt;
}

/** 対応表で 1 点を写す（start なら次の対応点、end なら前の対応点の直後） */
function mapPoint(map: Int32Array, i: number, side: 'start' | 'end', limit: number): number {
  if (side === 'start') {
    for (let j = i; j < map.length; j++) if (map[j] >= 0) return map[j];
    return limit;
  }
  for (let j = i - 1; j >= 0; j--) if (map[j] >= 0) return map[j] + 1;
  return 0;
}

function divAt(lt: LayerText, offset: number, side: 'start' | 'end'): number {
  // start: offset を含む div、end: offset で終わる（か含む）div
  let lo = 0;
  let hi = lt.starts.length - 1;
  const key = side === 'end' ? offset - 1 : offset;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lt.starts[mid] <= key) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** div の中の、文字数で数えた位置の DOM 上の点 */
function pointIn(div: HTMLElement, offset: number): { node: Node; offset: number } {
  const w = div.ownerDocument.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let rest = offset;
  let last: Text | null = null;
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    if (rest <= n.data.length) return { node: n, offset: rest };
    rest -= n.data.length;
    last = n;
  }
  return last ? { node: last, offset: last.data.length } : { node: div, offset: div.childNodes.length };
}

/** div の中の DOM 上の点を、文字数で数えた位置に */
function offsetIn(div: HTMLElement, node: Node, offset: number): number {
  if (node.nodeType !== Node.TEXT_NODE) {
    // 要素の子の番号で表された点
    const r = div.ownerDocument.createRange();
    r.setStart(div, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  }
  const w = div.ownerDocument.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let acc = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n === node) return acc + offset;
    acc += (n as Text).data.length;
  }
  return acc;
}

// ---------------------------------------------------------------- 本体

export type PdfAnno = { id: string; start: number; end: number; status: AnchorStatus; styleKey: string };

export type PdfHooks = {
  /** 文書が読み込まれた（位置探しを始める） */
  loaded(path: string): void;
  /** そのファイルの、位置のわかっている註 */
  annos(path: string): PdfAnno[];
  /** ハイライトを押した */
  clicked(path: string, id: string): void;
};

const FLASH_MS = 1600;

export class PdfAnnotations {
  private texts = new Map<string, { mtime: number; model: Promise<PdfTextModel | null> }>();
  private layerCache = new WeakMap<HTMLElement, LayerText>();
  private hooked = new WeakSet<EventBusLike>();
  private unhook: Array<() => void> = [];
  /** ページが描かれたら光らせる註 */
  private pendingFlash = new Map<string, string>();

  constructor(
    private app: App,
    private hooks: PdfHooks,
  ) {}

  destroy() {
    for (const f of this.unhook) f();
    this.unhook = [];
    for (const el of Array.from(document.querySelectorAll('.obsidiannot-pdf-layer'))) el.remove();
  }

  views(path?: string): PdfViewLike[] {
    return this.app.workspace
      .getLeavesOfType('pdf')
      .map(l => l.view)
      .filter((v): v is PdfViewLike => isPdfView(v) && (!path || v.file?.path === path));
  }

  // ---- ビューへの取り付け

  /** 開いている PDF ビューすべてに取り付ける（何度呼んでもよい） */
  attachAll() {
    for (const v of this.views()) this.attach(v);
  }

  private attach(view: PdfViewLike) {
    const go = (child: PdfChildLike) => {
      const bus = child.pdfViewer?.eventBus;
      if (!bus || this.hooked.has(bus)) return;
      this.hooked.add(bus);
      const onText = (d: { pageNumber?: number }) => {
        const path = view.file?.path;
        if (path && d.pageNumber) this.drawPage(view, path, d.pageNumber - 1);
      };
      const onLoaded = () => {
        const path = view.file?.path;
        if (path) this.hooks.loaded(path);
      };
      bus.on('textlayerrendered', onText);
      bus.on('pagesloaded', onLoaded);
      this.unhook.push(() => {
        bus.off('textlayerrendered', onText);
        bus.off('pagesloaded', onLoaded);
      });
      // 取り付ける前に読み込み終わっていた
      if (pdfViewerOf(view)?.pdfDocument) onLoaded();
    };
    const child = view.viewer?.child;
    if (child) go(child);
    else view.viewer?.then?.(go);
  }

  // ---- 文字列

  /** PDF の文字列のモデル。開いているビューの文書から作る（開いていなければ null） */
  textModel(path: string): Promise<PdfTextModel | null> {
    const f = this.app.vault.getAbstractFileByPath(path);
    const mtime = f instanceof TFile ? f.stat.mtime : 0;
    const c = this.texts.get(path);
    if (c && c.mtime === mtime) return c.model;
    const doc = this.views(path).map(v => pdfViewerOf(v)?.pdfDocument).find(Boolean);
    if (!doc) return Promise.resolve(null);
    const model = extract(doc).catch(e => {
      console.warn('[obsidiannot] PDF の文字を取り出せません', path, e);
      this.texts.delete(path);
      return null;
    });
    this.texts.set(path, { mtime, model });
    return model;
  }

  /** 読み終わっていればそのモデル（描画用。読み込みは待たない） */
  private ready = new Map<string, PdfTextModel>();
  setReady(path: string, model: PdfTextModel | null) {
    if (model) this.ready.set(path, model);
    else this.ready.delete(path);
  }

  forget(path: string) {
    this.texts.delete(path);
    this.ready.delete(path);
  }

  // ---- 描画

  /** そのファイルを開いているビューの、描かれているページすべてを描き直す */
  draw(path: string) {
    for (const v of this.views(path)) {
      const pv = pdfViewerOf(v);
      if (!pv) continue;
      for (let i = 0; i < pv.pagesCount; i++) {
        const page = pv.getPageView(i);
        if (page?.div.dataset.loaded != null || page?.textLayer?.div?.isConnected) this.drawPage(v, path, i);
      }
    }
  }

  private layerFor(page: PageViewLike): HTMLElement {
    let layer = page.div.querySelector<HTMLElement>(':scope > .obsidiannot-pdf-layer');
    if (!layer) {
      layer = page.div.ownerDocument.createElement('div');
      layer.className = 'obsidiannot-pdf-layer';
      // 文字の層より下（選択の邪魔をしない）、PDF の絵より上
      const text = page.textLayer?.div;
      if (text && text.parentElement === page.div) page.div.insertBefore(layer, text);
      else page.div.append(layer);
    }
    return layer;
  }

  private drawPage(view: PdfViewLike, path: string, index: number) {
    const model = this.ready.get(path);
    const pv = pdfViewerOf(view);
    const page = pv?.getPageView(index);
    if (!page) return;
    const layer = this.layerFor(page);
    layer.replaceChildren();
    if (!model || index >= model.pages.length) return;
    const divs = textDivsOf(page);
    if (!divs?.length) return;
    const pageStart = model.starts[index];
    const pageEnd = pageStart + model.pages[index].length;
    const annos = this.hooks.annos(path).filter(a => a.status !== 'orphan' && a.start < pageEnd && a.end > pageStart);
    if (!annos.length) return;
    const lt = layerTextOf(divs, model.pages[index], this.layerCache);
    // 矩形は層（ページの枠の内側いっぱい）に対する割合で置く。ページの枠線の分を含めないよう、層そのものを測る
    const box = layer.getBoundingClientRect();
    if (!box.width || !box.height) return;
    for (const a of annos) {
      const s = Math.max(a.start, pageStart) - pageStart;
      const e = Math.min(a.end, pageEnd) - pageStart;
      const ls = lt.al ? mapPoint(lt.al.srcToDst, s, 'start', lt.text.length) : s;
      const le = lt.al ? mapPoint(lt.al.srcToDst, e, 'end', lt.text.length) : e;
      if (le <= ls) continue;
      const range = this.domRange(lt, ls, le);
      if (!range) continue;
      for (const r of mergeLines(Array.from(range.getClientRects()))) {
        const el = layer.ownerDocument.createElement('div');
        el.className = `obsidiannot-pdf-rect obsidiannot-mark obsidiannot-mark-${a.styleKey}`;
        if (a.status === 'tentative') el.classList.add('is-tentative');
        el.dataset.obsidiannotId = a.id;
        el.style.left = `${((r.left - box.left) / box.width) * 100}%`;
        el.style.top = `${((r.top - box.top) / box.height) * 100}%`;
        el.style.width = `${(r.width / box.width) * 100}%`;
        el.style.height = `${(r.height / box.height) * 100}%`;
        layer.append(el);
      }
    }
    const flash = this.pendingFlash.get(path);
    if (flash && layer.querySelector(`[data-obsidiannot-id="${CSS.escape(flash)}"]`)) {
      this.pendingFlash.delete(path);
      this.flashIn(view, flash);
    }
  }

  private domRange(lt: LayerText, start: number, end: number): Range | null {
    if (!lt.divs.length) return null;
    const si = divAt(lt, start, 'start');
    const ei = divAt(lt, end, 'end');
    const sd = lt.divs[si];
    const ed = lt.divs[ei];
    const sLen = (sd.textContent ?? '').length;
    const eLen = (ed.textContent ?? '').length;
    const a = pointIn(sd, Math.min(Math.max(0, start - lt.starts[si]), sLen));
    const b = pointIn(ed, Math.min(Math.max(0, end - lt.starts[ei]), eLen));
    const r = sd.ownerDocument.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      return null;
    }
    return r.collapsed ? null : r;
  }

  // ---- 選択

  /** ビューの選択範囲を、PDF 全体の文字列の範囲にする */
  selection(view: PdfViewLike): { start: number; end: number; text: string } | null {
    const path = view.file?.path;
    const pv = pdfViewerOf(view);
    if (!path || !pv) return null;
    const sel = view.containerEl.ownerDocument.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!view.containerEl.contains(range.commonAncestorContainer)) return null;
    // 位置探しが済んで（文字を取り出し終えて）いなければ使えない
    const model = this.ready.get(path);
    if (!model) return null;
    let start = -1;
    let end = -1;
    for (let i = 0; i < pv.pagesCount && i < model.pages.length; i++) {
      const page = pv.getPageView(i);
      if (!page || !range.intersectsNode(page.div)) continue;
      const divs = textDivsOf(page);
      if (!divs?.length) continue;
      const hit = divs.filter(d => range.intersectsNode(d) && (d.textContent ?? '').length);
      if (!hit.length) continue;
      const lt = layerTextOf(divs, model.pages[i], this.layerCache);
      const first = hit[0];
      const last = hit[hit.length - 1];
      const fi = divs.indexOf(first);
      const li = divs.indexOf(last);
      const ls = lt.starts[fi] + (first.contains(range.startContainer) ? offsetIn(first, range.startContainer, range.startOffset) : 0);
      const le = lt.starts[li] + (last.contains(range.endContainer) ? offsetIn(last, range.endContainer, range.endOffset) : (last.textContent ?? '').length);
      const ps = lt.al ? mapPoint(lt.al.dstToSrc, ls, 'start', model.pages[i].length) : ls;
      const pe = lt.al ? mapPoint(lt.al.dstToSrc, le, 'end', model.pages[i].length) : le;
      if (start < 0) start = model.starts[i] + ps;
      end = model.starts[i] + pe;
    }
    if (start < 0 || end <= start) return null;
    // 前後の空白は含めない
    while (start < end && /\s/.test(model.text[start])) start++;
    while (end > start && /\s/.test(model.text[end - 1])) end--;
    return end > start ? { start, end, text: model.text } : null;
  }

  // ---- クリック・移動

  /** 座標にある註（重なっていれば小さいものを優先） */
  hitTest(view: PdfViewLike, x: number, y: number): string | null {
    let best: { id: string; area: number } | null = null;
    for (const el of Array.from(view.containerEl.querySelectorAll<HTMLElement>('.obsidiannot-pdf-rect'))) {
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (!best || area < best.area) best = { id: el.dataset.obsidiannotId!, area };
    }
    return best?.id ?? null;
  }

  /** 註の位置へ移動して光らせる（ページがまだ描かれていなければ、描かれたときに） */
  reveal(view: PdfViewLike, path: string, id: string, start: number) {
    const model = this.ready.get(path);
    const pv = pdfViewerOf(view);
    if (!model || !pv) return;
    const page = model.pageAt(start);
    if (this.flashIn(view, id)) return;
    this.pendingFlash.set(path, id);
    pv.scrollPageIntoView({ pageNumber: page + 1 });
    // すでに描かれていたページなら、移動の後で
    window.setTimeout(() => {
      if (this.pendingFlash.get(path) === id && this.flashIn(view, id)) this.pendingFlash.delete(path);
    }, 300);
  }

  private flashIn(view: PdfViewLike, id: string): boolean {
    const els = Array.from(view.containerEl.querySelectorAll<HTMLElement>(`.obsidiannot-pdf-rect[data-obsidiannot-id="${CSS.escape(id)}"]`));
    if (!els.length) return false;
    els[0].scrollIntoView({ block: 'center' });
    for (const el of els) el.classList.add('is-flash');
    window.setTimeout(() => els.forEach(el => el.classList.remove('is-flash')), FLASH_MS);
    return true;
  }

  /**
   * PDF の該当箇所へのリンク（Obsidian 標準の #page=N&selection=… の形）。
   * ページの文字の層が描かれていないときは、ページだけのリンクにする
   */
  linkTarget(path: string, start: number, end: number): string {
    const model = this.ready.get(path);
    if (!model) return '';
    const page = model.pageAt(start);
    let sub = `#page=${page + 1}`;
    const pageView = this.views(path)
      .map(v => pdfViewerOf(v)?.getPageView(page))
      .find(p => p && textDivsOf(p)?.length);
    const divs = pageView && textDivsOf(pageView);
    if (divs?.length && model.pageAt(end - 1) === page) {
      const lt = layerTextOf(divs, model.pages[page], this.layerCache);
      const ps = start - model.starts[page];
      const pe = end - model.starts[page];
      const ls = lt.al ? mapPoint(lt.al.srcToDst, ps, 'start', lt.text.length) : ps;
      const le = lt.al ? mapPoint(lt.al.srcToDst, pe, 'end', lt.text.length) : pe;
      const si = divAt(lt, ls, 'start');
      const ei = divAt(lt, le, 'end');
      const sIdx = Number(lt.divs[si].dataset.idx);
      const eIdx = Number(lt.divs[ei].dataset.idx);
      if (Number.isFinite(sIdx) && Number.isFinite(eIdx)) {
        sub += `&selection=${sIdx - TEXT_DIV_FIRST_IDX},${ls - lt.starts[si]},${eIdx - TEXT_DIV_FIRST_IDX},${le - lt.starts[ei]}`;
      }
    }
    return sub;
  }
}

/** PDF の全ページの文字を取り出す */
async function extract(doc: PdfDocLike): Promise<PdfTextModel> {
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    // ビューアの文字の層と同じ設定で取り出す
    const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    pages.push(pageText(tc.items as PdfTextItem[]));
  }
  let labels: (string | null)[] = [];
  try {
    labels = (await doc.getPageLabels?.()) ?? [];
  } catch {
    /* ラベルのない PDF */
  }
  return new PdfTextModel(pages, labels);
}

/** 同じ行の矩形をまとめる */
function mergeLines(rects: DOMRect[]): DOMRect[] {
  const list = rects.filter(r => r.width > 0.5 && r.height > 0.5).sort((a, b) => a.top - b.top || a.left - b.left);
  const out: DOMRect[] = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last) {
      const cy = (r.top + r.bottom) / 2;
      const ly = (last.top + last.bottom) / 2;
      const sameLine = Math.abs(cy - ly) < Math.max(r.height, last.height) * 0.5;
      const near = r.left <= last.right + Math.max(r.height, last.height);
      if (sameLine && near) {
        const left = Math.min(last.left, r.left);
        const top = Math.min(last.top, r.top);
        out[out.length - 1] = new DOMRect(left, top, Math.max(last.right, r.right) - left, Math.max(last.bottom, r.bottom) - top);
        continue;
      }
    }
    out.push(r);
  }
  return out;
}
