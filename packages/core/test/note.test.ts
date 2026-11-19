import { describe, expect, it } from 'vitest';
import {
  addToFrontmatter,
  appendAnnotation,
  createNoteContent,
  ensureBlockId,
  fileNameFromTitle,
  newBlockId,
  newAnnotationId,
  parseNote,
  serializeAnnotation,
} from '../src/note.ts';
import { extractTags } from '../src/tags.ts';
import type { AnnotationData } from '../src/types.ts';

const ann: AnnotationData = {
  id: '-zMqIOFNEfGtIn89Whxyrw',
  created: '2026-11-15T23:40:46+09:00',
  source: 'https://ar5iv.labs.arxiv.org/html/2107.09437',
  selector: [
    { type: 'RangeSelector', startContainer: '/div[1]/p[2]', startOffset: 0, endContainer: '/div[1]/p[2]', endOffset: 3 },
    { type: 'TextPositionSelector', start: 11983, end: 11986 },
    { type: 'TextQuoteSelector', exact: '(1)', prefix: 't{N}}\\|\\boldsymbol{J}^{*}\\|=1,\n\n', suffix: '\n\nthe systems passes the highest' },
  ],
};

describe('note', () => {
  it('serializes and parses an annotation round-trip', () => {
    const { text } = appendAnnotation(
      createNoteContent({ titles: ['Paper'], uris: ['https://a.example/x'] }),
      ann,
      'これは #重要 な式。 #定義/数式\n\n二段落目',
    );
    const note = parseNote(text);
    expect(note.titles).toEqual(['Paper']);
    expect(note.uris).toEqual(['https://a.example/x']);
    expect(note.annotations).toHaveLength(1);
    const a = note.annotations[0];
    expect(a.id).toBe(ann.id);
    expect(a.created).toBe(ann.created);
    expect(a.source).toBe(ann.source);
    expect(a.selector).toEqual(expect.arrayContaining(ann.selector));
    expect(a.comment).toBe('これは #重要 な式。 #定義/数式\n\n二段落目');
    expect(a.tags).toEqual(['重要', '定義/数式']);
    // quote が先頭に来る
    expect(serializeAnnotation(ann).split('\n')[5]).toContain('TextQuoteSelector');
  });

  it('ends a comment at the next heading or annotation', () => {
    const md = [
      '---', 'titles: [T]', 'uris: [https://e.example/]', '---',
      '# T',
      '```obsidiannot', 'id: a', 'source: s', 'selector: []', '```',
      'comment a',
      '',
      '## 次の節',
      'not a comment',
      '```obsidiannot', 'id: b', 'selector: []', '```',
      '```js', '```obsidiannot', '```',
      'comment b #疑問',
    ].join('\n');
    const note = parseNote(md);
    expect(note.annotations.map(a => [a.id, a.comment])).toEqual([
      ['a', 'comment a'],
      ['b', '```js\n```obsidiannot\n```\ncomment b #疑問'],
    ]);
    expect(note.annotations[1].tags).toEqual(['疑問']);
    expect(note.annotations[0].endLine).toBe(10);
  });

  it('does not write a title heading into new notes', () => {
    const c = createNoteContent({ titles: ['Paper'], uris: ['https://a.example/x'] });
    expect(c).not.toMatch(/^#/m);
    expect(c.endsWith('---\n')).toBe(true);
  });

  it('reads and writes block ids after the block (照)', () => {
    const { text } = appendAnnotation(createNoteContent({ titles: ['P'], uris: ['https://a.example/'] }), ann, 'コメント #重要', 'k3x9qa');
    // ブロック → ^id → 空行 → コメント（Obsidian がブロック ID と認識する形）
    expect(text).toContain('```\n^k3x9qa\n\nコメント #重要\n');
    const a = parseNote(text).annotations[0];
    expect(a.blockId).toBe('k3x9qa');
    expect(a.comment).toBe('コメント #重要');
    // YAML には書かない
    expect(serializeAnnotation(a)).not.toContain('k3x9qa');
    expect(serializeAnnotation(a)).not.toContain('headEndLine');
  });

  it('adds a block id to an existing annotation', () => {
    const base = appendAnnotation(createNoteContent({ titles: ['P'], uris: [] }), ann, 'すぐ下のコメント').text;
    const r = ensureBlockId(base, ann.id, () => 'abc123')!;
    expect(r.changed).toBe(true);
    expect(r.text).toContain('```\n^abc123\n\nすぐ下のコメント');
    expect(parseNote(r.text).annotations[0]).toMatchObject({ blockId: 'abc123', comment: 'すぐ下のコメント' });
    // 2 回目は変えない
    expect(ensureBlockId(r.text, ann.id)).toEqual({ text: r.text, blockId: 'abc123', changed: false });
    expect(ensureBlockId(base, 'nope')).toBeNull();
    // コメントがない註
    const bare = appendAnnotation('', ann).text;
    expect(parseNote(ensureBlockId(bare, ann.id, () => 'zz9')!.text).annotations[0]).toMatchObject({ blockId: 'zz9', comment: '' });
    expect(newBlockId()).toMatch(/^[a-z0-9]{6}$/);
  });

  it('reports broken blocks without failing', () => {
    const note = parseNote('```obsidiannot\nid: [\n```\n\n```obsidiannot\nfoo: 1\n```');
    expect(note.annotations).toHaveLength(0);
    expect(note.broken).toHaveLength(2);
  });

  it('uses a longer fence when the YAML contains backticks', () => {
    const a = { ...ann, selector: [{ type: 'TextQuoteSelector' as const, exact: '```\ncode\n```' }] };
    const s = serializeAnnotation(a);
    const parsed = parseNote(s);
    expect(parsed.annotations[0].selector[0]).toEqual(a.selector[0]);
  });

  it('adds uris and titles to frontmatter, keeping other keys', () => {
    const md = '---\ntitles: Single\nuris:\n  - https://a.example/\naliases: [x]\n---\nbody\n';
    const out = addToFrontmatter(md, { uris: ['https://a.example/', 'https://b.example/'], titles: ['Other'] });
    const note = parseNote(out);
    expect(note.uris).toEqual(['https://a.example/', 'https://b.example/']);
    expect(note.titles).toEqual(['Single', 'Other']);
    expect(note.frontmatter.aliases).toEqual(['x']);
    expect(out.endsWith('---\nbody\n')).toBe(true);
    expect(addToFrontmatter(out, { uris: ['https://a.example/'] })).toBe(out);
  });

  it('creates frontmatter when missing', () => {
    const out = addToFrontmatter('hello\n', { uris: ['https://x.example/'] });
    expect(parseNote(out).uris).toEqual(['https://x.example/']);
    expect(out).toContain('hello');
  });

  it('makes safe file names and ids', () => {
    expect(fileNameFromTitle('a/b: c? [d] #e')).toBe('a b c d e');
    expect(fileNameFromTitle('   ')).toBe('untitled');
    expect(newAnnotationId()).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});

describe('tags', () => {
  it('extracts obsidian style tags', () => {
    expect(extractTags('#重要 と #定義 、#123 は数字のみ、a#b はタグでない、`#code` も\n#入れ子/タグ/')).toEqual([
      '重要', '定義', '入れ子/タグ',
    ]);
    expect(extractTags('```\n#x\n```\n#y #y')).toEqual(['y']);
    expect(extractTags('全角空白の後　#タグ')).toEqual(['タグ']);
  });
});
