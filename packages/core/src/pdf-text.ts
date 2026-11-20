/**
 * PDF の文字列のモデル。
 *
 * PDF.js の getTextContent() の項目をページごとにつなげ、ページの間を空行で区切って PDF 全体の文字列にする。
 * 註の位置はこの文字列の上で、引用文・前後の文脈・位置（TextQuoteSelector / TextPositionSelector）と、
 * 何ページ目か（PageSelector）で記録する（Hypothesis が PDF で記録するのと同じ組み合わせ）。
 *
 * - 項目の str をそのままつなぎ、hasEOL の項目の後に改行を入れる
 * - 文字の正規化（合字の展開など）はしない（ビューアの文字の層と同じ文字列にするため。
 *   getTextContent は { disableNormalization: true } で呼ぶ）
 */
import type { PageSelector, Selector } from './types.ts';
import { anchorQuote, quoteAnchorOf, selectorsForRange, type AnchorResult } from './anchor.ts';

/** getTextContent() の項目（文字のない marked content も来る） */
export type PdfTextItem = { str?: string; hasEOL?: boolean };

/** ページの間の区切り */
export const PAGE_SEPARATOR = '\n\n';

/** 1 ページの文字列 */
export function pageText(items: readonly PdfTextItem[]): string {
  let s = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    s += it.str;
    if (it.hasEOL) s += '\n';
  }
  return s;
}

export class PdfTextModel {
  readonly text: string;
  /** 各ページの、全体の文字列での開始位置 */
  readonly starts: number[];

  constructor(
    readonly pages: readonly string[],
    /** ページの表示名（印刷上のページ番号など）。なければ null */
    readonly labels: readonly (string | null)[] = [],
  ) {
    const starts: number[] = [];
    let off = 0;
    for (const p of pages) {
      starts.push(off);
      off += p.length + PAGE_SEPARATOR.length;
    }
    this.starts = starts;
    this.text = pages.join(PAGE_SEPARATOR);
  }

  /** 全体の位置が何ページ目か（0 から）。区切りの中なら直前のページ */
  pageAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** 全体の位置 → ページとページ内の位置 */
  locate(offset: number): { page: number; offset: number } {
    const page = this.pageAt(offset);
    return { page, offset: Math.min(offset - this.starts[page], this.pages[page].length) };
  }

  /** 範囲のセレクタ（引用・位置・ページ） */
  selectors(start: number, end: number): Selector[] {
    const page = this.pageAt(start);
    const ps: PageSelector = { type: 'PageSelector', index: page };
    const label = this.labels[page];
    if (label) ps.label = label;
    return [...selectorsForRange(this.text, start, end), ps];
  }

  /**
   * 記録から位置を探す。位置の手がかりは TextPositionSelector、なければ PageSelector のページの先頭。
   * 探し方はノートへの註と同じ（anchorQuote）
   */
  anchor(selector: readonly Selector[]): AnchorResult | null {
    const q = quoteAnchorOf(selector as Selector[]);
    if (!q) return null;
    if (q.start == null) {
      const p = selector.find((s): s is PageSelector => s.type === 'PageSelector');
      if (p && p.index >= 0 && p.index < this.starts.length) q.start = this.starts[p.index];
    }
    return anchorQuote(this.text, q);
  }
}
