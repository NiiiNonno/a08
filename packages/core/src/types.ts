/**
 * 註のデータ型。selector は W3C Web Annotation / Hypothesis と同じ形。
 */

export type TextQuoteSelector = {
  type: 'TextQuoteSelector';
  exact: string;
  prefix?: string;
  suffix?: string;
};

export type TextPositionSelector = {
  type: 'TextPositionSelector';
  start: number;
  end: number;
};

export type RangeSelector = {
  type: 'RangeSelector';
  startContainer: string;
  startOffset: number;
  endContainer: string;
  endOffset: number;
};

/** PDF 用（第2段階で使用）。Hypothesis の PageSelector と同じ形。 */
export type PageSelector = {
  type: 'PageSelector';
  index: number;
  label?: string;
};

export type Selector =
  | TextQuoteSelector
  | TextPositionSelector
  | RangeSelector
  | PageSelector;

/** ```obsidiannot ブロックに保存される内容 */
export type AnnotationData = {
  id: string;
  /** ISO 8601（ローカル時刻＋オフセット） */
  created: string;
  /** 註をつけたときの文書の URI */
  source: string;
  selector: Selector[];
  /** 未知のキーは保持して書き戻す */
  [extra: string]: unknown;
};

/** ノートから読み取った註（ブロック＋直後のコメント） */
export type ParsedAnnotation = AnnotationData & {
  /** ブロック直後の markdown（前後の空行は除く） */
  comment: string;
  /** コメント中の #tag（# なし、出現順、重複なし） */
  tags: string[];
  /** 0 始まりの行番号。ブロック開始フェンス行 */
  startLine: number;
  /** ブロック終了フェンス行 */
  blockEndLine: number;
  /** ブロック直後の `^xxxx`（Obsidian のブロック ID）。なければ undefined */
  blockId?: string;
  /** ブロック ID 行があればその行、なければ blockEndLine */
  headEndLine: number;
  /** コメントの最終行（コメントが空なら headEndLine） */
  endLine: number;
  /** ブロック開始の文字オフセット */
  startOffset: number;
  /** コメント末尾（endLine の行末）の文字オフセット */
  endOffset: number;
};

/** YAML として壊れていたブロック */
export type BrokenAnnotation = {
  startLine: number;
  error: string;
};

export type NoteMeta = {
  titles: string[];
  uris: string[];
};

export type ParsedNote = NoteMeta & {
  /** frontmatter 全体（titles/uris 以外も含む） */
  frontmatter: Record<string, unknown>;
  annotations: ParsedAnnotation[];
  broken: BrokenAnnotation[];
};

export function quoteOf(a: { selector: Selector[] }): string {
  const q = a.selector.find(
    (s): s is TextQuoteSelector => s.type === 'TextQuoteSelector',
  );
  return q?.exact ?? '';
}

/** 表示用の引用。HTML のインデント由来の空白をまとめる（改行は 1 つ残す） */
export function displayQuote(exact: string): string {
  return exact
    .replace(/[ \t\r\f\v]*\n\s*/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
}
