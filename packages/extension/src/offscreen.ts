/**
 * クリップボードへの書き込み専用の offscreen document。
 * ページ側で navigator.clipboard が使えないとき（http のページなど）に background から使う。
 */
chrome.runtime.onMessage.addListener((msg: { kind?: string; text?: string }, _sender, sendResponse) => {
  if (msg?.kind !== 'offscreenCopy' || typeof msg.text !== 'string') return false;
  const ta = document.getElementById('t') as HTMLTextAreaElement;
  ta.value = msg.text;
  ta.select();
  sendResponse(document.execCommand('copy'));
  return false;
});
