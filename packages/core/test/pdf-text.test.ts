import { describe, expect, it } from 'vitest';
import { PdfTextModel, pageText, PAGE_SEPARATOR } from '../src/pdf-text.ts';
import { makePdf } from './make-pdf.ts';

async function modelOf(data: Uint8Array): Promise<PdfTextModel> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    // ビューアの文字の層と同じ設定
    const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    pages.push(pageText(tc.items as never));
  }
  await task.destroy();
  return new PdfTextModel(pages);
}

describe('PdfTextModel', () => {
  it('項目をつなげ、ページの間を区切る', () => {
    const m = new PdfTextModel([pageText([{ str: 'ab', hasEOL: true }, { str: 'cd' }, {}]), 'xyz'], [null, 'ii']);
    expect(m.pages[0]).toBe('ab\ncd');
    expect(m.text).toBe(`ab\ncd${PAGE_SEPARATOR}xyz`);
    expect(m.starts).toEqual([0, 7]);
    expect(m.pageAt(5)).toBe(0);
    expect(m.pageAt(6)).toBe(0);
    expect(m.pageAt(7)).toBe(1);
    expect(m.locate(8)).toEqual({ page: 1, offset: 1 });
    expect(m.selectors(8, 10)).toContainEqual({ type: 'PageSelector', index: 1, label: 'ii' });
  });

  it('実際の PDF から文字列を取り出し、記録した位置を探し直せる', async () => {
    const m = await modelOf(
      makePdf([
        ['Web annotation lets readers attach notes.', 'The same phrase appears here.'],
        ['Second page text.', 'The same phrase appears here.'],
      ]),
    );
    expect(m.pages).toHaveLength(2);
    expect(m.pages[0]).toContain('Web annotation lets readers attach notes.');
    expect(m.pages[1]).toContain('Second page text.');

    // 2 ページ目の「The same phrase」を選んだ
    const start = m.text.lastIndexOf('same phrase');
    const sel = m.selectors(start, start + 'same phrase'.length);
    expect(sel.find(s => s.type === 'PageSelector')).toEqual({ type: 'PageSelector', index: 1 });
    expect(m.anchor(sel)).toMatchObject({ status: 'ok', start });

    // 位置の記録がなくても、ページの手がかりと前後の文脈で同じ箇所を選ぶ
    const noPos = sel.filter(s => s.type !== 'TextPositionSelector');
    expect(m.anchor(noPos)).toMatchObject({ status: 'ok', start });
  });
});
