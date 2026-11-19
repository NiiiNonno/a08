/**
 * content script。ページ内のハイライト・註の作成・クリック判定を担当する。
 *
 * ページの DOM は書き換えない:
 * - ハイライトは CSS Custom Highlight API（CSS.highlights）
 * - UI（註ボタン・入力欄・余白マーカー）は <html> 直下の Shadow DOM
 */
import { TextModel, anchor, describe, ignoreSelectors, type IgnoreFn } from '@a08/core/anchoring';
import {
  DEFAULT_STYLES,
  HIGHLIGHT_PREFIX,
  accentColor,
  buildHighlightCss,
  highlightName,
  normalizeUri,
  displayQuote,
  quoteOf,
  styleIndicesForTags,
  type AnnotationView,
  type NoteView,
  type Selector,
  type StyleConfig,
} from '@a08/core';
import { loadSettings, rpc, type ConnectionStatus, type ContentMessage, type PageInfo, type PanelMessage } from './messages.ts';
import { UI_CSS } from './content-ui.ts';
import { iconHtml } from './icons.ts';

/**
 * 同じページに 2 回入った場合（拡張の再読み込み後に注入し直したときなど）は、
 * 前のインスタンスを片付けてから動く。
 */
const g = globalThis as typeof globalThis & { __obsidiannotTeardown?: () => void };
try {
  g.__obsidiannotTeardown?.();
} catch {
  /* 前のインスタンスの文脈が無効 */
}
const lifetime = new AbortController();
const on = { signal: lifetime.signal };
const timers: ReturnType<typeof setInterval>[] = [];
let observer: MutationObserver | null = null;
g.__obsidiannotTeardown = () => {
  lifetime.abort();
  for (const t of timers) clearInterval(t);
  observer?.disconnect();
  host.remove();
  // 自分が登録したハイライトだけを消す（入れ直した新しいインスタンスも同じ名前を使うため）
  for (const n of [...mine.keys()]) deleteHighlight(n);
  try {
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.storage.onChanged.removeListener(onStorage);
  } catch {
    /* ignore */
  }
};
/** 拡張が再読み込みされると、古い content script からは chrome.runtime が使えなくなる */
function contextAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

type Anchored = { a: AnnotationView; ranges: Range[] };

const state = {
  ignore: (() => false) as IgnoreFn,
  styles: DEFAULT_STYLES as StyleConfig,
  note: null as NoteView | null,
  anchors: new Map<string, Anchored>(),
  orphans: [] as string[],
  url: '',
  uris: [] as string[],
  title: '',
  hoverId: null as string | null,
  focusId: null as string | null,
  pendingScroll: null as string | null,
  connected: false,
  copyLink: true,
};

// ---------------------------------------------------------------- ページ情報

function absUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, location.href).toString();
  } catch {
    return null;
  }
}

function meta(...names: string[]): string | null {
  for (const n of names) {
    const el = document.querySelector<HTMLMetaElement>(`meta[name="${n}" i], meta[property="${n}" i]`);
    const v = el?.content?.trim();
    if (v) return v;
  }
  return null;
}

function pageCandidates(): { url: string; uris: string[]; title: string } {
  const url = location.href.replace(/#.*$/, '');
  const list: (string | null)[] = [url];
  list.push(absUrl(document.querySelector<HTMLLinkElement>('link[rel~="canonical" i]')?.getAttribute('href')));
  list.push(absUrl(meta('og:url')));
  const doi = meta('citation_doi', 'dc.identifier', 'prism.doi', 'bepress_citation_doi');
  if (doi) {
    const m = doi.match(/(10\.\d{4,9}\/\S+)/);
    if (m) list.push(`https://doi.org/${m[1]}`);
  }
  const arxiv = meta('citation_arxiv_id');
  if (arxiv) list.push(`https://arxiv.org/abs/${arxiv}`);
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const u of list) {
    if (!u || !/^(https?|file):/i.test(u)) continue;
    const n = normalizeUri(u);
    if (seen.has(n)) continue;
    seen.add(n);
    uris.push(u === url ? n : u);
  }
  const title = (document.title || meta('citation_title', 'og:title', 'dc.title') || url).trim();
  return { url, uris, title };
}

function pageInfo(): PageInfo {
  return {
    url: state.url,
    uris: state.uris,
    title: state.title,
    notePath: state.note?.path ?? null,
    anchored: state.anchors.size,
    total: state.note?.annotations.length ?? 0,
    orphans: state.orphans,
  };
}

function toPanel(msg: PanelMessage) {
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

// ---------------------------------------------------------------- ハイライト

const sheet = new CSSStyleSheet();
function applyStyles(cfg: StyleConfig) {
  state.styles = cfg;
  sheet.replaceSync(buildHighlightCss(cfg));
  if (!document.adoptedStyleSheets.includes(sheet)) {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
}

const highlightsSupported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
const usedNames = new Set<string>();
/** このインスタンスが登録した Highlight */
const mine = new Map<string, Highlight>();

function setHighlight(name: string, h: Highlight) {
  CSS.highlights.set(name, h);
  mine.set(name, h);
}

function deleteHighlight(name: string) {
  const h = mine.get(name);
  mine.delete(name);
  if (h && CSS.highlights?.get(name) === h) CSS.highlights.delete(name);
}

function namesFor(a: AnnotationView): string[] {
  const idx = styleIndicesForTags(state.styles, a.tags);
  return idx.length ? idx.map(i => highlightName(i)) : [highlightName('default')];
}

function paint() {
  if (!highlightsSupported) return;
  const groups = new Map<string, Range[]>();
  for (const { a, ranges } of state.anchors.values()) {
    for (const n of namesFor(a)) {
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n)!.push(...ranges);
    }
  }
  for (const n of usedNames) if (!groups.has(n)) deleteHighlight(n);
  usedNames.clear();
  const nTags = state.styles.tags.length;
  for (const [n, ranges] of groups) {
    const h = new Highlight(...ranges);
    // 上にあるタグほど手前に描く
    const m = n.startsWith(`${HIGHLIGHT_PREFIX}t`) ? n.slice(HIGHLIGHT_PREFIX.length).match(/^t(\d+)$/) : null;
    h.priority = m ? 10 + (nTags - Number(m[1])) : 1;
    setHighlight(n, h);
    usedNames.add(n);
  }
  paintTransient();
  updateMarkers();
}

function paintTransient() {
  if (!highlightsSupported) return;
  for (const [key, id] of [
    ['hover', state.hoverId],
    ['focus', state.focusId],
  ] as const) {
    const name = highlightName(key);
    const anc = id ? state.anchors.get(id) : undefined;
    if (anc) {
      const h = new Highlight(...anc.ranges);
      h.priority = key === 'focus' ? 1000 : 900;
      setHighlight(name, h);
    } else {
      deleteHighlight(name);
    }
  }
}

function anchorAll() {
  state.anchors.clear();
  state.orphans = [];
  const note = state.note;
  if (note?.annotations.length && document.body) {
    const model = new TextModel(document.body, state.ignore);
    const here = new Set(state.uris.map(normalizeUri));
    for (const a of note.annotations) {
      // 註をつけたのと同じ文書なら位置情報も使う。別 URI なら引用だけで探す
      const usePosition = !a.source || here.has(normalizeUri(a.source));
      let res = null;
      try {
        res = anchor(model, a.selector, { usePosition });
      } catch (e) {
        console.debug('[obsidiannot] anchor failed', a.id, e);
      }
      const ranges = res ? model.rangesFor(res.start, res.end) : [];
      if (ranges.length) state.anchors.set(a.id, { a, ranges });
      else state.orphans.push(a.id);
    }
  }
  paint();
  toPanel({ kind: 'pageChanged', info: pageInfo() });
  if (state.pendingScroll && state.anchors.has(state.pendingScroll)) {
    const id = state.pendingScroll;
    state.pendingScroll = null;
    scrollToAnnotation(id, true);
  }
}

function setNote(note: NoteView | null) {
  state.note = note;
  anchorAll();
}

async function refreshNote() {
  const c = pageCandidates();
  state.url = c.url;
  state.uris = c.uris;
  state.title = c.title;
  try {
    setNote(await rpc('lookup', { uris: c.uris }));
    state.connected = true;
  } catch (e) {
    state.connected = false;
    console.debug('[obsidiannot] lookup failed', e);
    setNote(state.note);
  }
}

// ---------------------------------------------------------------- ヒットテスト

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

function rectHit(ranges: Range[], x: number, y: number): boolean {
  for (const r of ranges) {
    for (const rect of r.getClientRects()) {
      if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return true;
    }
  }
  return false;
}

/** 座標にある註（重なっていれば短いものを優先） */
function hitTest(x: number, y: number): string | null {
  if (!state.anchors.size) return null;
  const caret = caretAt(x, y);
  const hits: { id: string; len: number }[] = [];
  for (const [id, { ranges }] of state.anchors) {
    let near = !caret;
    if (caret) {
      for (const r of ranges) {
        try {
          if (r.isPointInRange(caret.node, caret.offset)) {
            near = true;
            break;
          }
        } catch {
          /* 別文書のノードなど */
        }
      }
    }
    if (near && rectHit(ranges, x, y)) {
      hits.push({ id, len: ranges.reduce((s, r) => s + r.toString().length, 0) });
    }
  }
  hits.sort((a, b) => a.len - b.len);
  return hits[0]?.id ?? null;
}

// ---------------------------------------------------------------- UI（Shadow DOM）

const host = document.createElement('obsidiannot-ui');
host.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
// open にしておくと自動テストから操作できる（ページ側からも見えるが、秘密情報は置かない）
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>${UI_CSS}</style>
<div class="adder" hidden>
  <button class="b-annotate icon" title="註（コメントをつける）">${iconHtml('message-square-quote', 18)}</button>
  <button class="b-shou icon" title="照（ハイライトしてリンクをコピー）">${iconHtml('star', 18)}</button>
</div>
<div class="editor" hidden>
  <div class="quote"></div>
  <textarea placeholder="#tag  —  Ctrl+Enter ✓  /  Esc ✕"></textarea>
  <div class="row"><span class="hint"></span><button class="b-cancel icon" title="取消（Esc）">${iconHtml('x', 16)}</button><button class="b-save icon primary" title="保存（Ctrl+Enter）">${iconHtml('check', 16)}</button></div>
</div>
<div class="markers"></div>
<div class="toast" hidden></div>`;
const $ = <T extends Element>(sel: string) => shadow.querySelector(sel) as T;
const adder = $<HTMLDivElement>('.adder');
const editor = $<HTMLDivElement>('.editor');
const textarea = $<HTMLTextAreaElement>('textarea');
const markers = $<HTMLDivElement>('.markers');
const toast = $<HTMLDivElement>('.toast');

function mountHost() {
  if (!host.isConnected) document.documentElement.appendChild(host);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(text: string, error = false, detail?: string) {
  toast.textContent = text;
  if (detail) {
    const d = document.createElement('code');
    d.textContent = detail;
    toast.append(d);
  }
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), error ? 6000 : 2500);
}

/** 選択中の範囲（ページ本文内で、テキストを含むもの） */
function currentSelection(): Range | null {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!document.body?.contains(r.commonAncestorContainer)) return null;
  const el = r.commonAncestorContainer instanceof Element ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
  if (el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return null;
  if (!r.toString().trim()) return null;
  return r;
}

function placeNear(el: HTMLElement, range: Range) {
  const rects = range.getClientRects();
  const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
  el.hidden = false;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = last.right + scrollX - w / 2;
  let top = last.bottom + scrollY + 8;
  if (last.bottom + 8 + h > innerHeight) top = last.top + scrollY - h - 8;
  left = Math.max(scrollX + 8, Math.min(left, scrollX + document.documentElement.clientWidth - w - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

let draft: { selector: Selector[]; quote: string } | null = null;

function hideAdder() {
  adder.hidden = true;
}

function captureSelection(): { selector: Selector[]; quote: string; range: Range } | null {
  const range = currentSelection();
  if (!range) return null;
  const model = new TextModel(document.body, state.ignore);
  const selector = describe(model, range);
  if (!selector) return null;
  return { selector, quote: quoteOf({ selector }), range };
}

function openEditor() {
  const cap = captureSelection();
  if (!cap) {
    showToast('註をつける文字列を選択してください', true);
    return;
  }
  draft = { selector: cap.selector, quote: cap.quote };
  mountHost();
  hideAdder();
  const q = displayQuote(cap.quote);
  $<HTMLDivElement>('.quote').textContent = q.length > 160 ? `${q.slice(0, 160)}…` : q;
  $<HTMLSpanElement>('.hint').textContent = state.note ? state.note.path.split('/').pop()!.replace(/\.md$/, '') : '新しいノート';
  textarea.value = '';
  placeNear(editor, cap.range);
  textarea.focus();
}

function closeEditor() {
  editor.hidden = true;
  draft = null;
}

async function save(selector: Selector[], comment: string, shou = false) {
  try {
    const { note, id, link } = await rpc('createAnnotation', {
      uris: state.uris,
      title: state.title,
      // 追跡用パラメータなどは除いて記録する
      source: /^https?:/i.test(state.url) ? normalizeUri(state.url) : state.url,
      selector,
      comment,
      path: state.note?.path,
      blockId: shou && state.copyLink,
    });
    setNote(note);
    state.focusId = id;
    paintTransient();
    setTimeout(() => {
      if (state.focusId === id) {
        state.focusId = null;
        paintTransient();
      }
    }, 1200);
    toPanel({ kind: 'focusAnnotation', id, path: note.path });
    if (link) await copyLink(link);
    else showToast('保存しました');
    return true;
  } catch (e) {
    showToast(`保存できません: ${e instanceof Error ? e.message : e}`, true);
    return false;
  }
}

// ---------------------------------------------------------------- 照（リンクのコピー）

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http のページなどでは使えないので、拡張側（offscreen document）で書く
    try {
      return Boolean(await chrome.runtime.sendMessage({ kind: 'copyText', text }));
    } catch {
      return false;
    }
  }
}

async function copyLink(link: string) {
  const ok = await writeClipboard(link);
  if (ok) showToast('リンクをコピーしました', false, link);
  else showToast('クリップボードに書けません', true, link);
}

/** 既存の註のハイライトをクリックしたとき: ブロック ID を付けてリンクをコピー */
async function copyLinkFor(id: string) {
  const note = state.note;
  if (!note) return;
  try {
    const r = await rpc('linkToAnnotation', { path: note.path, id });
    if (r.note.version !== state.note?.version) setNote(r.note);
    await copyLink(r.link);
  } catch (e) {
    showToast(`リンクを作れません: ${e instanceof Error ? e.message : e}`, true);
  }
}

adder.addEventListener('mousedown', e => e.preventDefault());
$<HTMLButtonElement>('.b-annotate').addEventListener('click', () => openEditor());
$<HTMLButtonElement>('.b-shou').addEventListener('click', async () => {
  const cap = captureSelection();
  hideAdder();
  if (cap) {
    getSelection()?.removeAllRanges();
    await save(cap.selector, '', true);
  }
});
$<HTMLButtonElement>('.b-cancel').addEventListener('click', () => closeEditor());
$<HTMLButtonElement>('.b-save').addEventListener('click', async () => {
  if (!draft) return;
  const d = draft;
  if (await save(d.selector, textarea.value)) {
    closeEditor();
    getSelection()?.removeAllRanges();
  }
});
textarea.addEventListener('keydown', e => {
  e.stopPropagation(); // ページのショートカットに渡さない
  if (e.key === 'Escape') closeEditor();
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $<HTMLButtonElement>('.b-save').click();
  }
});
for (const ev of ['keyup', 'keypress', 'input'] as const) textarea.addEventListener(ev, e => e.stopPropagation());

function onSelectionEnd() {
  setTimeout(() => {
    if (!editor.hidden) return;
    const r = currentSelection();
    if (!r) {
      hideAdder();
      return;
    }
    mountHost();
    placeNear(adder, r);
  }, 0);
}

document.addEventListener('mouseup', e => {
  if (!contextAlive()) return g.__obsidiannotTeardown?.();
  if (e.composedPath().includes(host)) return;
  onSelectionEnd();
}, on);
document.addEventListener('keyup', e => {
  if (e.shiftKey || e.key === 'Shift') onSelectionEnd();
}, on);
document.addEventListener('mousedown', e => {
  if (e.composedPath().includes(host)) return;
  hideAdder();
}, on);

// ---------------------------------------------------------------- マーカー

/**
 * ページの中でスクロールする要素（overflow: auto/scroll で、中身がはみ出しているもの）のうち、
 * node に最も近いもの。なければ null（ウィンドウ全体がスクロールするページ）。
 * Obsidian Publish などは本文が独自のスクロール領域の中にある。
 */
function scrollableAncestor(node: Node): HTMLElement | null {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return el;
    }
    el = el.parentElement;
  }
  return null;
}

/** 範囲の最初の矩形が、スクロール領域に隠れず画面内に見えているか */
function visibleRect(range: Range): DOMRect | null {
  const rect = [...range.getClientRects()].find(r => r.width > 0 || r.height > 0);
  if (!rect) return null;
  if (rect.bottom < 0 || rect.top > innerHeight) return null;
  const sc = scrollableAncestor(range.startContainer);
  if (sc) {
    const b = sc.getBoundingClientRect();
    if (rect.bottom < b.top || rect.top > b.bottom) return null;
  }
  return rect;
}

/**
 * 余白マーカー（右端の短いバー）。画面に見えている註だけを、画面上の位置に出す。
 * スクロールのたびに描き直すので、ウィンドウでも内側のスクロール領域でも追従する。
 */
function updateMarkers() {
  markers.replaceChildren();
  if (!state.anchors.size) return;
  mountHost();
  const right = document.documentElement.clientWidth - 10;
  const seen = new Set<number>();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  for (const [id, { a, ranges }] of state.anchors) {
    const rect = ranges[0] && visibleRect(ranges[0]);
    if (!rect) continue;
    const top = Math.round(rect.top);
    if (seen.has(top)) continue;
    seen.add(top);
    const m = document.createElement('div');
    m.className = 'marker';
    const idx = styleIndicesForTags(state.styles, a.tags);
    const st = idx.length ? state.styles.tags[idx[0]].style : state.styles.default;
    m.style.setProperty('--c', accentColor(st, dark));
    m.style.top = `${top}px`;
    m.style.left = `${right}px`;
    m.style.height = `${Math.max(12, Math.round(rect.height))}px`;
    m.dataset.annotationId = id;
    m.title = a.comment ? a.comment.slice(0, 200) : quoteOf(a).slice(0, 200);
    m.addEventListener('click', () => {
      focusAnnotation(id, true);
    });
    markers.appendChild(m);
  }
}

let markerFrame = 0;
function scheduleMarkers() {
  if (markerFrame) return;
  markerFrame = requestAnimationFrame(() => {
    markerFrame = 0;
    updateMarkers();
  });
}
// 内側のスクロール領域のスクロールも拾うため、捕捉段階で受ける
document.addEventListener('scroll', scheduleMarkers, { capture: true, passive: true, signal: lifetime.signal });

// ---------------------------------------------------------------- スクロール・フォーカス

let focusTimer: ReturnType<typeof setTimeout> | undefined;
function focusAnnotation(id: string, notifyPanel: boolean) {
  state.focusId = id;
  paintTransient();
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    state.focusId = null;
    paintTransient();
  }, 2000);
  if (notifyPanel && state.note) toPanel({ kind: 'focusAnnotation', id, path: state.note.path });
}

function scrollToAnnotation(id: string, flash: boolean): boolean {
  const anc = state.anchors.get(id);
  if (!anc) {
    state.pendingScroll = id;
    return false;
  }
  const range = anc.ranges[0];
  const rect = range.getBoundingClientRect();
  const el = range.startContainer.parentElement;
  const sc = scrollableAncestor(range.startContainer);
  if (rect.height === 0 && el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else if (sc) {
    // 本文が内側のスクロール領域にあるページ: その領域をスクロールする
    let b = sc.getBoundingClientRect();
    if (b.bottom < 0 || b.top > innerHeight) {
      sc.scrollIntoView({ block: 'nearest' });
      b = sc.getBoundingClientRect();
    }
    const visibleH = Math.min(b.bottom, innerHeight) - Math.max(b.top, 0);
    sc.scrollTo({ top: sc.scrollTop + (rect.top - b.top) - visibleH / 3, behavior: 'smooth' });
  } else {
    scrollTo({ top: rect.top + scrollY - innerHeight / 3, behavior: 'smooth' });
  }
  if (flash) focusAnnotation(id, false);
  return true;
}

// ---------------------------------------------------------------- クリック・ホバー

document.addEventListener('click', e => {
  if (!contextAlive()) return g.__obsidiannotTeardown?.();
  if (e.composedPath().includes(host)) return;
  if (getSelection()?.isCollapsed === false) return;
  const id = hitTest(e.clientX, e.clientY);
  if (!id) return;
  focusAnnotation(id, true);
  if (state.copyLink) void copyLinkFor(id);
}, on);

let hoverPending = false;
document.addEventListener(
  'mousemove',
  e => {
    if (hoverPending || !state.anchors.size) return;
    if (!contextAlive()) return g.__obsidiannotTeardown?.();
    hoverPending = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      hoverPending = false;
      const id = hitTest(clientX, clientY);
      if (id !== state.hoverId) {
        state.hoverId = id;
        paintTransient();
      }
    });
  },
  { passive: true, signal: lifetime.signal },
);

// ---------------------------------------------------------------- DOM の変化・URL の変化

let mutationTimer: ReturnType<typeof setTimeout> | undefined;
function onMutations(records: MutationRecord[]) {
  if (records.every(r => host.contains(r.target))) return;
  clearTimeout(mutationTimer);
  mutationTimer = setTimeout(() => {
    if (!state.note?.annotations.length) return;
    const broken = [...state.anchors.values()].some(({ ranges }) =>
      ranges.every(r => r.collapsed || !r.startContainer.isConnected),
    );
    if (broken || state.orphans.length) anchorAll();
    else updateMarkers();
  }, 500);
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(scheduleMarkers, 200);
}, on);

let lastUrl = '';
timers.push(setInterval(() => {
  if (!contextAlive()) {
    g.__obsidiannotTeardown?.();
    return;
  }
  const u = location.href.replace(/#.*$/, '');
  if (u !== lastUrl) {
    lastUrl = u;
    void refreshNote();
  }
}, 1000));

// ---------------------------------------------------------------- メッセージ

function onMessage(msg: ContentMessage, _sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void): boolean {
  switch (msg?.kind) {
    case 'pageInfo':
      sendResponse(pageInfo());
      return false;
    case 'scrollTo':
      sendResponse(scrollToAnnotation(msg.id, msg.flash ?? true));
      return false;
    case 'annotateSelection':
      openEditor();
      return false;
    case 'hoverAnnotation':
      state.hoverId = msg.id;
      paintTransient();
      if (msg.id) {
        const anc = state.anchors.get(msg.id);
        if (anc?.ranges[0] && !visibleRect(anc.ranges[0])) scrollToAnnotation(msg.id, false);
      }
      return false;
    case 'statusChanged': {
      const st = msg.status as ConnectionStatus;
      if (st.styles) applyStyles(st.styles);
      const was = state.connected;
      state.connected = st.state === 'connected';
      if (state.connected && !was) void refreshNote();
      paint();
      return false;
    }
    case 'event': {
      if (msg.event === 'stylesChanged') {
        applyStyles((msg.data as { styles: StyleConfig }).styles);
        paint();
      } else if (msg.event === 'noteChanged') {
        const { path, note } = msg.data as { path: string; note: NoteView | null };
        if (state.note?.path === path) {
          if (!note) void refreshNote();
          else if (note.version !== state.note.version) setNote(note);
        } else if (note) {
          const here = new Set(state.uris.map(normalizeUri));
          if (note.uris.some(u => here.has(normalizeUri(u)))) setNote(note);
        }
      }
      return false;
    }
  }
  return false;
}
chrome.runtime.onMessage.addListener(onMessage);

// ---------------------------------------------------------------- 起動

async function init() {
  // 旧版（a08）の残りを片付ける
  document.querySelectorAll('a08-annotator').forEach(e => e.remove());
  for (const k of [...(CSS.highlights?.keys() ?? [])]) if (String(k).startsWith('a08-')) CSS.highlights.delete(k);
  const settings = await loadSettings();
  state.ignore = ignoreSelectors(settings.ignoreSelectors);
  state.copyLink = settings.copyLink;
  updateAdderTitles();
  applyStyles(DEFAULT_STYLES);
  try {
    const st = (await chrome.runtime.sendMessage({ kind: 'status' })) as ConnectionStatus;
    if (st?.styles) applyStyles(st.styles);
  } catch {
    /* background 起動前 */
  }
  lastUrl = location.href.replace(/#.*$/, '');
  await refreshNote();
  if (document.body) {
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  try {
    const r = (await chrome.runtime.sendMessage({ kind: 'contentReady' })) as { revealId: string | null };
    if (r?.revealId) scrollToAnnotation(r.revealId, true);
  } catch {
    /* ignore */
  }
}

function updateAdderTitles() {
  $<HTMLButtonElement>('.b-shou').title = state.copyLink ? '照（ハイライトしてリンクをコピー）' : '照（ハイライト）';
}

function onStorage(changes: Record<string, chrome.storage.StorageChange>) {
  if (changes.settings) {
    void loadSettings().then(s => {
      state.ignore = ignoreSelectors(s.ignoreSelectors);
      state.copyLink = s.copyLink;
      updateAdderTitles();
      anchorAll();
    });
  }
}
chrome.storage.onChanged.addListener(onStorage);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true, signal: lifetime.signal });
} else {
  void init();
}
