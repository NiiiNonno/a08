/**
 * URI の正規化。ノートの `uris:` と閲覧中のページを照合するときに使う。
 *
 * - スキームとホストを小文字化し、既定ポートを除く
 * - フラグメント（#...、テキストフラグメント含む）を除く
 * - 追跡用クエリ（utm_*, fbclid, gclid など）を除く
 * - Wayback Machine のスナップショットは、タイムスタンプを `*` に置き換える
 *   （同じページの別スナップショットを同一視する）
 * - doi: / https://dx.doi.org/ は https://doi.org/ に揃え、DOI 部分を小文字化する
 *
 * URL として解釈できない文字列は前後の空白を除いてそのまま返す。
 */

const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^igshid$/i,
  /^ref_src$/i,
];

const WAYBACK_RE =
  /^(https?:\/\/web\.archive\.org\/web\/)(\d{1,14}|\*)([a-z]{2}_)?\/(.*)$/i;

export function normalizeUri(input: string): string {
  const raw = input.trim();
  if (!raw) return raw;

  const doi = raw.match(/^doi:\s*(.+)$/i);
  if (doi) return `https://doi.org/${doi[1].toLowerCase()}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.some(re => re.test(key))) {
        url.searchParams.delete(key);
      }
    }
    // searchParams を触ると空クエリが "?" で残らないよう正規化される
    if ([...url.searchParams.keys()].length === 0) url.search = '';

    const host = url.hostname.toLowerCase();
    if (host === 'dx.doi.org' || host === 'doi.org') {
      return `https://doi.org${decodeURIComponent(url.pathname).toLowerCase()}`;
    }
  } else if (url.protocol === 'file:') {
    url.hash = '';
  }

  let out = url.toString();

  const wb = out.match(WAYBACK_RE);
  if (wb) {
    out = `${wb[1].replace(/^http:/i, 'https:')}*/${normalizeUri(wb[4])}`;
  }
  return out;
}

/** Wayback Machine の URL なら元のページの URL を返す */
export function waybackOriginal(input: string): string | null {
  const m = input.trim().match(WAYBACK_RE);
  return m ? m[4] : null;
}

/** 2つの URI 集合が共通要素を持つか（正規化して比較） */
export function urisOverlap(a: string[], b: string[]): boolean {
  const set = new Set(a.map(normalizeUri));
  return b.some(u => set.has(normalizeUri(u)));
}

/**
 * Text Fragment 付き URL（`#:~:text=`）。拡張が使えないときのフォールバック。
 */
export function textFragmentUrl(
  url: string,
  quote: string,
  prefix?: string,
  suffix?: string,
): string {
  const enc = (s: string) =>
    encodeURIComponent(s.replace(/\s+/g, ' ').trim()).replace(/-/g, '%2D');
  const q = quote.replace(/\s+/g, ' ').trim();
  if (!q) return url;
  let text: string;
  const words = q.split(' ');
  if (q.length > 80 && words.length > 8) {
    text = `${enc(words.slice(0, 4).join(' '))},${enc(words.slice(-4).join(' '))}`;
  } else if (q.length > 80) {
    text = `${enc(q.slice(0, 20))},${enc(q.slice(-20))}`;
  } else {
    text = enc(q);
  }
  const pre = prefix?.replace(/\s+/g, ' ').trim().slice(-20);
  const suf = suffix?.replace(/\s+/g, ' ').trim().slice(0, 20);
  if (pre) text = `${enc(pre)}-,${text}`;
  if (suf) text = `${text},-${enc(suf)}`;
  const base = url.replace(/#.*$/, '');
  return `${base}#:~:text=${text}`;
}
