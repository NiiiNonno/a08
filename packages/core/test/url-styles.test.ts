import { describe, expect, it } from 'vitest';
import { normalizeUri, textFragmentUrl, urisOverlap, waybackOriginal } from '../src/url.ts';
import {
  DEFAULT_STYLES,
  DEFAULT_STYLES_YAML,
  buildHighlightCss,
  parseStyleConfig,
  styleIndicesForTags,
} from '../src/styles.ts';

describe('normalizeUri', () => {
  it('drops fragments, tracking params and default ports', () => {
    expect(normalizeUri('HTTPS://Example.COM:443/a?utm_source=x&b=1#sec')).toBe('https://example.com/a?b=1');
    expect(normalizeUri('https://example.com/a?utm_medium=x')).toBe('https://example.com/a');
    expect(normalizeUri('https://example.com/a#:~:text=foo')).toBe('https://example.com/a');
  });
  it('unifies wayback snapshots and DOIs', () => {
    const a = normalizeUri('https://web.archive.org/web/20200101000000/https://example.com/a#x');
    const b = normalizeUri('http://web.archive.org/web/20231231235959id_/https://example.com/a');
    expect(a).toBe(b);
    expect(waybackOriginal('https://web.archive.org/web/2020/https://example.com/a')).toBe('https://example.com/a');
    expect(normalizeUri('doi:10.1000/ABC')).toBe('https://doi.org/10.1000/abc');
    expect(normalizeUri('https://dx.doi.org/10.1000/ABC')).toBe('https://doi.org/10.1000/abc');
  });
  it('compares uri sets', () => {
    expect(urisOverlap(['https://a.example/x#y'], ['https://a.example/x?utm_source=1'])).toBe(true);
    expect(urisOverlap(['https://a.example/x'], ['https://a.example/y'])).toBe(false);
  });
  it('builds text fragment urls', () => {
    expect(textFragmentUrl('https://a.example/x#old', 'hello-world', 'pre', 'suf')).toBe(
      'https://a.example/x#:~:text=pre-,hello%2Dworld,-suf',
    );
  });
});

describe('styles', () => {
  it('parses the default yaml to the default config', () => {
    const { config, error } = parseStyleConfig(DEFAULT_STYLES_YAML);
    expect(error).toBeUndefined();
    expect(config).toEqual(DEFAULT_STYLES);
  });
  it('rejects unsafe properties and values', () => {
    const { config } = parseStyleConfig(
      'tags:\n  x:\n    light: { color: "red; } body { display:none", background-color: blue, position: absolute }',
    );
    expect(config.tags[0].style.light).toEqual({ 'background-color': 'blue' });
  });
  it('resolves tags by priority and nesting', () => {
    expect(styleIndicesForTags(DEFAULT_STYLES, ['疑問', '重要/大', 'その他'])).toEqual([0, 2]);
    expect(styleIndicesForTags(DEFAULT_STYLES, [])).toEqual([]);
  });
  it('builds highlight css', () => {
    const css = buildHighlightCss(DEFAULT_STYLES);
    expect(css).toContain('::highlight(obsidiannot-t1) { text-decoration: underline 2px #2f6fde;');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });
});

describe('underlineOf', () => {
  it('省略形と個別の指定から下線を読む', async () => {
    const { underlineOf } = await import('../src/styles.ts');
    expect(underlineOf({ 'text-decoration': 'underline 2px #2f6fde', 'text-underline-offset': '3px' })).toEqual({
      style: 'solid',
      thickness: '2px',
      color: '#2f6fde',
      offset: '3px',
    });
    expect(underlineOf({ 'text-decoration': 'underline wavy 1.5px rgba(217, 48, 37, 0.8)' })).toEqual({
      style: 'wavy',
      thickness: '1.5px',
      color: 'rgba(217, 48, 37, 0.8)',
      offset: null,
    });
    expect(underlineOf({ 'text-decoration-line': 'underline', 'text-decoration-style': 'dotted', 'text-decoration-color': 'red' })).toMatchObject({
      style: 'dotted',
      color: 'red',
    });
    expect(underlineOf({ 'background-color': 'yellow' })).toBeNull();
    expect(underlineOf({ 'text-decoration': 'line-through red' })).toBeNull();
  });
});
