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
import { rpc, type Broadcast, type ConnectionStatus, type ContentMessage, type PageInfo, type PanelMessage } from './messages.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const titleEl = $('title');
const subEl = $('sub');
const bannerEl = $('banner');
const viewEl = $('view');
const editorEl = $('editor');
const modeBtn = $<HTMLButtonElement>('b-mode');
const obsidianBtn = $<HTMLButtonElement>('b-obsidian');

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
};

// ---------------------------------------------------------------- テーマ

function applyTheme(theme?: ThemeInfo) {
  const root = document.documentElement;
  if (!theme) return;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  root.dataset.theme = theme.dark ? 'dark' : 'light';
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
}

// ---------------------------------------------------------------- ヘッダーとバナー

function renderHeader() {
  const { info, note } = state;
  titleEl.textContent = note?.titles[0] ?? info?.title ?? '—';
  subEl.replaceChildren();
  if (note) {
    subEl.append(note.path);
    const n = note.annotations.length;
    const orphans = info?.orphans.length ?? 0;
    subEl.append(` · 註 ${n}`);
    if (orphans) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = ` · 見つからない註 ${orphans}`;
      subEl.append(w);
    }
  } else if (info) {
    subEl.textContent = info.url;
  }
  if (state.mode === 'edit' && saveStateEl) subEl.append(saveStateEl);
  modeBtn.disabled = !note;
  obsidianBtn.disabled = !note || state.status.state !== 'connected';
  modeBtn.textContent = state.mode === 'edit' ? '表示' : '編集';
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
  d.textContent = text;
  if (extra) d.append(extra);
  viewEl.replaceChildren(d);
}

async function renderView() {
  const seq = ++state.renderSeq;
  const { note, info } = state;
  if (!info) {
    emptyMessage('このページでは使えません（拡張がページに入れないタブです）。');
    return;
  }
  if (!note) {
    const hint = document.createElement('p');
    hint.innerHTML = '本文を選択して表示される「✎ 註」ボタン、右クリックメニュー、または <kbd>Alt+Shift+A</kbd> で註をつけると、<code>annotations/</code> にノートが作られます。';
    emptyMessage('このページの註はまだありません。', hint);
    return;
  }
  let html: string;
  try {
    html = (await rpc('render', { path: note.path })).html;
  } catch (e) {
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
  const scroll = (viewEl.parentElement as HTMLElement).scrollTop;
  viewEl.innerHTML = clean;
  (viewEl.parentElement as HTMLElement).scrollTop = scroll;
  decorateCards();
}

function decorateCards() {
  const orphans = new Set(state.info?.orphans ?? []);
  for (const card of viewEl.querySelectorAll<HTMLElement>('.a08-card[data-annotation-id]')) {
    const id = card.dataset.annotationId!;
    card.classList.toggle('orphan', orphans.has(id));
  }
}

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
  const card = target.closest<HTMLElement>('.a08-card[data-annotation-id]');
  if (card) scrollPageTo(card.dataset.annotationId!);
});

let hovered: string | null = null;
viewEl.addEventListener('mouseover', e => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.a08-card[data-annotation-id]');
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
  const card = viewEl.querySelector<HTMLElement>(`.a08-card[data-annotation-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1500);
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
    const cls = [lines.has(l) ? 'a08-ann-line' : '', flashLine != null && l >= flashLine && l <= flashLine ? 'a08-flash' : '']
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
    viewEl.hidden = false;
    saveStateEl?.remove();
    renderHeader();
    await renderView();
  } else {
    state.mode = 'edit';
    state.baseVersion = state.note.version;
    state.dirty = false;
    viewEl.hidden = true;
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
    viewEl.hidden = false;
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

/** sidepanel.html?tab=<id> で開くと、そのタブに固定する（テスト・デバッグ用） */
const fixedTabId = Number(new URLSearchParams(location.search).get('tab')) || null;

async function loadActiveTab() {
  const [tab] = fixedTabId
    ? [await chrome.tabs.get(fixedTabId).catch(() => undefined)]
    : await chrome.tabs.query({ active: true, currentWindow: true });
  if (state.mode === 'edit') await saveNow();
  state.tabId = tab?.id ?? null;
  let info: PageInfo | null = null;
  if (tab?.id != null) {
    info = (await chrome.tabs.sendMessage(tab.id, { kind: 'pageInfo' } satisfies ContentMessage).catch(() => null)) as PageInfo | null;
  }
  state.info = info;
  let note: NoteView | null = null;
  if (info) {
    try {
      note = info.notePath ? await rpc('getNote', { path: info.notePath }) : await rpc('lookup', { uris: info.uris });
    } catch {
      note = null;
    }
  }
  if (state.mode === 'edit' && note?.path !== state.note?.path) {
    state.mode = 'view';
    editorEl.hidden = true;
    viewEl.hidden = false;
    saveStateEl?.remove();
  }
  setNote(note, true);
}

// ---------------------------------------------------------------- メッセージ

chrome.runtime.onMessage.addListener((msg: Broadcast | PanelMessage, sender) => {
  switch (msg?.kind) {
    case 'status': {
      const was = state.status.state;
      state.status = msg.status;
      applyTheme(msg.status.theme);
      updateBanner();
      renderHeader();
      if (msg.status.state === 'connected' && was !== 'connected') void loadActiveTab();
      break;
    }
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
        void renderView();
      }
      break;
    case 'pageChanged':
      if (sender.tab?.id === state.tabId) {
        const pathChanged = msg.info.notePath !== state.info?.notePath;
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
obsidianBtn.addEventListener('click', () => {
  if (state.note) void rpc('openInObsidian', { path: state.note.path }).catch(e => alert(e.message));
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'e' && state.mode === 'view') {
    e.preventDefault();
    void toggleMode();
  }
});
addEventListener('pagehide', () => void saveNow());

(async () => {
  try {
    state.status = (await chrome.runtime.sendMessage({ kind: 'status' })) as ConnectionStatus;
  } catch {
    state.status = { state: 'disconnected' };
  }
  applyTheme(state.status.theme);
  updateBanner();
  await loadActiveTab();
})();
