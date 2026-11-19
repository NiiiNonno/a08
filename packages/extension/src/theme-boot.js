// サイドパネルを開いた最初の描画から、前回の Obsidian のテーマの色にする（白く光らないように）
try {
  const t = JSON.parse(localStorage.getItem('obsidiannot-theme') || 'null');
  if (t) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t.vars || {})) root.style.setProperty(k, v);
    root.dataset.theme = t.dark ? 'dark' : 'light';
    root.style.colorScheme = t.dark ? 'dark' : 'light';
  }
} catch {
  /* ignore */
}
