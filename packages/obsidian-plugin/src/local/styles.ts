/**
 * vault 内のノートに付けた註のハイライトの CSS。
 *
 * - 編集表示（CodeMirror）は装飾のクラス `.obsidiannot-mark-*`
 * - 閲覧表示は CSS Custom Highlight API の `::highlight(obsidiannot-*)`
 *
 * 見た目はブラウザと同じ「ハイライトのスタイル」設定から作る。ダークテーマは body.theme-dark で切り替える。
 */
import { highlightName, underlineOf, type HighlightStyle, type StyleConfig, type StyleDecl } from '@a08/core';

export const TENTATIVE_HIGHLIGHT = 'obsidiannot-tentative';
export const FOCUS_HIGHLIGHT = highlightName('focus');

/** タグのスタイル番号から、クラス名・ハイライト名の末尾 */
export function styleKey(index: number | undefined): string {
  return index == null ? 'default' : `t${index}`;
}

/** 波線の形（幅 6・高さ 4 の中に太さ 1 の線）。色は背景色で塗り、形はマスクで切り抜く */
const WAVE = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 4"><path d="M0 2 Q1.5 0.5 3 2 T6 2" fill="none" stroke="black" stroke-width="1"/></svg>')}")`;

/**
 * PDF のハイライトの下線。PDF のハイライトは文字の上に重ねた箱なので text-decoration が効かない。
 * 箱の ::after に線を描く（位置は箱の高さの 8 割＝おおよその文字の並びの線＋下線の間隔）
 */
function pdfUnderline(d: StyleDecl): string | null {
  const u = underlineOf(d);
  if (!u) return null;
  const t = u.thickness ?? '1.5px';
  const color = u.color && u.color !== 'currentcolor' ? u.color : 'var(--text-normal)';
  const base = `content: ''; position: absolute; left: 0; right: 0; top: calc(80% + ${u.offset ?? '2px'}); pointer-events: none;`;
  if (u.style === 'wavy') {
    const size = `calc(${t} * 6) calc(${t} * 4)`;
    return `${base} height: calc(${t} * 4); background-color: ${color}; -webkit-mask: ${WAVE} repeat-x 0 0 / ${size}; mask: ${WAVE} repeat-x 0 0 / ${size};`;
  }
  const width = u.style === 'double' ? `calc(${t} * 3)` : t;
  return `${base} height: 0; border-top: ${width} ${u.style} ${color};`;
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
    const pl = pdfUnderline(st.light);
    if (pl) out.push(`.obsidiannot-pdf-rect.obsidiannot-mark-${key}::after { ${pl} }`);
    const pd = st.dark && pdfUnderline(st.dark);
    if (pd) out.push(`.theme-dark .obsidiannot-pdf-rect.obsidiannot-mark-${key}::after { ${pd} }`);
    else if (st.dark && pl) out.push(`.theme-dark .obsidiannot-pdf-rect.obsidiannot-mark-${key}::after { content: none; }`);
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
