/**
 * Obsidian の画面に読み込まれている CSS（本体・テーマ・スニペット・各プラグイン）を集め、
 * サイドパネルの Shadow DOM で使える形に書き換える。
 *
 * - `html` / `:root` → `.obsidiannot-root`、`body` → `.obsidiannot-body`（Shadow DOM 内の html・body 代わりの要素）
 *   （`:host` にすると、Obsidian の全画面レイアウト用の指定がサイドパネルの枠にまで効いてしまう）
 * - @font-face は Shadow DOM 内では効かず、app:// の URL も拡張からは読めないので除く
 */

const ROOT_CLASS = 'obsidiannot-root';
const BODY_CLASS = 'obsidiannot-body';

export function rewriteSelector(sel: string): string {
  return sel
    .replace(/(^|[\s,>+~(])(?::root|html)(?=$|[\s,>+~.:#[)])/gi, `$1.${ROOT_CLASS}`)
    .replace(/(^|[\s,>+~(])body(?=$|[\s,>+~.:#[)])/gi, `$1.${BODY_CLASS}`);
}

function rewriteRules(rules: CSSRuleList, out: string[]) {
  for (const r of Array.from(rules)) {
    try {
      if (r instanceof CSSStyleRule) {
        const text = r.cssText;
        const sel = r.selectorText;
        out.push(text.startsWith(sel) ? rewriteSelector(sel) + text.slice(sel.length) : text);
      } else if (r instanceof CSSMediaRule) {
        const inner: string[] = [];
        rewriteRules(r.cssRules, inner);
        out.push(`@media ${r.conditionText} {\n${inner.join('\n')}\n}`);
      } else if (r instanceof CSSSupportsRule) {
        const inner: string[] = [];
        rewriteRules(r.cssRules, inner);
        out.push(`@supports ${r.conditionText} {\n${inner.join('\n')}\n}`);
      } else if (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule) {
        const inner: string[] = [];
        rewriteRules(r.cssRules, inner);
        out.push(`@layer ${r.name} {\n${inner.join('\n')}\n}`);
      } else if (r instanceof CSSImportRule) {
        if (r.styleSheet) rewriteRules(r.styleSheet.cssRules, out);
      } else if (r instanceof CSSFontFaceRule) {
        // 使えないので除く
      } else {
        out.push(r.cssText);
      }
    } catch {
      /* 読めない規則は飛ばす */
    }
  }
}

export function collectAppearance(doc: Document): { css: string; bodyClass: string; bodyStyle: string; rootStyle: string } {
  const out: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 別オリジンのシート
    }
    rewriteRules(rules, out);
  }
  for (const sheet of doc.adoptedStyleSheets ?? []) rewriteRules(sheet.cssRules, out);
  return {
    css: out.join('\n'),
    bodyClass: doc.body.className,
    bodyStyle: doc.body.style.cssText,
    rootStyle: doc.documentElement.style.cssText,
  };
}
