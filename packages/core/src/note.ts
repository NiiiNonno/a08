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
 *   # ページのタイトル
 *
 *   ```annotation
 *   id: ...
 *   created: ...
 *   source: https://example.com/page
 *   selector:
 *     - type: TextQuoteSelector
 *       exact: ...
 *   ```
 *   ここがコメント。#重要 のようなタグも書ける。
 *
 * コメントは、ブロックの直後から「次の annotation ブロック」または
 * 「見出し行（# + 空白）」の直前まで。
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

export const ANNOTATION_LANG = 'annotation';

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
    let end = b.end + 1;
    while (end < limit && !headings.has(end)) end++;
    // end は排他的。末尾の空行を除く
    let last = end - 1;
    while (last > b.end && lines[last].trim() === '') last--;
    let first = b.end + 1;
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

/** 註データを ```annotation ブロックにする */
export function serializeAnnotation(a: AnnotationData): string {
  const { id, created, source, selector, ...extra } = a;
  // 読みやすさのため TextQuoteSelector を先頭に
  const order = ['TextQuoteSelector', 'PageSelector', 'TextPositionSelector', 'RangeSelector'];
  const sel = [...selector].sort(
    (x, y) => order.indexOf(x.type) - order.indexOf(y.type),
  );
  const obj: Record<string, unknown> = { id, created, source };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && !['comment', 'tags', 'startLine', 'blockEndLine', 'endLine', 'startOffset', 'endOffset'].includes(k)) obj[k] = v;
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
export function createNoteContent(meta: NoteMeta, now = new Date()): string {
  const fm = stringifyYaml(
    { titles: meta.titles, uris: meta.uris, created: localIsoString(now) },
    { lineWidth: 0 },
  );
  const heading = meta.titles[0] ? `\n# ${meta.titles[0]}\n` : '';
  return `---\n${fm}---\n${heading}`;
}

/** 註ブロック＋コメントをノート末尾に追加した本文を返す */
export function appendAnnotation(
  text: string,
  a: AnnotationData,
  comment = '',
): { text: string; offset: number } {
  let base = text.replace(/\s*$/, '');
  const block = serializeAnnotation(a);
  const sep = base ? '\n\n' : '';
  const offset = base.length + sep.length;
  const tail = comment.trim() ? `\n${comment.trim()}\n` : '\n';
  base = `${base}${sep}${block}${tail}`;
  return { text: base, offset };
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
