// @vitest-environment jsdom
import { beforeEach, describe as group, expect, it } from 'vitest';
import { TextModel, anchor, describe, ignoreSelectors } from '../src/anchoring/index.ts';
import type { Selector, TextQuoteSelector } from '../src/types.ts';

function rangeOf(container: Node, start: number, endContainer: Node, end: number) {
  const r = document.createRange();
  r.setStart(container, start);
  r.setEnd(endContainer, end);
  return r;
}

function textNodeContaining(s: string): Text {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if ((n as Text).data.includes(s)) return n as Text;
  }
  throw new Error(`no text node: ${s}`);
}

function select(s: string): Range {
  const t = textNodeContaining(s);
  const i = t.data.indexOf(s);
  return rangeOf(t, i, t, i + s.length);
}

const quote = (sels: Selector[]) =>
  sels.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector')!;

group('anchoring', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <h1>Title</h1>
        <p id="p1">The quick brown fox jumps over the lazy dog.</p>
        <p id="p2">Second <b>bold <i>italic</i></b> paragraph<br>after break.</p>
        <p id="p3">The quick brown fox appears again here.</p>
      </main>`;
  });

  it('describes a selection with quote, position and range selectors', () => {
    const model = new TextModel(document.body);
    const sels = describe(model, select('brown fox jumps'))!;
    expect(sels.map(s => s.type)).toEqual(['TextQuoteSelector', 'TextPositionSelector', 'RangeSelector']);
    const q = quote(sels);
    expect(q.exact).toBe('brown fox jumps');
    expect(q.prefix!.endsWith('The quick ')).toBe(true);
    expect(q.suffix!.startsWith(' over the lazy')).toBe(true);

    const res = anchor(model, sels)!;
    expect(res.range.toString()).toBe('brown fox jumps');
    expect(res.via).toBe('RangeSelector');
  });

  it('matches hypothesis TextPosition offsets (textContent based)', () => {
    const model = new TextModel(document.body);
    const sels = describe(model, select('lazy dog'))!;
    const pos = sels.find(s => s.type === 'TextPositionSelector')!;
    expect(pos).toMatchObject({
      start: document.body.textContent!.indexOf('lazy dog'),
      end: document.body.textContent!.indexOf('lazy dog') + 8,
    });
  });

  it('handles selections spanning elements and <br>', () => {
    const model = new TextModel(document.body);
    const start = textNodeContaining('bold ');
    const end = textNodeContaining('after break');
    const sels = describe(model, rangeOf(start, 2, end, 5))!;
    expect(quote(sels).exact).toBe('ld italic paragraph after');
    document.body.querySelector('h1')!.remove(); // 位置をずらす
    const model2 = new TextModel(document.body);
    const res = anchor(model2, sels)!;
    expect(res.range.toString()).toBe('ld italic paragraphafter');
    // 見出しを消しても p 要素の XPath は変わらない
    expect(res.via).toBe('RangeSelector');
    // XPath も位置も使えない場合は引用で探す
    const res2 = anchor(model2, sels.filter(s => s.type === 'TextQuoteSelector'))!;
    expect(res2.range.toString()).toBe('ld italic paragraphafter');
    expect(res2.via).toBe('TextQuoteSelector');
  });

  it('trims whitespace and returns null for empty selections', () => {
    const model = new TextModel(document.body);
    const p1 = document.getElementById('p1')!;
    const sels = describe(model, rangeOf(p1.parentNode!, 0, p1.firstChild!, 3))!;
    expect(quote(sels).exact).toBe('Title\n        The');
    const empty = rangeOf(p1.parentNode!, 0, p1.parentNode!, 0);
    expect(describe(model, empty)).toBeNull();
  });

  it('re-anchors by quote when the document changed', () => {
    const sels = describe(new TextModel(document.body), select('appears again'))!;
    document.getElementById('p1')!.insertAdjacentHTML('beforebegin', '<p>Inserted paragraph with appears text.</p>');
    const res = anchor(new TextModel(document.body), sels)!;
    expect(res.range.toString()).toBe('appears again');
    expect(res.range.startContainer.parentElement!.id).toBe('p3');
  });

  it('uses context to disambiguate repeated quotes', () => {
    const sels = describe(new TextModel(document.body), select('quick brown fox appears'))!;
    // 同じ語句が 2 回あるケース
    const q = { ...quote(sels), exact: 'The quick brown fox' };
    const res = anchor(new TextModel(document.body), [q])!;
    expect(res.range.startContainer.parentElement!.id).toBe('p3');
  });

  it('tolerates small edits (approximate match)', () => {
    const sels = describe(new TextModel(document.body), select('jumps over the lazy dog'))!;
    document.getElementById('p1')!.textContent = 'The quick brown fox jumped over the lazy dog.';
    const res = anchor(new TextModel(document.body), sels)!;
    expect(res.range.toString()).toMatch(/jump.*lazy dog/);
  });

  it('returns null when the quote is gone', () => {
    const sels = describe(new TextModel(document.body), select('lazy dog'))!;
    document.getElementById('p1')!.textContent = 'Completely different.';
    document.getElementById('p3')!.textContent = 'Nothing.';
    expect(anchor(new TextModel(document.body), sels)).toBeNull();
  });

  group('bilingual translation nodes', () => {
    const ignore = ignoreSelectors(['.immersive-translate-target-wrapper', '[data-a08-ignore]']);
    const translate = () => {
      for (const p of document.querySelectorAll('p')) {
        const t = document.createElement('font');
        t.className = 'immersive-translate-target-wrapper';
        t.innerHTML = '<br><font>訳文：' + p.textContent + '</font>';
        p.appendChild(t);
      }
    };

    it('ignores inserted translations when describing and anchoring', () => {
      const before = describe(new TextModel(document.body, ignore), select('lazy dog'))!;
      translate();
      const model = new TextModel(document.body, ignore);
      expect(model.text).not.toContain('訳文');
      // 訳文が挿入されても、位置（TextPosition）がそのまま使える
      const res = anchor(model, before)!;
      expect(res.range.toString()).toBe('lazy dog');
      expect(res.via).not.toBe('TextQuoteSelector');

      // 訳文表示中に作った selector は、訳文なしの状態と同じになる
      const during = describe(model, select('lazy dog'))!;
      expect(during).toEqual(before);
    });

    it('splits highlight ranges per text node, skipping translations', () => {
      const model0 = new TextModel(document.body, ignore);
      const start = textNodeContaining('lazy dog');
      const end = textNodeContaining('Second ');
      const sels = describe(model0, rangeOf(start, start.data.indexOf('lazy'), end, 6))!;
      translate();
      const model = new TextModel(document.body, ignore);
      const res = anchor(model, sels)!;
      const parts = model.rangesFor(res.start, res.end).map(r => r.toString());
      expect(parts).toEqual(['lazy dog.', 'Second']);
      expect(parts.join('')).not.toContain('訳文');
    });

    it('does not let a selection extend into translated text', () => {
      translate();
      const model = new TextModel(document.body, ignore);
      const start = textNodeContaining('lazy dog');
      const into = textNodeContaining('訳文：The quick brown fox jumps');
      const sels = describe(model, rangeOf(start, start.data.indexOf('lazy'), into, 5))!;
      expect(quote(sels).exact).toBe('lazy dog.');
    });
  });
});
