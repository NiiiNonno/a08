/**
 * 元のマークダウン（source）と、閲覧表示で描かれた文字（rendered）の文字単位の対応。
 *
 * 描かれた文字は、おおむね元の文字から記号（`**` や `[[`、行頭の `- ` など）を除いたものなので、
 * 差分（Myers のアルゴリズム）で共通部分を求め、対応表を作る。段落などのかたまり単位で使うので小さい。
 * 違いが多すぎるときは、前から順に貪欲に対応させる（計算量を抑えるため）。
 */

export type Alignment = {
  /** source の各文字に対応する rendered の位置（なければ -1） */
  srcToDst: Int32Array;
  /** rendered の各文字に対応する source の位置（なければ -1） */
  dstToSrc: Int32Array;
};

const MAX_D = 1200;

export function align(src: string, dst: string): Alignment {
  const srcToDst = new Int32Array(src.length).fill(-1);
  const dstToSrc = new Int32Array(dst.length).fill(-1);
  const match = (i: number, j: number) => {
    srcToDst[i] = j;
    dstToSrc[j] = i;
  };
  // 共通の先頭・末尾は先に対応させる
  let head = 0;
  while (head < src.length && head < dst.length && src[head] === dst[head]) {
    match(head, head);
    head++;
  }
  let tail = 0;
  while (
    tail < src.length - head &&
    tail < dst.length - head &&
    src[src.length - 1 - tail] === dst[dst.length - 1 - tail]
  ) {
    match(src.length - 1 - tail, dst.length - 1 - tail);
    tail++;
  }
  const a = src.slice(head, src.length - tail);
  const b = dst.slice(head, dst.length - tail);
  if (a.length && b.length) {
    const pairs = myers(a, b) ?? greedy(a, b);
    for (const [i, j] of pairs) match(head + i, head + j);
  }
  return { srcToDst, dstToSrc };
}

/** 共通部分の対応（i, j の組）。違いが MAX_D を超えたら null */
function myers(a: string, b: string): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_D);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) {
        x++;
        y++;
      }
      next[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // 逆にたどって、斜めに進んだ（一致した）箇所を集める
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs;
}

/** 前から順に、次に現れる同じ文字へ対応させる（近くだけ探す） */
function greedy(a: string, b: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    const k = a.indexOf(b[j], i);
    if (k >= 0 && k - i <= 64) {
      pairs.push([k, j]);
      i = k + 1;
    }
  }
  return pairs;
}

/** source の範囲 [start, end) に対応する rendered の範囲。対応する文字がなければ null */
export function mapRange(map: Int32Array, start: number, end: number): { start: number; end: number } | null {
  let s = -1;
  for (let i = Math.max(0, start); i < Math.min(end, map.length); i++) {
    if (map[i] >= 0) {
      s = map[i];
      break;
    }
  }
  if (s < 0) return null;
  let e = -1;
  for (let i = Math.min(end, map.length) - 1; i >= Math.max(0, start); i--) {
    if (map[i] >= 0) {
      e = map[i] + 1;
      break;
    }
  }
  return e > s ? { start: s, end: e } : null;
}
