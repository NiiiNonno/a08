/**
 * vault 内のノートに付けた註のハイライトの CSS。
 *
 * - 編集表示（CodeMirror）は装飾のクラス `.obsidiannot-mark-*`
 * - 閲覧表示は CSS Custom Highlight API の `::highlight(obsidiannot-*)`
 *
 * 見た目はブラウザと同じ「ハイライトのスタイル」設定から作る。ダークテーマは body.theme-dark で切り替える。
 */
import { highlightName, type HighlightStyle, type StyleConfig, type StyleDecl } from '@a08/core';

export const TENTATIVE_HIGHLIGHT = 'obsidiannot-tentative';
export const FOCUS_HIGHLIGHT = highlightName('focus');

/** タグのスタイル番号から、クラス名・ハイライト名の末尾 */
export function styleKey(index: number | undefined): string {
  return index == null ? 'default' : `t${index}`;
}

function decl(d: StyleDecl): string {
  return Object.entries(d)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
}

export function buildLocalCss(config: StyleConfig): string {
  const out: string[] = [];
  const add = (key: string, st: HighlightStyle) => {
    out.push(`.obsidiannot-mark-${key} { ${decl(st.light)} }`);
    out.push(`::highlight(${highlightName(key === 'default' ? 'default' : Number(key.slice(1)))}) { ${decl(st.light)} }`);
    if (st.dark) {
      out.push(`.theme-dark .obsidiannot-mark-${key} { ${decl(st.dark)} }`);
      out.push(`.theme-dark ::highlight(${highlightName(key === 'default' ? 'default' : Number(key.slice(1)))}) { ${decl(st.dark)} }`);
    }
  };
  add('default', config.default);
  config.tags.forEach((t, i) => add(styleKey(i), t.style));
  // 推定の位置は点線の下線だけ
  const tentative = 'text-decoration: underline dashed var(--text-warning, orange); text-decoration-thickness: 2px; text-underline-offset: 3px;';
  out.push(`.obsidiannot-mark.is-tentative { background: none; color: inherit; ${tentative} }`);
  out.push(`::highlight(${TENTATIVE_HIGHLIGHT}) { ${tentative} }`);
  out.push(`.obsidiannot-mark.is-flash { background-color: rgba(255, 120, 0, 0.5); }`);
  out.push(`::highlight(${FOCUS_HIGHLIGHT}) { background-color: rgba(255, 120, 0, 0.5); }`);
  return out.join('\n');
}
