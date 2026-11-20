import { expect, it } from 'vitest';
import { displayQuote, joinPdfLines } from '../src/types.ts';

it('collapses indentation whitespace in quotes', () => {
  expect(displayQuote('character position.\n        When the page')).toBe('character position.\nWhen the page');
  expect(displayQuote('  a \t b  ')).toBe('a b');
});

it('joins PDF line breaks: no space between CJK, one space otherwise', () => {
  expect(joinPdfLines('Web annotation lets\nreaders attach notes.')).toBe('Web annotation lets readers attach notes.');
  expect(joinPdfLines('註を付ける仕組み\nを作る。')).toBe('註を付ける仕組みを作る。');
  expect(joinPdfLines('PDF の文字\nlayer')).toBe('PDF の文字layer');
  expect(joinPdfLines('end.\n\nNext page')).toBe('end. Next page');
  expect(joinPdfLines('a \n b')).toBe('a b');
});
