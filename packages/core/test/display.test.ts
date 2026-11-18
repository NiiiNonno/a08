import { expect, it } from 'vitest';
import { displayQuote } from '../src/types.ts';

it('collapses indentation whitespace in quotes', () => {
  expect(displayQuote('character position.\n        When the page')).toBe('character position.\nWhen the page');
  expect(displayQuote('  a \t b  ')).toBe('a b');
});
