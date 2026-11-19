/**
 * サイドパネルの表示モード（Shadow DOM 内）の CSS。
 *
 * - FALLBACK_CSS: Obsidian の CSS を受け取れないとき（開発用サーバーなど）の簡易な見た目
 * - PANEL_CSS: Obsidian の CSS の上に重ねる、サイドパネル向けの調整（常に有効）
 */

export const FALLBACK_CSS = `
.obsidiannot-body {
  color: var(--fg);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.6;
}
.markdown-rendered a { color: var(--link); }
.markdown-rendered code { font-family: var(--mono); background: var(--code-bg); border-radius: 4px; padding: 0 3px; font-size: 0.9em; }
.markdown-rendered pre { background: var(--code-bg); padding: 8px; border-radius: 6px; overflow: auto; }
.markdown-rendered pre code { background: none; padding: 0; }
.markdown-rendered blockquote { margin: 0.5em 0; padding-left: 10px; border-left: 3px solid var(--blockquote-border-color, var(--border)); color: var(--muted); }
.markdown-rendered h1 { font-size: 1.35em; margin: 0.6em 0 0.4em; }
.markdown-rendered h2 { font-size: 1.2em; margin: 0.8em 0 0.4em; }
.markdown-rendered h3 { font-size: 1.05em; }
.markdown-rendered .tag {
  color: var(--tag-color, var(--link));
  background: var(--tag-background, transparent);
  border-radius: 1em;
  padding: 0 0.4em;
  text-decoration: none;
}
.markdown-rendered .callout { border-left: 3px solid var(--accent); background: var(--bg2); padding: 6px 10px; border-radius: 4px; margin: 0.6em 0; }
.markdown-rendered .callout-title { font-weight: 600; display: flex; gap: 6px; align-items: center; }
.obsidiannot-card {
  --obsidiannot-accent: rgba(255, 200, 0, 0.8);
  border-left: 4px solid var(--obsidiannot-accent);
  background: var(--bg2);
  border-radius: 4px;
  padding: 6px 10px;
  margin: 1.4em 0 0.35em;
}
.obsidiannot-card .obsidiannot-quote { margin: 0; padding: 0; border: none; color: var(--fg); white-space: pre-wrap; }
.obsidiannot-card .obsidiannot-context { color: var(--faint); font-size: 0.9em; }
.obsidiannot-card .obsidiannot-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 11px; margin-top: 3px; align-items: center; }
.obsidiannot-card .obsidiannot-tag { color: var(--tag-color, var(--link)); }
`;

export const PANEL_CSS = `
/* :host に !important を付けると、外側の #view[hidden]（編集モードで隠す）より強くなってしまう */
:host { display: block; position: relative; }
/*
 * Obsidian の画面全体のレイアウト用の指定（高さ固定・スクロール・非表示・変形など）を外し、
 * パネルの main でスクロールさせる
 */
.obsidiannot-root, .obsidiannot-body, .markdown-preview-view, .markdown-preview-sizer {
  display: block !important;
  visibility: visible !important;
  opacity: 1 !important;
  transform: none !important;
  filter: none !important;
  contain: none !important;
  content-visibility: visible !important;
  position: static !important;
  inset: auto !important;
  width: auto !important;
  max-width: none !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
  background: transparent !important;
}
.obsidiannot-body { user-select: text; -webkit-user-select: text; }
.markdown-preview-view { padding: 4px 14px 40px !important; }
.markdown-preview-sizer { max-width: none !important; min-height: 0 !important; padding-bottom: 0 !important; margin: 0 !important; }
.markdown-rendered img { max-width: 100%; }
.markdown-rendered img[data-obsidiannot-resource]:not([src]) { min-width: 2em; min-height: 1em; background: var(--bg2); }
.markdown-rendered .copy-code-button,
.markdown-rendered .edit-block-button,
.markdown-rendered .frontmatter-container,
.markdown-rendered .mod-header,
.markdown-rendered .markdown-preview-pusher,
.obsidiannot-card .obsidiannot-open-hint { display: none !important; }
.obsidiannot-card { cursor: pointer; transition: box-shadow 0.2s; }
.obsidiannot-card:hover { box-shadow: 0 0 0 1px var(--border); }
.obsidiannot-card.flash { box-shadow: 0 0 0 2px var(--accent); }
.obsidiannot-card.orphan { opacity: 0.7; }
.obsidiannot-card.orphan::after {
  content: "このページ内で該当箇所が見つかりません";
  display: block;
  color: var(--faint);
  font-size: 11px;
}
.empty { color: var(--muted); padding: 16px 0; font-family: var(--font); font-size: 14px; line-height: 1.6; }
.empty .brand { font-weight: 600; color: var(--fg); margin-bottom: 4px; }
.empty.quiet { color: var(--faint); font-size: 12px; }
.empty.quiet .brand { color: var(--faint); }
.empty svg { vertical-align: -3px; }
.empty code { font-family: var(--mono); font-size: 12px; }
`;
