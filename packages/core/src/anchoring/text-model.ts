/**
 * 文書のテキストと DOM 位置の対応表。
 *
 * Hypothesis は `root.textContent` をそのまま使うが、ここでは
 * 「無視する要素」（対訳型翻訳拡張が挿入した訳文など）の中のテキストを除いて
 * テキストを組み立てる。無視する要素がなければ、得られる文字位置は
 * Hypothesis の TextPositionSelector と同じになる。
 *
 * `<br>` は、引用（TextQuoteSelector）用の「表示テキスト」では空白 1 文字として扱う
 * （Hypothesis の rendered-text と同じ扱い）。
 */

/** true を返した要素は、その子孫ごとテキストから除く */
export type IgnoreFn = (el: Element) => boolean;

const ALWAYS_IGNORED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/** CSS セレクタのリストから IgnoreFn を作る */
export function ignoreSelectors(selectors: string[]): IgnoreFn {
  const valid = selectors.map(s => s.trim()).filter(Boolean).filter(s => {
    try {
      document.createDocumentFragment().querySelector(s);
      return true;
    } catch {
      return false;
    }
  });
  if (!valid.length) return () => false;
  const joined = valid.join(',');
  return el => el.matches(joined);
}

export type Point = { node: Text; offset: number };

export class TextModel {
  readonly root: Element;
  /** 生テキスト（<br> は 0 文字） */
  readonly text: string;
  /** 表示テキスト（<br> は空白 1 文字） */
  readonly rendered: string;
  /** rendered 中の、<br> 由来の空白の位置（昇順） */
  readonly brPositions: number[];
  readonly nodes: Text[];
  /** nodes[i] の text 中の開始位置 */
  readonly starts: number[];
  private readonly ignore: IgnoreFn;

  constructor(root: Element, ignore: IgnoreFn = () => false) {
    this.root = root;
    this.ignore = ignore;
    const nodes: Text[] = [];
    const starts: number[] = [];
    const brPositions: number[] = [];
    const parts: string[] = [];
    let len = 0;
    let brCount = 0;

    // 文書順に辿る（深い DOM でもスタックを溢れさせないよう反復で）
    const stack: Node[] = [];
    for (let c = root.lastChild; c; c = c.previousSibling) stack.push(c);
    while (stack.length) {
      const n = stack.pop()!;
      if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.CDATA_SECTION_NODE) {
        const t = n as Text;
        nodes.push(t);
        starts.push(len);
        parts.push(t.data);
        len += t.data.length;
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as Element;
      if (ALWAYS_IGNORED.has(el.tagName) || ignore(el)) continue;
      if (el.tagName === 'BR') {
        brPositions.push(len + brCount);
        brCount++;
        continue;
      }
      for (let c = el.lastChild; c; c = c.previousSibling) stack.push(c);
    }

    this.nodes = nodes;
    this.starts = starts;
    this.text = parts.join('');
    this.brPositions = brPositions;
    let rendered = '';
    let prev = 0;
    brPositions.forEach((p, i) => {
      const raw = p - i;
      rendered += this.text.slice(prev, raw) + ' ';
      prev = raw;
    });
    this.rendered = rendered + this.text.slice(prev);
  }

  isIgnored(node: Node): boolean {
    for (let n: Node | null = node; n && n !== this.root; n = n.parentNode) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        if (ALWAYS_IGNORED.has(el.tagName) || this.ignore(el)) return true;
      }
    }
    return false;
  }

  /** 表示テキストの位置 → 生テキストの位置 */
  renderedToRaw(off: number): number {
    let c = 0;
    for (const p of this.brPositions) {
      if (p < off) c++;
      else break;
    }
    return off - c;
  }

  /** 生テキストの [start, end) を表示テキストで返す（内側の <br> は空白） */
  renderedSlice(start: number, end: number): string {
    let out = '';
    let prev = start;
    this.brPositions.forEach((p, i) => {
      const raw = p - i;
      if (raw > start && raw < end) {
        out += this.text.slice(prev, raw) + ' ';
        prev = raw;
      }
    });
    return out + this.text.slice(prev, end);
  }

  private indexOfNode(node: Text): number {
    // 文書順なので二分探索できるが、Text 同士の比較は compareDocumentPosition が必要
    let lo = 0;
    let hi = this.nodes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = this.nodes[mid];
      if (n === node) return mid;
      const pos = n.compareDocumentPosition(node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * DOM 上の境界点（Range の start/end）を生テキストの位置に変換する。
   * 無視された要素の中や、テキストのない位置は、次のテキストの先頭に寄せる。
   */
  offsetOf(container: Node, offset: number): number {
    if (container.nodeType === Node.TEXT_NODE) {
      const i = this.indexOfNode(container as Text);
      if (i >= 0) return this.starts[i] + Math.min(offset, (container as Text).data.length);
    }
    // 境界点より後ろにある最初のテキストノードを探す
    const doc = this.root.ownerDocument;
    const r = doc.createRange();
    try {
      r.setStart(container, offset);
    } catch {
      return this.text.length;
    }
    r.collapse(true);
    let lo = 0;
    let hi = this.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const n = this.nodes[mid];
      // (n, 0) が境界点以前なら、n は境界点より前から始まる
      // ただし n 自体が境界点を含む場合（container が無視要素内の Text など）はここに来ない
      let cmp: number;
      try {
        cmp = r.comparePoint(n, 0);
      } catch {
        cmp = 1;
      }
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= this.nodes.length) return this.text.length;
    return this.starts[lo];
  }

  /**
   * 生テキストの位置 → DOM の点。
   * `forward` はテキストノードの境目でうしろ側のノードの先頭を返す（範囲の開始用）。
   * `backward` は前側のノードの末尾を返す（範囲の終了用）。
   */
  pointAt(off: number, dir: 'forward' | 'backward'): Point {
    if (off < 0 || off > this.text.length) throw new RangeError('offset out of range');
    if (!this.nodes.length) throw new RangeError('no text');
    // 最後に starts[i] <= off となる i
    let lo = 0;
    let hi = this.nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    let i = lo;
    if (dir === 'forward') {
      // 空ノードや末尾ちょうどの場合は次の非空ノードへ
      while (i < this.nodes.length - 1 && off >= this.starts[i] + this.nodes[i].data.length) i++;
    } else {
      // 先頭ちょうどなら前のノードの末尾へ
      while (i > 0 && off <= this.starts[i] && off > 0) i--;
      while (i > 0 && off < this.starts[i]) i--;
    }
    const node = this.nodes[i];
    return { node, offset: Math.max(0, Math.min(node.data.length, off - this.starts[i])) };
  }

  toRange(start: number, end: number): Range {
    if (start > end) throw new RangeError('start > end');
    const r = this.root.ownerDocument.createRange();
    const s = this.pointAt(start, 'forward');
    const e = start === end ? s : this.pointAt(end, 'backward');
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    return r;
  }

  /**
   * [start, end) をテキストノードごとの Range に分けて返す。
   * 無視する要素（訳文など）は含まれないので、ハイライトに使うと
   * 範囲の途中に挿入された訳文が塗られない。後から挿入されても同様。
   */
  rangesFor(start: number, end: number): Range[] {
    const out: Range[] = [];
    if (start >= end) return out;
    const doc = this.root.ownerDocument;
    const s = this.pointAt(start, 'forward');
    let i = this.indexOfNode(s.node);
    for (; i >= 0 && i < this.nodes.length && this.starts[i] < end; i++) {
      const node = this.nodes[i];
      const a = Math.max(0, start - this.starts[i]);
      const b = Math.min(node.data.length, end - this.starts[i]);
      if (b <= a) continue;
      // 空白だけのノード（要素間の改行など）は塗らない
      if (!node.data.slice(a, b).trim()) continue;
      const r = doc.createRange();
      r.setStart(node, a);
      r.setEnd(node, b);
      out.push(r);
    }
    return out;
  }

  offsetsOf(range: Range): [number, number] {
    const s = this.offsetOf(range.startContainer, range.startOffset);
    const e = this.offsetOf(range.endContainer, range.endOffset);
    return [s, Math.max(s, e)];
  }

  /** 要素の中身の範囲（生テキスト位置） */
  elementSpan(el: Node): [number, number] {
    return [this.offsetOf(el, 0), this.offsetOf(el, el.childNodes.length)];
  }

  /** [start, end) の両端の空白を除いた範囲 */
  trim(start: number, end: number): [number, number] {
    while (start < end && /\s/.test(this.text[start])) start++;
    while (end > start && /\s/.test(this.text[end - 1])) end--;
    return [start, end];
  }
}
