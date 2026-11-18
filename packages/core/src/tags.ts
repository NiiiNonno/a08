/**
 * Obsidian 式の #tag を markdown から取り出す。
 *
 * - 行頭または空白の直後の `#` に続く、文字・数字・`_`・`-`・`/` の並び
 * - 数字だけのもの（#123）はタグとしない
 * - インラインコード・フェンスコードブロック内は無視
 * - 末尾の `/` は除く。重複は除き、出現順に返す
 */
const TAG_RE = /(^|\s)#([\p{L}\p{N}\p{M}_\-/]+)/gu;

export function extractTags(markdown: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  let fence: string | null = null;

  for (const line of markdown.split('\n')) {
    const fm = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fm) {
      fence = fm[1];
      continue;
    }
    const withoutCode = line.replace(/(`+)[^`]*?\1/g, m => ' '.repeat(m.length));
    for (const m of withoutCode.matchAll(TAG_RE)) {
      const tag = m[2].replace(/\/+$/, '');
      if (!tag || /^[\p{N}/]+$/u.test(tag)) continue;
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }
  return tags;
}

/** `重要/大` → [`重要/大`, `重要`]。入れ子タグのスタイル解決に使う */
export function tagAncestors(tag: string): string[] {
  const parts = tag.split('/');
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('/'));
  return out;
}
