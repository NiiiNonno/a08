/**
 * 選択範囲 ⇄ selector の変換。
 *
 * 再特定の順序は Hypothesis と同じ:
 *   RangeSelector（XPath）→ TextPositionSelector → TextQuoteSelector（近似一致）
 * 前の 2 つは、得られた範囲の文字列が引用（exact）と一致するときだけ採用する。
 */
import type {
  RangeSelector,
  Selector,
  TextPositionSelector,
  TextQuoteSelector,
} from '../types.ts';
import { matchQuote } from './match-quote.ts';
import { TextModel } from './text-model.ts';
import { nodeFromXPath, xpathFromNode } from './xpath.ts';

/** 前後文脈として保存する文字数（Hypothesis と同じ） */
export const CONTEXT_LENGTH = 32;

/**
 * 引用の近似一致で採用する最低スコア（0〜1）。
 * スコアは 引用50・前文脈20・後文脈20・位置2 の重み付き平均。
 * 引用が完全一致なら文脈が全く違っても 0.54 以上になる。
 */
export const MIN_QUOTE_SCORE = 0.5;

/** 引用の近似一致で許す編集距離の割合（引用の長さに対して） */
export const MAX_QUOTE_ERROR_RATIO = 0.25;

export type AnchorResult = {
  range: Range;
  start: number;
  end: number;
  /** どの selector で特定できたか */
  via: 'RangeSelector' | 'TextPositionSelector' | 'TextQuoteSelector';
};

export type AnchorOptions = {
  /**
   * false にすると位置情報（Range / TextPosition）を使わず、引用だけで探す。
   * 註をつけた文書と別の URI（同じ論文の別サイトなど）で開いたときに使う。
   */
  usePosition?: boolean;
};

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** 選択範囲から selector を作る。テキストを含まなければ null */
export function describe(model: TextModel, range: Range): Selector[] | null {
  let [start, end] = model.offsetsOf(range);
  [start, end] = model.trim(start, end);
  if (start >= end) return null;

  const exact = model.renderedSlice(start, end);
  const prefix = model.renderedSlice(Math.max(0, start - CONTEXT_LENGTH), start);
  const suffix = model.renderedSlice(end, Math.min(model.text.length, end + CONTEXT_LENGTH));

  const selectors: Selector[] = [
    { type: 'TextQuoteSelector', exact, prefix, suffix },
    { type: 'TextPositionSelector', start, end },
  ];

  try {
    const sp = model.pointAt(start, 'forward');
    const ep = model.pointAt(end, 'backward');
    const sEl = elementOf(sp.node);
    const eEl = elementOf(ep.node);
    if (sEl && eEl && model.root.contains(sEl) && model.root.contains(eEl)) {
      const [sElStart] = model.elementSpan(sEl);
      const [eElStart] = model.elementSpan(eEl);
      selectors.push({
        type: 'RangeSelector',
        startContainer: xpathFromNode(sEl, model.root),
        startOffset: start - sElStart,
        endContainer: xpathFromNode(eEl, model.root),
        endOffset: end - eElStart,
      });
    }
  } catch {
    // RangeSelector は補助なので作れなくてもよい
  }
  return selectors;
}

function quoteMatches(model: TextModel, start: number, end: number, quote?: TextQuoteSelector) {
  if (!quote?.exact) return true;
  return model.renderedSlice(start, end) === quote.exact;
}

function fromRangeSelector(model: TextModel, sel: RangeSelector): [number, number] | null {
  const sEl = nodeFromXPath(sel.startContainer, model.root);
  const eEl = nodeFromXPath(sel.endContainer, model.root);
  if (!sEl || !eEl) return null;
  const [sStart, sEnd] = model.elementSpan(sEl);
  const [eStart, eEnd] = model.elementSpan(eEl);
  const start = sStart + sel.startOffset;
  const end = eStart + sel.endOffset;
  if (start > sEnd || end > eEnd || start > end) return null;
  return [start, end];
}

/**
 * selector から範囲を求める。見つからなければ null。
 */
export function anchor(
  model: TextModel,
  selectors: Selector[],
  options: AnchorOptions = {},
): AnchorResult | null {
  const usePosition = options.usePosition ?? true;
  let quote: TextQuoteSelector | undefined;
  let position: TextPositionSelector | undefined;
  let rangeSel: RangeSelector | undefined;
  for (const s of selectors) {
    if (s.type === 'TextQuoteSelector') quote = s;
    else if (s.type === 'TextPositionSelector') position = s;
    else if (s.type === 'RangeSelector') rangeSel = s;
  }

  const make = (start: number, end: number, via: AnchorResult['via']): AnchorResult | null => {
    try {
      return { range: model.toRange(start, end), start, end, via };
    } catch {
      return null;
    }
  };

  if (usePosition && rangeSel) {
    try {
      const r = fromRangeSelector(model, rangeSel);
      if (r && r[0] < r[1] && quoteMatches(model, r[0], r[1], quote)) {
        const res = make(r[0], r[1], 'RangeSelector');
        if (res) return res;
      }
    } catch {
      // XPath が解決できないなど
    }
  }

  if (
    usePosition &&
    position &&
    position.start >= 0 &&
    position.end <= model.text.length &&
    position.start < position.end &&
    quoteMatches(model, position.start, position.end, quote)
  ) {
    const res = make(position.start, position.end, 'TextPositionSelector');
    if (res) return res;
  }

  if (quote?.exact) {
    const hint = usePosition && position ? position.start : undefined;
    const m = matchQuote(model.rendered, quote.exact, {
      prefix: quote.prefix,
      suffix: quote.suffix,
      hint: hint === undefined ? undefined : hintToRendered(model, hint),
    });
    // Hypothesis は最良の候補を常に採用するが、短い引用だと無関係な箇所に
    // 当たりやすいので、一定以上の一致度を求める
    if (m && m.score >= MIN_QUOTE_SCORE && m.errors <= quote.exact.length * MAX_QUOTE_ERROR_RATIO) {
      const start = model.renderedToRaw(m.start);
      const end = model.renderedToRaw(m.end);
      if (start < end) return make(start, end, 'TextQuoteSelector');
    }
  }
  return null;
}

function hintToRendered(model: TextModel, raw: number): number {
  let c = 0;
  model.brPositions.forEach((p, i) => {
    if (p - i < raw) c++;
  });
  return raw + c;
}
