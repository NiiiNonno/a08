import { describe, expect, it } from 'vitest';
import { rewriteSelector } from '../src/appearance.ts';

describe('rewriteSelector', () => {
  it('maps html/body/:root to elements inside the shadow root', () => {
    expect(rewriteSelector('body')).toBe('.obsidiannot-body');
    expect(rewriteSelector('body.theme-dark .markdown-rendered p')).toBe('.obsidiannot-body.theme-dark .markdown-rendered p');
    expect(rewriteSelector(':root, html')).toBe('.obsidiannot-root, .obsidiannot-root');
    expect(rewriteSelector('html body .x')).toBe('.obsidiannot-root .obsidiannot-body .x');
    expect(rewriteSelector('.theme-light, body:not(.is-mobile) > .x')).toBe('.theme-light, .obsidiannot-body:not(.is-mobile) > .x');
    // 名前の一部や class は変えない
    expect(rewriteSelector('.body-text, tbody, .html-embed, #body')).toBe('.body-text, tbody, .html-embed, #body');
  });
});
