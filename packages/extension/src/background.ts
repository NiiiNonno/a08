/**
 * service worker。Obsidian プラグインとの WebSocket 接続を一本持ち、
 * content script とサイドパネルからの要求を中継する。
 */
import { PROTOCOL_VERSION, normalizeUri, type EventMap, type Request, type RequestMap, type RequestType, type Response, type ServerEvent } from '@a08/core';
import { isScriptableUrl, loadSettings, type BgMessage, type Broadcast, type ConnectionStatus, type ContentMessage, type RpcReply } from './messages.ts';

const NAME = chrome.i18n.getMessage('extName') || 'Obsidiannot';

let ws: WebSocket | null = null;
let status: ConnectionStatus = { state: 'disconnected' };
let nextId = 1;
const pending = new Map<number, { resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> }>();
let connectPromise: Promise<void> | null = null;
let retryDelay = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

/** reveal で新しく開いたタブ → スクロールすべき註 */
const pendingReveal = new Map<number, string>();

function setStatus(s: ConnectionStatus) {
  status = s;
  void broadcast({ kind: 'statusChanged', status });
  void chrome.action.setBadgeText({ text: s.state === 'connected' ? '' : '!' });
  void chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  void chrome.action.setTitle({
    title: s.state === 'connected' ? `${NAME}（${s.vault}）` : `${NAME}（未接続: ${s.error ?? s.state}）`,
  });
}

async function broadcast(msg: Broadcast) {
  // サイドパネル・設定画面
  chrome.runtime.sendMessage(msg).catch(() => undefined);
  // 各タブの content script
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id != null && isScriptableUrl(t.url)) {
      chrome.tabs.sendMessage(t.id, msg).catch(() => undefined);
    }
  }
}

function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}

function connect(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return connectPromise ?? Promise.resolve();
  }
  connectPromise = (async () => {
    const settings = await loadSettings();
    if (!settings.token) {
      setStatus({ state: 'no-token', error: '設定画面で接続トークンを入力してください' });
      return;
    }
    setStatus({ ...status, state: 'connecting' });
    const url = `ws://127.0.0.1:${settings.port}/?token=${encodeURIComponent(settings.token)}`;
    await new Promise<void>(resolve => {
      let opened = false;
      const sock = new WebSocket(url);
      ws = sock;
      sock.onopen = async () => {
        opened = true;
        retryDelay = 1000;
        try {
          const hello = await request('hello', { client: 'chrome-extension', version: PROTOCOL_VERSION });
          setStatus({ state: 'connected', vault: hello.vault, folder: hello.folder, styles: hello.styles, theme: hello.theme });
        } catch (e) {
          setStatus({ state: 'disconnected', error: String(e) });
        }
        if (pingTimer) clearInterval(pingTimer);
        // 20 秒ごとに通信して service worker を生かしておく
        pingTimer = setInterval(() => {
          if (sock.readyState === WebSocket.OPEN) void request('ping', {}).catch(() => undefined);
        }, 20000);
        resolve();
      };
      sock.onmessage = ev => onServerMessage(String(ev.data));
      sock.onclose = ev => {
        if (ws === sock) ws = null;
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          p.resolve({ id, ok: false, error: { code: 'disconnected', message: 'Obsidian との接続が切れました' } });
        }
        pending.clear();
        if (!opened) {
          // 401 は close code では区別できないので、接続できなかったことだけ伝える
          setStatus({
            state: 'disconnected',
            error: `Obsidian に接続できません（ポート ${settings.port}）。Obsidian とプラグインが起動しているか、トークンが正しいか確認してください。`,
          });
        } else {
          setStatus({ state: 'disconnected', error: `接続が切れました (${ev.code})` });
        }
        scheduleReconnect();
        resolve();
      };
      sock.onerror = () => {
        /* onclose で処理 */
      };
    });
  })().finally(() => {
    connectPromise = null;
  });
  return connectPromise;
}

function onServerMessage(raw: string) {
  let msg: Response | ServerEvent;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if ('id' in msg) {
    const p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    }
    return;
  }
  if (msg.event === 'reveal') {
    void reveal(msg.data as EventMap['reveal']);
    return;
  }
  if (msg.event === 'stylesChanged') {
    status = { ...status, styles: (msg.data as EventMap['stylesChanged']).styles };
  } else if (msg.event === 'themeChanged') {
    status = { ...status, theme: (msg.data as EventMap['themeChanged']).theme };
  }
  void broadcast({ kind: 'event', event: msg.event, data: msg.data });
}

async function request<T extends RequestType>(type: T, params: RequestMap[T]['params'], timeoutMs = 15000): Promise<RequestMap[T]['result']> {
  const res = await requestRaw(type, params, timeoutMs);
  if (!res.ok) throw Object.assign(new Error(res.error.message), res.error);
  return res.result as RequestMap[T]['result'];
}

async function requestRaw(type: RequestType, params: unknown, timeoutMs = 15000): Promise<Response> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (type !== 'hello') await connect();
  }
  const sock = ws;
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    return { id: 0, ok: false, error: { code: 'disconnected', message: status.error ?? 'Obsidian に接続されていません' } };
  }
  const id = nextId++;
  return new Promise<Response>(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, ok: false, error: { code: 'timeout', message: 'Obsidian からの応答がありません' } });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    sock.send(JSON.stringify({ id, type, params: params as never } satisfies Request));
  });
}

/** Obsidian で註がクリックされたとき: 既存タブを前面に出してスクロール */
async function reveal(data: EventMap['reveal']) {
  const wanted = new Set([data.source, ...data.uris].filter(Boolean).map(normalizeUri));
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter(t => t.id != null && t.url && wanted.has(normalizeUri(t.url)));
  // 最後にフォーカスしたウィンドウのアクティブタブを優先
  const lastWin = await chrome.windows.getLastFocused().catch(() => null);
  candidates.sort((a, b) => {
    const score = (t: chrome.tabs.Tab) => (t.windowId === lastWin?.id ? 2 : 0) + (t.active ? 1 : 0);
    return score(b) - score(a);
  });
  const tab = candidates[0];
  if (tab?.id != null) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    const ok = await chrome.tabs
      .sendMessage(tab.id, { kind: 'scrollTo', id: data.id, flash: true } satisfies ContentMessage)
      .catch(() => null);
    if (ok == null) pendingReveal.set(tab.id, data.id);
    return;
  }
  const url = data.url || data.source || data.uris[0];
  if (!url) return;
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id != null) pendingReveal.set(created.id, data.id);
  if (created.windowId != null) await chrome.windows.update(created.windowId, { focused: true });
}

// ---------------------------------------------------------------- サイドパネル
//
// サイドパネルはウィンドウに 1 つだけ（タブ別の設定は使わない）。
// タブ別に setOptions すると Chrome がタブごとに別のパネルを作り、裏に回ったパネルが止まって
// 表示が古いまま・「接続できません」のまま、切り替え時に白く光る、といった不具合になった。
// 拡張が入れないページでは、パネル内に控えめな表示を出すだけにする。

// ---------------------------------------------------------------- content script の注入

/** 拡張の読み込み前から開いていたタブなどに content script を入れる */
async function injectContent(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch {
    return false;
  }
}

async function injectAll() {
  for (const t of await chrome.tabs.query({})) {
    if (t.id != null && isScriptableUrl(t.url) && t.status === 'complete') {
      const alive = await chrome.tabs.sendMessage(t.id, { kind: 'pageInfo' } satisfies ContentMessage).catch(() => null);
      if (!alive) await injectContent(t.id);
    }
  }
}

// ---------------------------------------------------------------- クリップボード

let offscreenReady: Promise<void> | null = null;
async function copyText(text: string): Promise<boolean> {
  offscreenReady ??= (async () => {
    const has = await chrome.offscreen.hasDocument?.().catch(() => false);
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Copy a link to the annotation',
      });
    }
  })().catch(e => {
    offscreenReady = null;
    throw e;
  });
  await offscreenReady;
  return Boolean(await chrome.runtime.sendMessage({ kind: 'offscreenCopy', text }));
}

chrome.runtime.onMessage.addListener((msg: BgMessage, sender, sendResponse) => {
  switch (msg?.kind) {
    case 'ensureContent':
      injectContent(msg.tabId).then(sendResponse);
      return true;
    case 'copyText':
      copyText(msg.text).then(sendResponse, () => sendResponse(false));
      return true;
    case 'rpc':
      requestRaw(msg.type, msg.params).then(res => {
        const reply: RpcReply = res.ok ? { ok: true, result: res.result as never } : { ok: false, error: res.error };
        sendResponse(reply);
      });
      return true;
    case 'status':
      if (status.state !== 'connected') void connect();
      sendResponse(status);
      return false;
    case 'reconnect':
      ws?.close();
      ws = null;
      retryDelay = 1000;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      connect().then(() => sendResponse(status));
      return true;
    case 'contentReady': {
      const tabId = sender.tab?.id;
      const id = tabId != null ? pendingReveal.get(tabId) : undefined;
      if (tabId != null) pendingReveal.delete(tabId);
      sendResponse({ revealId: id ?? null });
      return false;
    }
    case 'openSidePanel': {
      const tab = sender.tab;
      if (tab?.windowId != null) {
        chrome.sidePanel.open({ windowId: tab.windowId }).then(
          () => sendResponse(true),
          () => sendResponse(false),
        );
        return true;
      }
      sendResponse(false);
      return false;
    }
  }
  return false;
});

chrome.tabs.onRemoved.addListener(id => pendingReveal.delete(id));

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'annotate-selection') return;
  const t = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (t?.id == null) return;
  // ショートカットはユーザー操作なのでサイドパネルを開ける
  if (t.windowId != null) chrome.sidePanel.open({ windowId: t.windowId }).catch(() => undefined);
  chrome.tabs.sendMessage(t.id, { kind: 'annotateSelection' } satisfies ContentMessage).catch(() => undefined);
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'obsidiannot-annotate' || tab?.id == null) return;
  if (tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  chrome.tabs.sendMessage(tab.id, { kind: 'annotateSelection' } satisfies ContentMessage).catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(async details => {
  chrome.contextMenus.create({
    id: 'obsidiannot-annotate',
    title: chrome.i18n.getMessage('annotateSelection') || 'Annotate selection',
    contexts: ['selection'],
  });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  await injectAll();
  const s = await loadSettings();
  if (details.reason === 'install' && !s.token) await chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.settings) {
    ws?.close();
    ws = null;
    retryDelay = 1000;
    void connect();
  }
});

chrome.alarms.create('obsidiannot-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'obsidiannot-keepalive' && (!ws || ws.readyState === WebSocket.CLOSED)) void connect();
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
void connect();
