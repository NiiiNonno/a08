/**
 * 註ノート（markdown）の読み書き。
 *
 * ノートの形:
 *
 *   ---
 *   titles:
 *     - ページのタイトル
 *   uris:
 *     - https://example.com/page
 *   ---
 *
 *   ```obsidiannot
 *   id: ...
 *   created: ...
 *   source: https://example.com/page
 *   selector:
 *     - type: TextQuoteSelector
 *       exact: ...
 *   ```
 *   ^k3x9qa
 *
 *   ここがコメント。#重要 のようなタグも書ける。
 *
 * - ブロック直後の `^xxxx` 行は Obsidian のブロック ID（照＝リンクで参照するため。任意）
 * - コメントは、ブロック（と ID 行）の直後から「次の obsidiannot ブロック」または
 *   「見出し行（# + 空白）」の直前まで。
 */
import { parse as parseYaml, parseDocument, stringify as stringifyYaml, isSeq, YAMLSeq } from 'yaml';
import { extractTags } from './tags.ts';
import type {
  AnnotationData,
  BrokenAnnotation,
  NoteMeta,
  ParsedAnnotation,
  ParsedNote,
  Selector,
} from './types.ts';

export const ANNOTATION_LANG = 'obsidiannot';

const BLOCK_ID_RE = /^\^([A-Za-z0-9-]+)\s*$/;

type Fence = { char: string; len: number; info: string; line: number };

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)?.*$/;
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;

function splitLines(text: string): string[] {
  return text.split('\n');
}

/** frontmatter の範囲（行番号）。なければ null */
export function frontmatterRange(
  lines: string[],
): { start: number; end: number } | null {
  if (lines[0]?.replace(/\r$/, '') !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (l === '---' || l === '...') return { start: 0, end: i };
  }
  return null;
}

function toStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v.filter(x => x != null && String(x).trim() !== '').map(x => String(x).trim());
  }
  const s = String(v).trim();
  return s ? [s] : [];
}

export function parseFrontmatter(text: string): Record<string, unknown> {
  const lines = splitLines(text);
  const r = frontmatterRange(lines);
  if (!r) return {};
  try {
    const data = parseYaml(lines.slice(r.start + 1, r.end).join('\n'));
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** frontmatter から titles / uris を読む（title, url, source なども拾う） */
export function metaFromFrontmatter(fm: Record<string, unknown>): NoteMeta {
  const titles = [...toStringArray(fm.titles), ...toStringArray(fm.title)];
  const uris = [
    ...toStringArray(fm.uris),
    ...toStringArray(fm.uri),
    ...toStringArray(fm.url),
    ...toStringArray(fm.urls),
    ...toStringArray(fm.source),
  ];
  return { titles: [...new Set(titles)], uris: [...new Set(uris)] };
}

export function parseNote(text: string): ParsedNote {
  const lines = splitLines(text);
  const frontmatter = parseFrontmatter(text);
  const meta = metaFromFrontmatter(frontmatter);
  const fmRange = frontmatterRange(lines);

  // 行頭オフセット
  const lineStart: number[] = [];
  {
    let off = 0;
    for (const l of lines) {
      lineStart.push(off);
      off += l.length + 1;
    }
  }

  type Block = { start: number; end: number; body: string[] };
  const blocks: Block[] = [];
  const headings = new Set<number>();
  let open: Fence | null = null;
  let body: string[] = [];

  for (let i = fmRange ? fmRange.end + 1 : 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (open) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (m && m[1][0] === open.char && m[1].length >= open.len) {
        if (open.info === ANNOTATION_LANG) {
          blocks.push({ start: open.line, end: i, body });
        }
        open = null;
      } else if (open.info === ANNOTATION_LANG) {
        body.push(line);
      }
      continue;
    }
    const m = line.match(FENCE_OPEN_RE);
    if (m) {
      // バッククォートのフェンスでは info にバッククォートを含められない
      open = {
        char: m[1][0],
        len: m[1].length,
        info: (m[2] ?? '').toLowerCase(),
        line: i,
      };
      body = [];
      continue;
    }
    if (HEADING_RE.test(line)) headings.add(i);
  }

  const annotations: ParsedAnnotation[] = [];
  const broken: BrokenAnnotation[] = [];

  blocks.forEach((b, idx) => {
    const limit = idx + 1 < blocks.length ? blocks[idx + 1].start : lines.length;
    // 直後の ^id 行（ブロック ID）
    const idMatch = b.end + 1 < limit ? lines[b.end + 1].replace(/\r$/, '').match(BLOCK_ID_RE) : null;
    const head = idMatch ? b.end + 1 : b.end;
    let end = head + 1;
    while (end < limit && !headings.has(end)) end++;
    // end は排他的。末尾の空行を除く
    let last = end - 1;
    while (last > head && lines[last].trim() === '') last--;
    let first = head + 1;
    while (first <= last && lines[first].trim() === '') first++;
    const comment = first <= last ? lines.slice(first, last + 1).join('\n') : '';

    let data: unknown;
    try {
      data = parseYaml(b.body.join('\n'));
    } catch (e) {
      broken.push({ startLine: b.start, error: String(e) });
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      broken.push({ startLine: b.start, error: 'not a mapping' });
      return;
    }
    const d = data as Record<string, unknown>;
    if (typeof d.id !== 'string' && typeof d.id !== 'number') {
      broken.push({ startLine: b.start, error: 'missing id' });
      return;
    }
    const selector = Array.isArray(d.selector)
      ? (d.selector as Selector[]).filter(s => s && typeof s === 'object' && 'type' in s)
      : [];
    const endLine = last;
    annotations.push({
      ...d,
      id: String(d.id),
      created: d.created == null ? '' : String(d.created instanceof Date ? d.created.toISOString() : d.created),
      source: d.source == null ? '' : String(d.source),
      selector,
      comment,
      tags: extractTags(comment),
      startLine: b.start,
      blockEndLine: b.end,
      ...(idMatch ? { blockId: idMatch[1] } : {}),
      headEndLine: head,
      endLine,
      startOffset: lineStart[b.start],
      endOffset: lineStart[endLine] + lines[endLine].length,
    });
  });

  return { ...meta, frontmatter, annotations, broken };
}

/** フェンスに使うバッククォート列（本文中の ``` より長くする） */
function fenceFor(body: string): string {
  let max = 2;
  for (const m of body.matchAll(/^ {0,3}(`{3,})/gm)) max = Math.max(max, m[1].length);
  return '`'.repeat(max + 1);
}

/** ノートから読み取った値（ブロックの YAML には書かない） */
const DERIVED_KEYS = ['comment', 'tags', 'startLine', 'blockEndLine', 'headEndLine', 'endLine', 'startOffset', 'endOffset', 'blockId'];

/** 註データを ```obsidiannot ブロックにする */
export function serializeAnnotation(a: AnnotationData): string {
  const { id, created, source, selector, ...extra } = a;
  // 読みやすさのため TextQuoteSelector を先頭に
  const order = ['TextQuoteSelector', 'PageSelector', 'TextPositionSelector', 'RangeSelector'];
  const sel = [...selector].sort(
    (x, y) => order.indexOf(x.type) - order.indexOf(y.type),
  );
  const obj: Record<string, unknown> = { id, created, source };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && !DERIVED_KEYS.includes(k)) obj[k] = v;
  }
  obj.selector = sel.map(s => {
    // undefined のキーを落とす
    return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
  });
  const body = stringifyYaml(obj, { lineWidth: 0, defaultStringType: 'PLAIN' }).replace(/\n$/, '');
  const fence = fenceFor(body);
  return `${fence}${ANNOTATION_LANG}\n${body}\n${fence}`;
}

/** 新しいノートの本文 */
export function createNoteContent(meta: NoteMeta): string {
  // 作成日時はファイルの作成日時（OS・Obsidian が持っている）と重なるので書かない
  const fm = stringifyYaml({ titles: meta.titles, uris: meta.uris }, { lineWidth: 0 });
  return `---\n${fm}---\n`;
}

/** 註ブロック＋（ブロック ID）＋コメントをノート末尾に追加した本文を返す */
export function appendAnnotation(
  text: string,
  a: AnnotationData,
  comment = '',
  blockId?: string,
): { text: string; offset: number } {
  let base = text.replace(/\s*$/, '');
  const block = serializeAnnotation(a) + (blockId ? `\n^${blockId}` : '');
  const sep = base ? '\n\n' : '';
  const offset = base.length + sep.length;
  // カードとコメントの間は一行空ける（ID 行の直後に本文が続くと Obsidian が ID と認めない）
  const tail = comment.trim() ? `\n\n${comment.trim()}\n` : '\n';
  base = `${base}${sep}${block}${tail}`;
  return { text: base, offset };
}

/**
 * 註にブロック ID を付ける（既にあればそのまま）。
 * 返す text は変更後の全文、changed は書き換えたかどうか。
 */
export function ensureBlockId(
  text: string,
  annotationId: string,
  newId: () => string = newBlockId,
): { text: string; blockId: string; changed: boolean } | null {
  const parsed = parseNote(text);
  const a = parsed.annotations.find(x => x.id === annotationId);
  if (!a) return null;
  if (a.blockId) return { text, blockId: a.blockId, changed: false };
  const used = new Set(parsed.annotations.map(x => x.blockId).filter(Boolean));
  for (const m of text.matchAll(/(?:^|\s)\^([A-Za-z0-9-]+)\s*$/gm)) used.add(m[1]);
  let blockId = newId();
  while (used.has(blockId)) blockId = newId();
  const lines = text.split('\n');
  const insert = [`^${blockId}`];
  const next = lines[a.blockEndLine + 1];
  if (next !== undefined && next.trim() !== '') insert.push('');
  lines.splice(a.blockEndLine + 1, 0, ...insert);
  return { text: lines.join('\n'), blockId, changed: true };
}

/**
 * 註ブロックの中身を書き換える（ID 行・コメントはそのまま）。
 * update が null を返した註、見つからない註は変えない。
 */
export function updateAnnotations(
  text: string,
  update: (a: AnnotationData) => AnnotationData | null,
): { text: string; changed: string[] } {
  const parsed = parseNote(text);
  const lines = text.split('\n');
  const changed: string[] = [];
  // 後ろから置き換えて行番号がずれないようにする
  for (const a of [...parsed.annotations].reverse()) {
    const { comment: _c, tags: _t, startLine, blockEndLine, headEndLine: _h, endLine: _e, startOffset: _s, endOffset: _o, blockId: _b, ...data } = a;
    const next = update(data);
    if (!next) continue;
    const cr = lines[startLine].endsWith('\r');
    const block = serializeAnnotation(next).split('\n').map(l => (cr ? `${l}\r` : l));
    lines.splice(startLine, blockEndLine - startLine + 1, ...block);
    changed.push(a.id);
  }
  return { text: changed.length ? lines.join('\n') : text, changed };
}

/** Obsidian のブロック ID 風（英小文字と数字 6 文字） */
export function newBlockId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

/**
 * frontmatter の titles / uris に値を追加する（既にあれば何もしない）。
 * 既存の他のキーや書式はできるだけ保つ。
 */
export function addToFrontmatter(
  text: string,
  add: Partial<NoteMeta>,
  equals: (a: string, b: string) => boolean = (a, b) => a === b,
): string {
  const lines = splitLines(text);
  const r = frontmatterRange(lines);
  const doc = parseDocument(r ? lines.slice(1, r.end).join('\n') : '');
  if (doc.contents == null || !(doc.contents as object)) {
    doc.contents = doc.createNode({}) as never;
  }
  let changed = false;
  for (const key of ['titles', 'uris'] as const) {
    const values = add[key];
    if (!values?.length) continue;
    let node = doc.get(key, true);
    if (!isSeq(node)) {
      const existing = toStringArray(doc.get(key));
      node = doc.createNode(existing) as YAMLSeq;
      doc.set(key, node);
      if (existing.length || values.length) changed = true;
    }
    const seq = node as YAMLSeq;
    const current = seq.items.map(it => String((it as { value?: unknown })?.value ?? it));
    for (const v of values) {
      if (!current.some(c => equals(c, v))) {
        seq.add(doc.createNode(v));
        current.push(v);
        changed = true;
      }
    }
  }
  if (!changed) return text;
  const fm = doc.toString({ lineWidth: 0 });
  const rest = r ? lines.slice(r.end + 1).join('\n') : `\n${text}`;
  return `---\n${fm}---\n${rest}`;
}

/** 2026-11-18T22:10:05+09:00 のようなローカル時刻 */
export function localIsoString(d = new Date()): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(tz / 60)}:${pad(tz % 60)}`
  );
}

/** 註 ID（URL セーフな 16 文字） */
export function newAnnotationId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
}

/** タイトルからファイル名（拡張子なし）を作る */
export function fileNameFromTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const sliced = [...cleaned].slice(0, 100).join('').trim();
  return sliced || 'untitled';
}
