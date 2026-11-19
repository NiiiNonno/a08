import { describe, expect, it } from 'vitest';
import { anchorQuote, fuzzyFind, quoteAnchorOf, selectorsForRange } from '../src/anchor.ts';
import { align, mapRange } from '../src/align.ts';
import { appendAnnotation, parseNote, updateAnnotations } from '../src/note.ts';

const DOC = [
  '# 見出し',
  '',
  '最初の段落です。ここには特に何もありません。',
  '',
  '二つ目の段落では、註を付けたい大切な一文がここにあります。そのあとにも文が続きます。',
  '',
  '三つ目の段落。',
].join('\n');

function anchorFor(text: string, quote: string) {
  const start = text.indexOf(quote);
  return quoteAnchorOf(selectorsForRange(text, start, start + quote.length))!;
}

describe('anchorQuote', () => {
  const quote = '註を付けたい大切な一文';
  const a = anchorFor(DOC, quote);

  it('手がかりの位置にそのままあれば ok', () => {
    const r = anchorQuote(DOC, a);
    expect(r).toMatchObject({ status: 'ok', start: DOC.indexOf(quote) });
  });

  it('前に文字が増えて位置がずれても見つける', () => {
    const text = DOC.replace('最初の段落です。', '最初の段落です。かなり長い文章を足しました。');
    const r = anchorQuote(text, a);
    expect(r).toMatchObject({ status: 'ok', start: text.indexOf(quote) });
  });

  it('同じ引用文が複数あれば、文脈の合う方', () => {
    const text = `${quote}は別の場所にも。\n\n${DOC}`;
    const r = anchorQuote(text, { ...a, start: undefined });
    expect(r).toMatchObject({ status: 'ok', start: text.lastIndexOf(quote) });
  });

  it('引用文の中が書き換えられても、前後の文脈が合えば changed で新しい引用文', () => {
    const text = DOC.replace(quote, '註を付けたいとても大切な一文');
    const r = anchorQuote(text, a);
    expect(r).toMatchObject({ status: 'changed', exact: '註を付けたいとても大切な一文' });
  });

  it('引用文がすべて消えたら見つからない（空の範囲にしない）', () => {
    const text = DOC.replace(quote, '');
    const r = anchorQuote(text, a);
    expect(r.status === 'orphan' || (r.status === 'tentative' && r.end > r.start)).toBe(true);
    expect(r.status).not.toBe('changed');
  });

  it('前後の文脈の間に段落の区切りが入ったら、間とはみなさない', () => {
    const text = DOC.replace(quote, '註を付け\n\nたい大切な一文');
    const r = anchorQuote(text, a);
    expect(r.status).not.toBe('changed');
  });

  it('片方の文脈だけ合えば、そこから元の文字数分を推定', () => {
    // 引用文と後ろの文脈を書き換える
    const text = DOC.replace(`${quote}がここにあります。そのあとにも`, 'まったく違う文章に置き換えられてしまいました。以降も');
    const r = anchorQuote(text, a);
    expect(r.status).toBe('tentative');
    if (r.status === 'tentative') {
      expect(r.start).toBe(text.indexOf('まったく'));
      expect(r.end - r.start).toBe(quote.length);
    }
  });

  it('前後とも変わっても、近い文字列があれば推定', () => {
    const text = 'まったく別の文章になった。\n\n註を付けたい大切な１文\n\nこちらも別物。';
    const r = anchorQuote(text, { ...a, start: 10 });
    expect(r).toMatchObject({ status: 'tentative' });
    if (r.status === 'tentative') expect(r.exact).toContain('大切な');
  });

  it('何も合わなければ orphan', () => {
    expect(anchorQuote('全然関係のない文書。', a).status).toBe('orphan');
  });

  it('短い引用文は、手がかりの位置にあっても文脈を確かめる', () => {
    const text = 'あいう。かきく。あいう。';
    const short = quoteAnchorOf(selectorsForRange(text, 8, 11))!; // 2 つ目の「あいう」
    // 前の方に文字が増えて、手がかりの位置に 1 つ目の「あいう」が来た
    const edited = `ーーーーーーーー${text}`;
    const r = anchorQuote(edited, { ...short, start: 0 });
    expect(r).toMatchObject({ status: 'ok', start: edited.lastIndexOf('あいう') });
  });

  it('長い文書でも速い', () => {
    const big = `${'あいうえおかきくけこ'.repeat(50_000)}\n\n${DOC}`;
    const t = performance.now();
    const r = anchorQuote(big, { ...a, start: 3 });
    expect(r.status).toBe('ok');
    const orphan = anchorQuote(big, { exact: '存在しない引用文です', prefix: 'なし', suffix: 'なし', start: 100 });
    expect(orphan.status).toBe('orphan');
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe('fuzzyFind', () => {
  it('少し違う文字列の範囲', () => {
    const r = fuzzyFind('ここに The quick brown fax jumps がある', 'quick brown fox');
    expect(r).not.toBeNull();
    expect('ここに The quick brown fax jumps がある'.slice(r!.start, r!.end)).toBe('quick brown fax');
  });
});

describe('align', () => {
  it('マークダウンの記号を飛ばして対応させる', () => {
    const src = '- これは **太字** と [[リンク先|表示名]] を含む';
    const dst = 'これは 太字 と 表示名 を含む';
    const { srcToDst, dstToSrc } = align(src, dst);
    const s = src.indexOf('太字');
    expect(mapRange(srcToDst, s, s + 2)).toEqual({ start: dst.indexOf('太字'), end: dst.indexOf('太字') + 2 });
    // 書式をまたぐ選択
    const s2 = src.indexOf('は **太');
    const e2 = src.indexOf('字**') + 1;
    expect(dst.slice(...Object.values(mapRange(srcToDst, s2, e2)!))).toBe('は 太字');
    // 逆向き
    const d = dst.indexOf('表示名');
    const back = mapRange(dstToSrc, d, d + 3)!;
    expect(src.slice(back.start, back.end)).toBe('表示名');
  });

  it('違いが多い長い文字列でも終わる', () => {
    const src = 'a*'.repeat(5000);
    const dst = 'a'.repeat(5000);
    const { srcToDst } = align(src, dst);
    expect(srcToDst.filter(x => x >= 0).length).toBeGreaterThan(4000);
  });
});

describe('updateAnnotations', () => {
  it('ブロックの中身だけを書き換え、ID 行とコメントは残す', () => {
    let text = '---\nuris:\n  - "[[本文]]"\n---\n';
    text = appendAnnotation(text, { id: 'a1', created: '2026-01-01', source: '[[本文]]', selector: selectorsForRange('abc', 0, 1) }, 'コメント', 'blk001').text;
    text = appendAnnotation(text, { id: 'a2', created: '2026-01-01', source: '[[本文]]', selector: selectorsForRange('abc', 1, 2) }, '二つ目').text;
    const r = updateAnnotations(text, a => (a.id === 'a1' ? { ...a, selector: selectorsForRange('xyz', 0, 2), original: 'a' } : null));
    expect(r.changed).toEqual(['a1']);
    const n = parseNote(r.text);
    expect(n.annotations[0]).toMatchObject({ id: 'a1', original: 'a', blockId: 'blk001', comment: 'コメント' });
    expect(n.annotations[0].selector[0]).toMatchObject({ exact: 'xy' });
    expect(n.annotations[1]).toMatchObject({ id: 'a2', comment: '二つ目' });
  });
});

describe('消した文を戻したとき', () => {
  it('段落ごと消すと見つからず、戻すと元の位置で ok になる', () => {
    const quote = '註を付けたい大切な一文';
    const a = anchorFor(DOC, quote);
    const para = DOC.split('\n')[4];
    const deleted = DOC.replace(`${para}\n`, '');
    expect(anchorQuote(deleted, a).status).toBe('orphan');
    expect(anchorQuote(DOC, a)).toMatchObject({ status: 'ok', start: DOC.indexOf(quote), end: DOC.indexOf(quote) + quote.length });
  });

  it('カードとコメントの間は一行空く（ID がなくても）', () => {
    const text = appendAnnotation('', { id: 'a1', created: '2026-01-01', source: '[[本文]]', selector: selectorsForRange('abc', 0, 1) }, 'コメント').text;
    expect(text).toMatch(/```\n\nコメント\n$/);
    expect(parseNote(text).annotations[0].comment).toBe('コメント');
  });
});
