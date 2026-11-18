import { describe, expect, it } from 'vitest';
import { normalizeUri, textFragmentUrl, urisOverlap, waybackOriginal } from '../src/url.ts';
import {
  DEFAULT_STYLES,
  DEFAULT_STYLES_YAML,
  buildHighlightCss,
  parseStyleConfig,
  styleConfigFromMarkdown,
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
  it('reads config from markdown and builds css', () => {
    const md = `説明\n\n\`\`\`annotation-styles\n${DEFAULT_STYLES_YAML}\`\`\`\n`;
    expect(styleConfigFromMarkdown(md).config).toEqual(DEFAULT_STYLES);
    const css = buildHighlightCss(DEFAULT_STYLES);
    expect(css).toContain('::highlight(a08-t1) { text-decoration: underline 2px #2f6fde;');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });
});
