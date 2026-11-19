/**
 * サイドパネル。閲覧中のタブに対応するノートを、
 * - 表示モード: Obsidian が描画した HTML
 * - 編集モード: CodeMirror 6 で markdown を直接編集（自動保存）
 * で表示する。
 */
import DOMPurify from 'dompurify';
import { Annotation, EditorState, StateEffect, StateField, RangeSetBuilder, type Extension } from '@codemirror/state';
import { EditorView, keymap, Decoration, type DecorationSet, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { normalizeUri, parseNote, type NoteView, type ThemeInfo } from '@a08/core';
import { isScriptableUrl, rpc, type Broadcast, type ConnectionStatus, type ContentMessage, type PageInfo, type PanelMessage } from './messages.ts';
import { icon, iconHtml } from './icons.ts';
import { FALLBACK_CSS, PANEL_CSS } from './sidepanel-view-css.ts';

const NAME = chrome.i18n.getMessage('extName') || 'Obsidiannot';
const LOG = '[obsidiannot]';
document.title = NAME;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const titleEl = $('title');
const subEl = $('sub');
const bannerEl = $('banner');
const mainEl = $('main');
const viewHost = $('view');
const editorEl = $('editor');
const modeBtn = $<HTMLButtonElement>('b-mode');
const obsidianBtn = $<HTMLButtonElement>('b-obsidian');
const deleteBtn = $<HTMLButtonElement>('b-delete');
deleteBtn.append(icon('trash-2', 17));

/**
 * 表示モードは Shadow DOM の中に Obsidian の CSS と同じ構造で描く
 * （パネルの枠の CSS と混ざらないように）
 */
const viewRoot = viewHost.attachShadow({ mode: 'open' });
viewRoot.innerHTML =
  `<style id="fallback">${FALLBACK_CSS}</style><style id="obsidian"></style><style>${PANEL_CSS}</style>` +
  '<div class="obsidiannot-root" id="root"><div class="obsidiannot-body" id="body">' +
  '<div class="markdown-preview-view markdown-rendered" id="preview">' +
  '<div class="markdown-preview-sizer markdown-preview-section" id="content"></div></div></div></div>';
const viewEl = viewRoot.getElementById('content') as HTMLElement;
const viewBody = viewRoot.getElementById('body') as HTMLElement;
const viewRootEl = viewRoot.getElementById('root') as HTMLElement;
const fallbackStyle = viewRoot.getElementById('fallback') as HTMLStyleElement;
const obsidianStyle = viewRoot.getElementById('obsidian') as HTMLStyleElement;

const state = {
  tabId: null as number | null,
  info: null as PageInfo | null,
  note: null as NoteView | null,
  status: { state: 'connecting' } as ConnectionStatus,
  mode: 'view' as 'view' | 'edit',
  /** 編集中に保存した最後の版 */
  baseVersion: '',
  dirty: false,
  conflict: null as NoteView | null,
  renderSeq: 0,
  /** content script の応答を待っている */
  loading: false,
  /** 拡張が入れないページ（chrome:// など） */
  unsupported: false,
};

// ---------------------------------------------------------------- テーマ

let cssVersion: string | null = null;

function applyTheme(theme?: ThemeInfo) {
  const root = document.documentElement;
  if (!theme) return;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  root.dataset.theme = theme.dark ? 'dark' : 'light';
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  // 次に開いたとき、最初の描画から同じ色にする（theme-boot.js が読む）
  try {
    localStorage.setItem('obsidiannot-theme', JSON.stringify({ dark: theme.dark, vars: theme.vars }));
  } catch {
    /* ignore */
  }
  if (theme.cssVersion && theme.cssVersion !== cssVersion) void loadAppearance(theme.cssVersion);
}

/** Obsidian の CSS 一式（テーマ・スニペット・プラグイン）を取り込む */
async function loadAppearance(version: string) {
  cssVersion = version;
  try {
    const ap = await rpc('appearance', {});
    if (!ap || cssVersion !== version) return;
    obsidianStyle.textContent = ap.css;
    obsidianStyle.media = 'all';
    viewBody.className = `obsidiannot-body ${ap.bodyClass}`;
    // アクセントカラー（--accent-h/s/l）などは Obsidian では body・html のインライン style にある
    viewBody.style.cssText = ap.bodyStyle ?? '';
    viewRootEl.style.cssText = ap.rootStyle ?? '';
    fallbackStyle.media = 'not all';
    obsidianCssOff = false;
    checkVisible();
  } catch (e) {
    console.error(LOG, 'appearance', e);
    cssVersion = null;
  }
}

let obsidianCssOff = false;

/**
 * Obsidian の CSS で本文が見えなくなっていないかを確かめ、見えなければ簡易表示に戻す
 * （テーマやスニペットが画面全体のレイアウトを前提にしている場合の保険）
 */
function checkVisible() {
  if (obsidianCssOff || obsidianStyle.media === 'not all') return;
  requestAnimationFrame(() => {
    const first = viewEl.firstElementChild as HTMLElement | null;
    if (!first || viewHost.hidden) return;
    const r = viewEl.getBoundingClientRect();
    const cs = getComputedStyle(first);
    const hidden =
      r.height < 1 ||
      r.width < 1 ||
      cs.visibility === 'hidden' ||
      cs.display === 'none' ||
      Number(cs.opacity) < 0.05;
    if (hidden) {
      console.warn(LOG, 'Obsidian の CSS で本文が見えないため、簡易表示に切り替えます', {
        rect: r.toJSON(),
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
      });
      obsidianCssOff = true;
      obsidianStyle.media = 'not all';
      fallbackStyle.media = 'all';
    }
  });
}

// ---------------------------------------------------------------- vault 内の画像

const resourceUrls = new Map<string, Promise<string | null>>();

function resourceUrl(path: string): Promise<string | null> {
  let p = resourceUrls.get(path);
  if (!p) {
    p = rpc('getResource', { path }).then(
      r => {
        const bin = atob(r.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return URL.createObjectURL(new Blob([bytes], { type: r.mime }));
      },
      () => {
        resourceUrls.delete(path);
        return null;
      },
    );
    resourceUrls.set(path, p);
  }
  return p;
}

function loadResources() {
  for (const img of viewEl.querySelectorAll<HTMLImageElement>('img[data-obsidiannot-resource]')) {
    const path = img.dataset.obsidiannotResource!;
    void resourceUrl(path).then(u => {
      if (u) img.src = u;
    });
  }
}

// ---------------------------------------------------------------- ヘッダーとバナー

function renderHeader() {
  const { info, note } = state;
  // ボタンを先に更新する（下の処理で失敗しても状態がずれないように）
  modeBtn.disabled = !note;
  obsidianBtn.disabled = !note;
  deleteBtn.disabled = !note;
  // Obsidian と同じく、押すと切り替わる先のアイコンを出す
  const edit = state.mode === 'edit';
  const want = edit ? 'book-open' : 'pen-line';
  if (modeBtn.dataset.icon !== want) {
    modeBtn.replaceChildren(icon(want, 18));
    modeBtn.dataset.icon = want;
  }
  modeBtn.title = edit ? '表示に切り替え（Ctrl+E）' : '編集に切り替え（Ctrl+E）';
  try {
    titleEl.textContent = note?.titles?.[0] ?? info?.title ?? NAME;
    if (renaming) return;
    subEl.replaceChildren();
    if (note) {
      subEl.append(fileNameButton(note));
      const n = note.annotations?.length ?? 0;
      const orphans = info?.orphans?.length ?? 0;
      subEl.append(` · 註 ${n}`);
      if (orphans) {
        const w = document.createElement('span');
        w.className = 'warn';
        w.textContent = ` · 見つからない註 ${orphans}`;
        subEl.append(w);
      }
    } else if (info) {
      // URL がとても長いサイトがあるので、短くして表示する（全体はツールチップ）
      const u = document.createElement('span');
      u.className = 'url';
      u.textContent = shortUrl(info.url);
      u.title = info.url;
      subEl.append(u);
    }
    if (edit && saveStateEl) subEl.append(saveStateEl);
  } catch (e) {
    console.error(LOG, 'renderHeader', e);
  }
}

function shortUrl(url: string, max = 80): string {
  let s = url;
  try {
    const u = new URL(url);
    s = `${u.host}${decodeURI(u.pathname)}${u.search}`;
  } catch {
    /* そのまま */
  }
  return [...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s;
}

// ---------------------------------------------------------------- ファイル名の変更

let renaming = false;

function baseName(path: string): string {
  return path.split('/').pop()!.replace(/\.md$/, '');
}

function fileNameButton(note: NoteView): HTMLElement {
  const b = document.createElement('button');
  b.className = 'filename';
  b.title = `${note.path}（クリックで名前を変更）`;
  b.append(baseName(note.path), icon('pencil', 12));
  b.addEventListener('click', () => startRename());
  return b;
}

function startRename() {
  const note = state.note;
  if (!note || renaming) return;
  renaming = true;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = baseName(note.path);
  input.spellcheck = false;
  let done = false;
  const finish = async (commit: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name && name !== baseName(note.path)) {
      try {
        const r = await rpc('renameNote', { path: note.path, name });
        renaming = false;
        setNote(r.note, state.mode !== 'edit');
        return;
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    }
    renaming = false;
    renderHeader();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void finish(true);
    } else if (e.key === 'Escape') {
      void finish(false);
    }
  });
  input.addEventListener('blur', () => void finish(true));
  subEl.replaceChildren(input);
  input.focus();
  input.select();
}

function showBanner(content: (string | Node)[] | null, error = false) {
  if (!content) {
    bannerEl.hidden = true;
    bannerEl.replaceChildren();
    return;
  }
  bannerEl.hidden = false;
  bannerEl.classList.toggle('error', error);
  bannerEl.replaceChildren(...content);
}

function button(text: string, onClick: () => void, primary = false) {
  const b = document.createElement('button');
  b.textContent = text;
  if (primary) b.className = 'primary';
  b.addEventListener('click', onClick);
  return b;
}

function updateBanner() {
  if (state.conflict) {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(
      button('Obsidian の内容を読み込む（編集を破棄）', () => {
        const n = state.conflict!;
        state.conflict = null;
        state.dirty = false;
        setNote(n, true);
      }, true),
      button('このまま上書き保存', () => {
        state.baseVersion = state.conflict!.version;
        state.conflict = null;
        void saveNow();
      }),
    );
    showBanner(['ノートが Obsidian 側でも変更されました。', row], true);
    return;
  }
  const st = state.status;
  if (st.state === 'connected') {
    showBanner(null);
    return;
  }
  const row = document.createElement('div');
  row.className = 'row';
  row.append(
    button('再接続', () => chrome.runtime.sendMessage({ kind: 'reconnect' }).catch(() => undefined)),
    button('設定', () => chrome.runtime.openOptionsPage()),
  );
  const msg =
    st.state === 'no-token'
      ? '接続トークンが未設定です。Obsidian のプラグイン設定からトークンをコピーし、拡張の設定に貼り付けてください。'
      : st.state === 'connecting'
        ? 'Obsidian に接続しています…'
        : st.error ?? 'Obsidian に接続されていません。';
  showBanner([msg, row], st.state !== 'connecting');
}

// ---------------------------------------------------------------- 表示モード

function emptyMessage(text: string, extra?: Node) {
  const d = document.createElement('div');
  d.className = 'empty';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.textContent = NAME;
  d.append(brand, text);
  if (extra) d.append(extra);
  viewEl.replaceChildren(d);
}

/** いま表示している描画（ノートのパスと版）。同じなら描き直さない */
let renderedKey: string | null = null;

async function renderView(force = false) {
  const { note, info } = state;
  const key = note && info ? `${note.path}@${note.version}` : null;
  if (!force && key && key === renderedKey) {
    decorateCards();
    return;
  }
  const seq = ++state.renderSeq;
  renderedKey = null;
  if (!info) {
    emptyMessage(
      state.unsupported
        ? 'このページでは註をつけられません。'
        : state.loading
          ? 'ページを読み込んでいます…'
          : 'このページには接続できません。ページを再読み込みしてください。',
    );
    viewEl.querySelector('.empty')?.classList.toggle('quiet', state.unsupported);
    return;
  }
  if (!note) {
    const hint = document.createElement('p');
    const folder = state.status.folder ?? 'obsidiannot';
    hint.innerHTML =
      `本文を選択すると出る ${iconHtml('message-square-quote', 16)}（註）か ${iconHtml('star', 16)}（照）で、` +
      `<code></code> にノートが作られます。`;
    hint.querySelector('code')!.textContent = `${folder}/`;
    const create = document.createElement('button');
    create.className = 'create';
    create.append(icon('file-plus', 16), '空のノートを作る');
    create.title = 'このページの URI を持つノートを作り、編集を始めます';
    create.addEventListener('click', () => void createEmptyNote());
    const box = document.createElement('div');
    box.append(hint, create);
    emptyMessage('このページの註はまだありません。', box);
    return;
  }
  let html: string;
  try {
    html = (await rpc('render', { path: note.path })).html;
  } catch (e) {
    console.error(LOG, 'render', e);
    if (seq !== state.renderSeq) return;
    // 描画できないときは markdown をそのまま出す
    const pre = document.createElement('pre');
    pre.textContent = note.content;
    viewEl.replaceChildren(pre);
    return;
  }
  if (seq !== state.renderSeq) return;
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-href', 'data-annotation-id', 'data-tags', 'target'],
    FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
  });
  const scroll = mainEl.scrollTop;
  viewEl.innerHTML = clean;
  mainEl.scrollTop = scroll;
  renderedKey = key;
  decorateCards();
  loadResources();
  checkVisible();
}

function decorateCards() {
  const orphans = new Set(state.info?.orphans ?? []);
  const flashing = flash && flash.until > Date.now() ? flash.id : null;
  for (const card of viewEl.querySelectorAll<HTMLElement>('.obsidiannot-card[data-annotation-id]')) {
    const id = card.dataset.annotationId!;
    card.classList.toggle('orphan', orphans.has(id));
    card.classList.toggle('flash', id === flashing);
  }
}

/** 強調中のカード（描き直しても強調が消えないように） */
let flash: { id: string; until: number } | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

viewEl.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  const a = target.closest('a');
  if (a) {
    e.preventDefault();
    const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
    if (a.classList.contains('internal-link') && state.note) {
      void rpc('openLink', { link: href, sourcePath: state.note.path }).catch(err => alert(err.message));
    } else if (a.classList.contains('tag')) {
      // タグは何もしない
    } else if (/^https?:/i.test(href)) {
      void chrome.tabs.create({ url: href });
    }
    return;
  }
  const card = target.closest<HTMLElement>('.obsidiannot-card[data-annotation-id]');
  if (card) {
    // Obsidian 側のカードのクリック処理（ブラウザで開く）は Obsidian でしか動かないので、ここで扱う
    e.preventDefault();
    scrollPageTo(card.dataset.annotationId!);
  }
});

let hovered: string | null = null;
viewEl.addEventListener('mouseover', e => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.obsidiannot-card[data-annotation-id]');
  const id = card?.dataset.annotationId ?? null;
  if (id === hovered) return;
  hovered = id;
  if (state.tabId != null) {
    chrome.tabs.sendMessage(state.tabId, { kind: 'hoverAnnotation', id } satisfies ContentMessage).catch(() => undefined);
  }
});
viewEl.addEventListener('mouseleave', () => {
  hovered = null;
  if (state.tabId != null) {
    chrome.tabs.sendMessage(state.tabId, { kind: 'hoverAnnotation', id: null } satisfies ContentMessage).catch(() => undefined);
  }
});

function scrollPageTo(id: string) {
  if (state.tabId == null) return;
  chrome.tabs.sendMessage(state.tabId, { kind: 'scrollTo', id, flash: true } satisfies ContentMessage).catch(() => undefined);
}

function focusCard(id: string) {
  if (state.mode === 'edit') {
    focusEditorAnnotation(id);
    return;
  }
  flash = { id, until: Date.now() + 1500 };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash = null;
    decorateCards();
  }, 1500);
  decorateCards();
  const card = viewEl.querySelector<HTMLElement>(`.obsidiannot-card[data-annotation-id="${CSS.escape(id)}"]`);
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------------------------------------------------------------- 編集モード

const flashEffect = StateEffect.define<number | null>();
const annLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let flashLine: number | null | undefined;
    for (const e of tr.effects) if (e.is(flashEffect)) flashLine = e.value;
    if (!tr.docChanged && flashLine === undefined) return deco.map(tr.changes);
    return buildAnnDecorations(tr.state, flashLine ?? null);
  },
  provide: f => EditorView.decorations.from(f),
});

function buildAnnDecorations(st: EditorState, flashLine: number | null): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const parsed = parseNote(st.doc.toString());
  const lines = new Set<number>();
  for (const a of parsed.annotations) for (let l = a.startLine; l <= a.endLine; l++) lines.add(l);
  for (let l = 0; l < st.doc.lines; l++) {
    const cls = [lines.has(l) ? 'obsidiannot-ann-line' : '', flashLine != null && l >= flashLine && l <= flashLine ? 'obsidiannot-flash' : '']
      .filter(Boolean)
      .join(' ');
    if (cls) {
      const line = st.doc.line(l + 1);
      b.add(line.from, line.from, Decoration.line({ class: cls }));
    }
  }
  return b.finish();
}

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.3em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.15em', fontWeight: '700' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--link)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--mono)' },
  { tag: [t.processingInstruction, t.meta], color: 'var(--faint)' },
  { tag: t.quote, color: 'var(--muted)' },
]);

const editorTheme = EditorView.theme({
  '&': { color: 'var(--fg)', backgroundColor: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--fg)' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--text-selection, color-mix(in srgb, var(--accent) 25%, transparent)) !important',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
});

let view: EditorView | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | null = null;
/** 最後に保存要求を送った内容 */
let lastSentContent: string | null = null;

function editorExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    markdown(),
    syntaxHighlighting(mdHighlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    editorTheme,
    annLines,
    keymap.of([
      { key: 'Mod-s', run: () => (void saveNow(), true) },
      { key: 'Mod-e', run: () => (toggleMode(), true) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of(u => {
      if (u.docChanged && !u.transactions.some(tr => tr.annotation(remoteUpdate))) {
        state.dirty = true;
        setSaveState('未保存');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void saveNow(), 800);
      }
    }),
  ];
}

const remoteUpdate = Annotation.define<boolean>();

function ensureEditor(content: string) {
  if (!view) {
    view = new EditorView({
      parent: editorEl,
      state: EditorState.create({ doc: content, extensions: editorExtensions() }),
    });
    view.dispatch({ effects: flashEffect.of(null) });
    return;
  }
  if (view.state.doc.toString() !== content) {
    const sel = view.state.selection.main;
    const len = content.length;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: Math.min(sel.anchor, len), head: Math.min(sel.head, len) },
      annotations: remoteUpdate.of(true),
    });
  }
}

let saveStateEl: HTMLSpanElement | null = null;
function setSaveState(text: string) {
  if (!saveStateEl) {
    saveStateEl = document.createElement('span');
    saveStateEl.className = 'save-state';
  }
  saveStateEl.textContent = text;
  if (state.mode === 'edit' && !saveStateEl.isConnected) subEl.append(saveStateEl);
}

async function saveNow(): Promise<void> {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!view || !state.note || !state.dirty || state.conflict) return;
  const content = view.state.doc.toString();
  const path = state.note.path;
  lastSentContent = content;
  saving = (async () => {
    setSaveState('保存中…');
    try {
      const { note } = await rpc('saveNote', { path, content, baseVersion: state.baseVersion });
      state.baseVersion = note.version;
      state.note = note;
      if (view.state.doc.toString() === content) state.dirty = false;
      setSaveState(state.dirty ? '未保存' : '保存済み');
    } catch (e) {
      const err = e as Error & { code?: string; data?: NoteView };
      if (err.code === 'conflict' && err.data) {
        state.conflict = err.data;
        updateBanner();
        setSaveState('競合');
      } else {
        setSaveState(`保存できません: ${err.message}`);
      }
    } finally {
      saving = null;
    }
  })();
  return saving;
}

function focusEditorAnnotation(id: string) {
  if (!view) return;
  const a = parseNote(view.state.doc.toString()).annotations.find(x => x.id === id);
  if (!a) return;
  // コメントの先頭（なければブロックの次の行）にカーソルを置く
  const lineNo = Math.min(view.state.doc.lines, a.endLine + 1);
  const line = view.state.doc.line(lineNo);
  view.dispatch({
    selection: { anchor: line.to },
    effects: [EditorView.scrollIntoView(line.from, { y: 'center' }), flashEffect.of(a.startLine)],
  });
  view.focus();
  setTimeout(() => view?.dispatch({ effects: flashEffect.of(null) }), 1200);
}

async function toggleMode() {
  if (!state.note) return;
  if (state.mode === 'edit') {
    await saveNow();
    state.mode = 'view';
    editorEl.hidden = true;
    viewHost.hidden = false;
    saveStateEl?.remove();
    renderHeader();
    await renderView();
  } else {
    state.mode = 'edit';
    state.baseVersion = state.note.version;
    state.dirty = false;
    viewHost.hidden = true;
    editorEl.hidden = false;
    ensureEditor(state.note.content);
    renderHeader();
    setSaveState('保存済み');
    view?.focus();
  }
}

// ---------------------------------------------------------------- ノートの更新

/** ノートを差し替える。force は編集中の未保存内容を捨てる */
function setNote(note: NoteView | null, force = false) {
  const prevPath = state.note?.path;
  if (state.mode === 'edit' && note && prevPath === note.path && !force) {
    if (note.version === state.baseVersion) return;
    // 自分が保存した内容の通知（応答より先に届くことがある）
    const doc = view?.state.doc.toString();
    if (note.content === lastSentContent || note.content === doc) {
      state.note = note;
      state.baseVersion = note.version;
      if (note.content === doc) {
        state.dirty = false;
        setSaveState('保存済み');
      }
      renderHeader();
      return;
    }
    if (state.dirty) {
      // 自分の保存結果でなく、未保存の編集がある → 競合
      state.conflict = note;
      updateBanner();
      return;
    }
    state.note = note;
    state.baseVersion = note.version;
    ensureEditor(note.content);
    renderHeader();
    return;
  }
  state.note = note;
  if (!note && state.mode === 'edit') {
    state.mode = 'view';
    editorEl.hidden = true;
    viewHost.hidden = false;
  }
  if (state.mode === 'edit' && note) {
    state.baseVersion = note.version;
    state.dirty = false;
    ensureEditor(note.content);
  }
  renderHeader();
  updateBanner();
  if (state.mode === 'view') void renderView();
}

async function pageInfoOf(tabId: number): Promise<PageInfo | null> {
  return (await chrome.tabs.sendMessage(tabId, { kind: 'pageInfo' } satisfies ContentMessage).catch(() => null)) as PageInfo | null;
}

/** sidepanel.html?tab=<id> で開くと、そのタブに固定する（テスト・デバッグ用） */
const fixedTabId = Number(new URLSearchParams(location.search).get('tab')) || null;
/** sidepanel.html?window=<id> で開くと、そのウィンドウのアクティブなタブを追う（テスト用） */
const fixedWindowId = Number(new URLSearchParams(location.search).get('window')) || null;

let loadSeq = 0;

/** 状態（接続など）を background に聞き直す。つながっていなければ接続も試みる */
async function refreshStatus() {
  try {
    const st = (await chrome.runtime.sendMessage({ kind: 'status' })) as ConnectionStatus | undefined;
    if (st) applyStatus(st);
  } catch {
    /* background の起動待ち */
  }
}

/**
 * 閲覧中のタブのノートを読み直す。
 * 呼ばれるたびに番号を振り、最後に呼ばれたものの結果だけを使う（タブを素早く切り替えたとき用）。
 */
async function loadActiveTab() {
  const seq = ++loadSeq;
  const stale = () => seq !== loadSeq;
  const [tab] = fixedTabId
    ? [await chrome.tabs.get(fixedTabId).catch(() => undefined)]
    : await chrome.tabs.query(fixedWindowId ? { active: true, windowId: fixedWindowId } : { active: true, currentWindow: true });
  if (stale()) return;
  if (state.mode === 'edit') await saveNow();
  if (stale()) return;
  const tabChanged = state.tabId !== (tab?.id ?? null);
  state.tabId = tab?.id ?? null;
  state.unsupported = !isScriptableUrl(tab?.url ?? tab?.pendingUrl);
  void refreshStatus();

  let info: PageInfo | null = null;
  if (tab?.id != null && isScriptableUrl(tab.url)) {
    info = await pageInfoOf(tab.id);
    if (!info) {
      // 読み込み途中、または content script がいない（拡張の読み込み前から開いていたタブなど）
      state.loading = true;
      if (tabChanged) {
        state.info = null;
        setNote(null, true);
      }
      let injected = false;
      for (let i = 0; i < 25 && !info; i++) {
        await new Promise(r => setTimeout(r, i < 5 ? 150 : 400));
        if (stale()) return;
        const t = await chrome.tabs.get(tab.id).catch(() => undefined);
        if (!t || !isScriptableUrl(t.url)) break;
        if (!injected && t.status === 'complete' && i >= 2) {
          injected = true;
          await chrome.runtime.sendMessage({ kind: 'ensureContent', tabId: tab.id }).catch(() => false);
        }
        info = await pageInfoOf(tab.id);
      }
      if (stale()) return;
      state.loading = false;
    }
  }
  state.info = info;
  let note: NoteView | null = null;
  if (info) {
    try {
      note = info.notePath ? await rpc('getNote', { path: info.notePath }) : await rpc('lookup', { uris: info.uris });
    } catch (e) {
      console.warn(LOG, 'lookup', e);
      note = null;
    }
  }
  if (stale()) return;
  if (state.mode === 'edit' && note?.path !== state.note?.path) {
    state.mode = 'view';
    editorEl.hidden = true;
    viewHost.hidden = false;
    saveStateEl?.remove();
  }
  setNote(note, true);
}

// ---------------------------------------------------------------- メッセージ

function applyStatus(st: ConnectionStatus | undefined) {
  if (!st?.state) return;
  const was = state.status.state;
  state.status = st;
  applyTheme(st.theme);
  updateBanner();
  renderHeader();
  if (st.state === 'connected' && was !== 'connected') void loadActiveTab();
}

chrome.runtime.onMessage.addListener((msg: Broadcast | PanelMessage, sender) => {
  switch (msg?.kind) {
    case 'statusChanged':
      if (msg.status) applyStatus(msg.status);
      break;
    case 'event':
      if (msg.event === 'noteChanged') {
        const { path, note } = msg.data as { path: string; note: NoteView | null };
        if (state.note?.path === path) {
          if (note) setNote(note);
          else void loadActiveTab();
        } else if (!state.note && note && state.info) {
          const here = new Set(state.info.uris.map(normalizeUri));
          if (note.uris.some(u => here.has(normalizeUri(u)))) setNote(note);
        }
      } else if (msg.event === 'themeChanged') {
        applyTheme((msg.data as { theme: ThemeInfo }).theme);
      } else if (msg.event === 'stylesChanged' && state.mode === 'view') {
        void renderView(true);
      }
      break;
    case 'pageChanged':
      if (sender.tab?.id === state.tabId) {
        // 読み込みを待っている間に content script が準備できた場合も読み直す
        const pathChanged = !state.info || msg.info.notePath !== state.info.notePath;
        state.info = msg.info;
        if (pathChanged) void loadActiveTab();
        else {
          renderHeader();
          decorateCards();
        }
      }
      break;
    case 'focusAnnotation':
      if (sender.tab?.id === state.tabId) {
        if (state.note?.path !== msg.path) void loadActiveTab().then(() => setTimeout(() => focusCard(msg.id), 300));
        else focusCard(msg.id);
      }
      break;
  }
  return false;
});

chrome.tabs.onActivated.addListener(() => void loadActiveTab());
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === state.tabId && (change.status === 'complete' || change.url)) void loadActiveTab();
});
chrome.windows.onFocusChanged.addListener(() => void loadActiveTab());

modeBtn.addEventListener('click', () => void toggleMode());
async function createEmptyNote() {
  const info = state.info;
  if (!info) return;
  try {
    const { note } = await rpc('createNote', { uris: info.uris, title: info.title });
    setNote(note, true);
    if (state.mode !== 'edit') await toggleMode();
  } catch (e) {
    alert(`ノートを作れません: ${e instanceof Error ? e.message : e}`);
  }
}

deleteBtn.addEventListener('click', async () => {
  const note = state.note;
  if (!note) return;
  const n = note.annotations.length;
  const msg =
    `ノート「${baseName(note.path)}」を削除しますか？` +
    (n ? `\n註 ${n} 件も消え、ページのハイライトもなくなります。` : '') +
    '\nObsidian の「削除したファイル」の設定（ゴミ箱など）に従います。';
  if (!confirm(msg)) return;
  try {
    if (state.mode === 'edit') {
      clearTimeout(saveTimer);
      state.dirty = false;
    }
    await rpc('deleteNote', { path: note.path });
    saveStateEl?.remove();
    // 編集中なら閲覧表示に戻る（setNote が行う）
    setNote(null, true);
  } catch (e) {
    alert(`削除できません: ${e instanceof Error ? e.message : e}`);
  }
});

obsidianBtn.addEventListener('click', () => {
  if (state.note) void rpc('openInObsidian', { path: state.note.path }).catch(e => alert(e.message));
});
addEventListener('error', e => console.error(LOG, e.error ?? e.message));
addEventListener('unhandledrejection', e => console.error(LOG, e.reason));
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'e' && state.mode === 'view') {
    e.preventDefault();
    void toggleMode();
  }
});
addEventListener('pagehide', () => void saveNow());
// パネルが再び見えたとき（閉じて開いた・ウィンドウを切り替えた）は読み直す
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void loadActiveTab();
});

(async () => {
  await refreshStatus();
  updateBanner();
  await loadActiveTab();
})();
