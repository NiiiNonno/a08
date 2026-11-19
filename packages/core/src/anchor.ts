/**
 * 編集される文書（vault 内の markdown）での註の位置探し。
 *
 * 位置は元のマークダウンでの文字位置（TextPositionSelector）を手がかりに、
 * 引用文と前後の文脈（TextQuoteSelector）で確かめる。軽い順に試し、重い処理は前段で
 * 見つからなかったものだけに回す:
 *
 * 1. 手がかりの位置に今も同じ引用文があるか
 * 2. 同じ引用文を探し、前後の文脈が最もよく合う箇所
 * 3. 前後の文脈の両方が同じ段落で見つかれば、その間（引用文が書き換えられたとみなす）
 * 4. 前後の文脈の片方だけ合えば、そこから元の文字数分（推定）
 * 5. 近い文字列（推定。計算量に上限あり）
 * 6. 見つからない
 */
import type { Selector, TextPositionSelector, TextQuoteSelector } from './types.ts';

/** 前後の文脈として保存する文字数 */
export const CONTEXT_LENGTH = 32;
/** 3・4 で前後の文脈として探す長さ（端の近くが書き換えられても見つかるよう、保存した文脈の一部だけ使う） */
const CONTEXT_PROBE = 16;
/** 2 で「文脈が合う」とみなす割合 */
const CONTEXT_OK = 0.5;
/** 5 で探す範囲と、許す違いの割合 */
const FUZZY_WINDOW = 3000;
const FUZZY_MAX_COST = 4_000_000;
const FUZZY_MAX_ERRORS = 0.25;

export type QuoteAnchor = {
  exact: string;
  prefix?: string;
  suffix?: string;
  /** 前回の位置（手がかり） */
  start?: number;
};

/**
 * ok: 引用文がそのまま見つかった
 * changed: 前後の文脈の間の文字が書き換えられていた（exact が新しい引用文）
 * tentative: 推定（確定ボタンで確かめてもらう）
 * orphan: 見つからない
 */
export type AnchorStatus = 'ok' | 'changed' | 'tentative' | 'orphan';

export type AnchorResult =
  | { status: 'ok' | 'changed' | 'tentative'; start: number; end: number; exact: string }
  | { status: 'orphan' };

export function quoteSelectorOf(selector: Selector[]): TextQuoteSelector | undefined {
  return selector.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
}

export function positionSelectorOf(selector: Selector[]): TextPositionSelector | undefined {
  return selector.find((s): s is TextPositionSelector => s.type === 'TextPositionSelector');
}

/** 文書の範囲から selector を作る */
export function selectorsForRange(text: string, start: number, end: number): Selector[] {
  return [
    {
      type: 'TextQuoteSelector',
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
      suffix: text.slice(end, end + CONTEXT_LENGTH),
    },
    { type: 'TextPositionSelector', start, end },
  ];
}

/** selector から QuoteAnchor を作る */
export function quoteAnchorOf(selector: Selector[]): QuoteAnchor | null {
  const q = quoteSelectorOf(selector);
  if (!q || !q.exact) return null;
  const p = positionSelectorOf(selector);
  return { exact: q.exact, prefix: q.prefix ?? '', suffix: q.suffix ?? '', start: p?.start };
}

function occurrences(text: string, needle: string, limit = 2000): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = text.indexOf(needle);
  while (i >= 0 && out.length < limit) {
    out.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return out;
}

/** 末尾から一致する文字数 */
function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** 先頭から一致する文字数 */
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** 位置 start..end の前後が、保存した文脈とどれだけ合うか（0〜1） */
function contextScore(text: string, start: number, end: number, prefix: string, suffix: string): number {
  const parts: number[] = [];
  if (prefix) parts.push(commonSuffixLength(text.slice(Math.max(0, start - prefix.length), start), prefix) / prefix.length);
  else parts.push(start === 0 ? 1 : 0.5);
  if (suffix) parts.push(commonPrefixLength(text.slice(end, end + suffix.length), suffix) / suffix.length);
  else parts.push(end === text.length ? 1 : 0.5);
  return (parts[0] + parts[1]) / 2;
}

/** 段落の区切り（空行）を含むか */
function crossesParagraph(s: string): boolean {
  return /\n[ \t]*\n/.test(s);
}

function nearest(cands: number[], hint: number | undefined): { pos: number; ambiguous: boolean } | null {
  if (!cands.length) return null;
  if (hint == null) return { pos: cands[0], ambiguous: cands.length > 1 };
  let best = cands[0];
  let tie = false;
  for (const c of cands.slice(1)) {
    const d = Math.abs(c - hint) - Math.abs(best - hint);
    if (d < 0) {
      best = c;
      tie = false;
    } else if (d === 0) tie = true;
  }
  return { pos: best, ambiguous: tie };
}

/** 引用文の位置を探す */
export function anchorQuote(text: string, a: QuoteAnchor): AnchorResult {
  const { exact } = a;
  const prefix = a.prefix ?? '';
  const suffix = a.suffix ?? '';
  const len = exact.length;
  if (!len) return { status: 'orphan' };

  // 1. 手がかりの位置
  // （短い引用文は別の箇所の同じ語に当たりやすいので、文脈も確かめる）
  if (
    a.start != null &&
    text.startsWith(exact, a.start) &&
    (len >= 16 || contextScore(text, a.start, a.start + len, prefix, suffix) >= CONTEXT_OK)
  ) {
    return { status: 'ok', start: a.start, end: a.start + len, exact };
  }

  // 2. 同じ引用文
  let fallback: { start: number; score: number } | null = null;
  const found = occurrences(text, exact);
  if (found.length) {
    let best = { start: found[0], score: -1, dist: Infinity };
    for (const s of found) {
      const score = contextScore(text, s, s + len, prefix, suffix);
      const dist = a.start == null ? 0 : Math.abs(s - a.start);
      if (score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && dist < best.dist)) best = { start: s, score, dist };
    }
    // 文脈が合うか、ほかに候補がなく引用文が十分長ければ確実とみなす
    if (best.score >= CONTEXT_OK || (found.length === 1 && len >= 8)) {
      return { status: 'ok', start: best.start, end: best.start + len, exact };
    }
    fallback = { start: best.start, score: best.score };
  }

  // 3. 前後の文脈の両方（間が書き換えられた）
  const pre = prefix.slice(-CONTEXT_PROBE);
  const suf = suffix.slice(0, CONTEXT_PROBE);
  const maxLen = len * 2 + 40;
  const allowBreak = crossesParagraph(exact);
  const preEnds = pre ? occurrences(text, pre).map(i => i + pre.length) : [0];
  const sufStarts = suf ? occurrences(text, suf) : [text.length];
  if ((pre || suf) && preEnds.length && sufStarts.length) {
    const pairs: number[][] = [];
    let j = 0;
    for (const s of preEnds) {
      while (j < sufStarts.length && sufStarts[j] < s) j++;
      // s 以降で最初に現れる後ろの文脈
      if (j >= sufStarts.length) break;
      const e = sufStarts[j];
      if (e > s && e - s <= maxLen) {
        const between = text.slice(s, e);
        if (allowBreak || !crossesParagraph(between)) pairs.push([s, e]);
      }
    }
    const usable = pairs;
    if (usable.length) {
      const pick = nearest(usable.map(p => p[0]), a.start);
      const pair = usable.find(p => p[0] === pick!.pos)!;
      if (!pick!.ambiguous || a.start != null) {
        const newExact = text.slice(pair[0], pair[1]);
        return { status: newExact === exact ? 'ok' : 'changed', start: pair[0], end: pair[1], exact: newExact };
      }
    }
  }

  // 2 で文脈の合わない同じ引用文だけ見つかっていたら、それを推定とする
  if (fallback) {
    return { status: 'tentative', start: fallback.start, end: fallback.start + len, exact };
  }

  // 4. 前後の文脈の片方だけ
  const clampEnd = (s: number, e: number) => {
    const m = /\n[ \t]*\n/.exec(text.slice(s, e));
    return m && !allowBreak ? s + m.index : e;
  };
  if (pre) {
    const pick = nearest(preEnds, a.start);
    if (pick && (!pick.ambiguous || a.start != null)) {
      const s = pick.pos;
      const e = clampEnd(s, Math.min(text.length, s + len));
      if (e > s) return { status: 'tentative', start: s, end: e, exact: text.slice(s, e) };
    }
  }
  if (suf) {
    const pick = nearest(sufStarts, a.start == null ? undefined : a.start + len);
    if (pick && (!pick.ambiguous || a.start != null)) {
      const e = pick.pos;
      let s = Math.max(0, e - len);
      const m = /\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/.exec(text.slice(s, e));
      if (m && !allowBreak) s = s + m.index + m[0].length;
      if (e > s) return { status: 'tentative', start: s, end: e, exact: text.slice(s, e) };
    }
  }

  // 5. 近い文字列
  const fuzzy = fuzzyFind(text, exact, a.start);
  if (fuzzy) return { status: 'tentative', start: fuzzy.start, end: fuzzy.end, exact: text.slice(fuzzy.start, fuzzy.end) };

  return { status: 'orphan' };
}

/**
 * 近い文字列を探す（Sellers のアルゴリズム）。
 * 手がかりがあればその周辺だけ、なければ計算量が上限内のときだけ文書全体を探す。
 */
export function fuzzyFind(text: string, pattern: string, hint?: number): { start: number; end: number; errors: number } | null {
  const m = pattern.length;
  if (!m || m > 512) return null;
  let from = 0;
  let to = text.length;
  if (hint != null) {
    from = Math.max(0, hint - FUZZY_WINDOW);
    to = Math.min(text.length, hint + m + FUZZY_WINDOW);
  }
  if ((to - from) * m > FUZZY_MAX_COST) {
    if (hint == null) return null;
    const half = Math.floor(FUZZY_MAX_COST / m / 2);
    from = Math.max(0, hint - half);
    to = Math.min(text.length, hint + m + half);
  }
  const hay = text.slice(from, to);
  const maxErr = Math.floor(m * FUZZY_MAX_ERRORS);
  const end = bestEnd(hay, pattern);
  if (!end || end.errors > maxErr) return null;
  // 始まりは、逆向きにもう一度探して求める
  const revHay = [...hay.slice(Math.max(0, end.pos - m - maxErr), end.pos)].reverse().join('');
  const revPat = [...pattern].reverse().join('');
  const back = bestEnd(revHay, revPat);
  if (!back) return null;
  const start = end.pos - back.pos;
  return { start: from + start, end: from + end.pos, errors: end.errors };
}

/** 文字列 hay の中で pattern と最も近い部分の終わり（排他的）と違いの数 */
function bestEnd(hay: string, pattern: string): { pos: number; errors: number } | null {
  const m = pattern.length;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  let best: { pos: number; errors: number } | null = null;
  for (let j = 1; j <= hay.length; j++) {
    cur[0] = 0;
    const c = hay.charCodeAt(j - 1);
    for (let i = 1; i <= m; i++) {
      const cost = pattern.charCodeAt(i - 1) === c ? 0 : 1;
      cur[i] = Math.min(prev[i - 1] + cost, prev[i] + 1, cur[i - 1] + 1);
    }
    if (!best || cur[m] < best.errors) best = { pos: j, errors: cur[m] };
    [prev, cur] = [cur, prev];
  }
  return best;
}
