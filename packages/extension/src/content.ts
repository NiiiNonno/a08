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
  for (const n of usedNames) if (!groups.has(n)) CSS.highlights.delete(n);
  usedNames.clear();
  const nTags = state.styles.tags.length;
  for (const [n, ranges] of groups) {
    const h = new Highlight(...ranges);
    // 上にあるタグほど手前に描く
    const m = n.match(/^a08-t(\d+)$/);
    h.priority = m ? 10 + (nTags - Number(m[1])) : 1;
    CSS.highlights.set(n, h);
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
      CSS.highlights.set(name, h);
    } else {
      CSS.highlights.delete(name);
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
        console.debug('[a08] anchor failed', a.id, e);
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
    console.debug('[a08] lookup failed', e);
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

const host = document.createElement('a08-annotator');
host.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
// open にしておくと自動テストから操作できる（ページ側からも見えるが、秘密情報は置かない）
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>${UI_CSS}</style>
<div class="adder" hidden>
  <button class="b-annotate" title="註をつける（コメントを書く）">✎ 註</button>
  <button class="b-highlight" title="ハイライトだけ保存">▍ ハイライト</button>
</div>
<div class="editor" hidden>
  <div class="quote"></div>
  <textarea placeholder="コメント（#タグ も使えます）。Ctrl+Enter で保存、Esc で取消"></textarea>
  <div class="row"><span class="hint"></span><button class="b-cancel">取消</button><button class="b-save primary">保存</button></div>
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
function showToast(text: string, error = false) {
  toast.textContent = text;
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

async function save(selector: Selector[], comment: string) {
  try {
    const { note, id } = await rpc('createAnnotation', {
      uris: state.uris,
      title: state.title,
      // 追跡用パラメータなどは除いて記録する
      source: /^https?:/i.test(state.url) ? normalizeUri(state.url) : state.url,
      selector,
      comment,
      path: state.note?.path,
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
    showToast('保存しました');
    return true;
  } catch (e) {
    showToast(`保存できません: ${e instanceof Error ? e.message : e}`, true);
    return false;
  }
}

adder.addEventListener('mousedown', e => e.preventDefault());
$<HTMLButtonElement>('.b-annotate').addEventListener('click', () => openEditor());
$<HTMLButtonElement>('.b-highlight').addEventListener('click', async () => {
  const cap = captureSelection();
  hideAdder();
  if (cap) {
    getSelection()?.removeAllRanges();
    await save(cap.selector, '');
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
  if (e.composedPath().includes(host)) return;
  onSelectionEnd();
});
document.addEventListener('keyup', e => {
  if (e.shiftKey || e.key === 'Shift') onSelectionEnd();
});
document.addEventListener('mousedown', e => {
  if (e.composedPath().includes(host)) return;
  hideAdder();
});

// ---------------------------------------------------------------- マーカー

function updateMarkers() {
  markers.replaceChildren();
  if (!state.anchors.size) return;
  mountHost();
  const docW = document.documentElement.clientWidth;
  const seen = new Set<number>();
  for (const [id, { a, ranges }] of state.anchors) {
    const rect = ranges[0]?.getClientRects()[0];
    if (!rect || (rect.width === 0 && rect.height === 0)) continue;
    const top = Math.round(rect.top + scrollY);
    if (seen.has(top)) continue;
    seen.add(top);
    const m = document.createElement('div');
    m.className = 'marker';
    const idx = styleIndicesForTags(state.styles, a.tags);
    const st = idx.length ? state.styles.tags[idx[0]].style : state.styles.default;
    m.style.setProperty('--c', accentColor(st, matchMedia('(prefers-color-scheme: dark)').matches));
    m.style.top = `${top}px`;
    m.style.left = `${scrollX + docW - 10}px`;
    m.style.height = `${Math.max(12, Math.round(rect.height))}px`;
    m.title = a.comment ? a.comment.slice(0, 200) : quoteOf(a).slice(0, 200);
    m.addEventListener('click', () => {
      focusAnnotation(id, true);
    });
    markers.appendChild(m);
  }
}

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
  const rect = anc.ranges[0].getBoundingClientRect();
  const el = anc.ranges[0].startContainer.parentElement;
  if (rect.height === 0 && el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    scrollTo({ top: rect.top + scrollY - innerHeight / 3, behavior: 'smooth' });
  }
  if (flash) focusAnnotation(id, false);
  return true;
}

// ---------------------------------------------------------------- クリック・ホバー

document.addEventListener('click', e => {
  if (e.composedPath().includes(host)) return;
  if (getSelection()?.isCollapsed === false) return;
  const id = hitTest(e.clientX, e.clientY);
  if (id) focusAnnotation(id, true);
});

let hoverPending = false;
document.addEventListener(
  'mousemove',
  e => {
    if (hoverPending || !state.anchors.size) return;
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
  { passive: true },
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
  resizeTimer = setTimeout(updateMarkers, 200);
});

let lastUrl = '';
setInterval(() => {
  const u = location.href.replace(/#.*$/, '');
  if (u !== lastUrl) {
    lastUrl = u;
    void refreshNote();
  }
}, 1000);

// ---------------------------------------------------------------- メッセージ

chrome.runtime.onMessage.addListener((msg: ContentMessage, _sender, sendResponse) => {
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
        const rect = anc?.ranges[0]?.getBoundingClientRect();
        if (rect && (rect.bottom < 0 || rect.top > innerHeight)) scrollToAnnotation(msg.id, false);
      }
      return false;
    case 'status': {
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
});

// ---------------------------------------------------------------- 起動

async function init() {
  const settings = await loadSettings();
  state.ignore = ignoreSelectors(settings.ignoreSelectors);
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
    new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  try {
    const r = (await chrome.runtime.sendMessage({ kind: 'contentReady' })) as { revealId: string | null };
    if (r?.revealId) scrollToAnnotation(r.revealId, true);
  } catch {
    /* ignore */
  }
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.settings) {
    void loadSettings().then(s => {
      state.ignore = ignoreSelectors(s.ignoreSelectors);
      anchorAll();
    });
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
} else {
  void init();
}
