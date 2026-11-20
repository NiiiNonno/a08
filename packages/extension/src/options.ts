import { loadSettings, type Broadcast, type ConnectionStatus, type Settings } from './messages.ts';

const token = document.getElementById('token') as HTMLInputElement;
const port = document.getElementById('port') as HTMLInputElement;
const ignore = document.getElementById('ignore') as HTMLTextAreaElement;
const name = chrome.i18n.getMessage('extName');
document.title = `${name} — 設定`;
document.getElementById('heading')!.textContent = `${name} — 設定`;
const statusEl = document.getElementById('status')!;

function showStatus(st: ConnectionStatus | undefined) {
  if (!st) return;
  statusEl.className = st.state === 'connected' ? 'ok' : st.state === 'connecting' ? '' : 'ng';
  statusEl.textContent =
    st.state === 'connected' ? `接続しました（vault: ${st.vault} / フォルダ: ${st.folder}）` :
    st.state === 'connecting' ? '接続中…' :
    st.error ?? '未接続';
}

(async () => {
  const s = await loadSettings();
  token.value = s.token;
  port.value = String(s.port);
  ignore.value = s.ignoreSelectors.join('\n');
  showStatus(await chrome.runtime.sendMessage({ kind: 'status' }));
})();

document.getElementById('save')!.addEventListener('click', async () => {
  const settings: Settings = {
    token: token.value.trim(),
    port: Number(port.value) || 27183,
    ignoreSelectors: ignore.value.split('\n').map(x => x.trim()).filter(Boolean),
  };
  await chrome.storage.local.set({ settings });
  statusEl.className = '';
  statusEl.textContent = '接続中…';
});

chrome.runtime.onMessage.addListener((msg: Broadcast) => {
  if (msg?.kind === 'statusChanged') showStatus(msg.status);
  return false;
});
