/**
 * タグごとのハイライトの見た目。
 *
 * vault の `annotations/_styles.md` 内の ```annotation-styles ブロック（YAML）で設定する:
 *
 *   default:
 *     light: { background-color: "rgba(255, 226, 0, 0.28)" }
 *     dark:  { background-color: "rgba(255, 210, 0, 0.22)" }
 *   tags:
 *     重要:
 *       light: { background-color: "rgba(255, 196, 0, 0.55)" }
 *     定義:
 *       light: { text-decoration: "underline 2px #2f6fde" }
 *
 * - tags に書いた順が優先順位（上ほど強い）
 * - 註が複数のタグを持つと、該当するスタイルが重ねて描かれる（背景＋下線など）
 * - 入れ子タグ（重要/大）は、完全一致がなければ親（重要）のスタイルを使う
 * - どのタグにも当たらない註は default
 * - 使えるプロパティは CSS Custom Highlight API が許すものだけ
 */
import { parse as parseYaml } from 'yaml';
import { tagAncestors } from './tags.ts';

export const STYLES_LANG = 'annotation-styles';

export const ALLOWED_PROPERTIES = [
  'color',
  'background-color',
  'text-decoration',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-color',
  'text-decoration-thickness',
  'text-underline-offset',
  'text-shadow',
] as const;

export type StyleDecl = Partial<Record<(typeof ALLOWED_PROPERTIES)[number], string>>;

export type HighlightStyle = {
  light: StyleDecl;
  /** 省略時は light と同じ */
  dark?: StyleDecl;
};

export type StyleConfig = {
  default: HighlightStyle;
  /** 優先順位順 */
  tags: { tag: string; style: HighlightStyle }[];
};

export const DEFAULT_STYLES: StyleConfig = {
  default: {
    light: { 'background-color': 'rgba(255, 226, 0, 0.28)' },
    dark: { 'background-color': 'rgba(255, 214, 10, 0.22)' },
  },
  tags: [
    {
      tag: '重要',
      style: {
        light: { 'background-color': 'rgba(255, 190, 0, 0.55)' },
        dark: { 'background-color': 'rgba(255, 190, 0, 0.42)' },
      },
    },
    {
      tag: '定義',
      style: {
        light: { 'text-decoration': 'underline 2px #2f6fde', 'text-underline-offset': '3px' },
        dark: { 'text-decoration': 'underline 2px #7aa7ff', 'text-underline-offset': '3px' },
      },
    },
    {
      tag: '疑問',
      style: {
        light: { 'text-decoration': 'underline wavy 1.5px #d93025', 'text-underline-offset': '3px' },
        dark: { 'text-decoration': 'underline wavy 1.5px #ff7b72', 'text-underline-offset': '3px' },
      },
    },
    {
      tag: '引用',
      style: {
        light: { 'background-color': 'rgba(52, 168, 83, 0.25)' },
        dark: { 'background-color': 'rgba(63, 185, 80, 0.25)' },
      },
    },
  ],
};

export const DEFAULT_STYLES_YAML = `# タグごとのハイライト。上にあるタグほど優先されます。
# 使えるプロパティ: ${ALLOWED_PROPERTIES.join(', ')}
default:
  light: { background-color: "rgba(255, 226, 0, 0.28)" }
  dark: { background-color: "rgba(255, 214, 10, 0.22)" }
tags:
  重要:
    light: { background-color: "rgba(255, 190, 0, 0.55)" }
    dark: { background-color: "rgba(255, 190, 0, 0.42)" }
  定義:
    light: { text-decoration: "underline 2px #2f6fde", text-underline-offset: 3px }
    dark: { text-decoration: "underline 2px #7aa7ff", text-underline-offset: 3px }
  疑問:
    light: { text-decoration: "underline wavy 1.5px #d93025", text-underline-offset: 3px }
    dark: { text-decoration: "underline wavy 1.5px #ff7b72", text-underline-offset: 3px }
  引用:
    light: { background-color: "rgba(52, 168, 83, 0.25)" }
    dark: { background-color: "rgba(63, 185, 80, 0.25)" }
`;

function safeValue(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!s || s.length > 200) return null;
  if (/[;{}<>\\]|\/\*|\*\/|url\s*\(|expression\s*\(|@import/i.test(s)) return null;
  return s;
}

function parseDecl(v: unknown): StyleDecl {
  const out: StyleDecl = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.trim().toLowerCase();
    if (!(ALLOWED_PROPERTIES as readonly string[]).includes(key)) continue;
    const sv = safeValue(val);
    if (sv) out[key as keyof StyleDecl] = sv;
  }
  return out;
}

function parseStyle(v: unknown): HighlightStyle | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if ('light' in o || 'dark' in o) {
    const light = parseDecl(o.light);
    const dark = o.dark ? parseDecl(o.dark) : undefined;
    return { light, dark };
  }
  // light/dark を省略して直接書いた場合
  return { light: parseDecl(o) };
}

/** YAML 文字列から設定を読む。壊れていれば既定値を返す */
export function parseStyleConfig(yamlText: string): { config: StyleConfig; error?: string } {
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch (e) {
    return { config: DEFAULT_STYLES, error: String(e) };
  }
  if (!data || typeof data !== 'object') return { config: DEFAULT_STYLES, error: 'not a mapping' };
  const d = data as Record<string, unknown>;
  const def = parseStyle(d.default) ?? DEFAULT_STYLES.default;
  const tags: StyleConfig['tags'] = [];
  if (Array.isArray(d.tags)) {
    for (const item of d.tags) {
      if (item && typeof item === 'object' && 'tag' in item) {
        const st = parseStyle(item);
        if (st) tags.push({ tag: String((item as { tag: unknown }).tag).replace(/^#/, ''), style: st });
      }
    }
  } else if (d.tags && typeof d.tags === 'object') {
    for (const [tag, v] of Object.entries(d.tags as Record<string, unknown>)) {
      const st = parseStyle(v);
      if (st) tags.push({ tag: tag.replace(/^#/, ''), style: st });
    }
  }
  return { config: { default: def, tags } };
}

/** markdown 中の ```annotation-styles ブロックを探して読む */
export function styleConfigFromMarkdown(md: string): { config: StyleConfig; error?: string } {
  const m = md.match(/^ {0,3}(`{3,}|~{3,})\s*annotation-styles\s*\n([\s\S]*?)\n {0,3}\1\s*$/m);
  if (!m) return { config: DEFAULT_STYLES, error: 'no annotation-styles block' };
  return parseStyleConfig(m[2]);
}

/** ハイライト名。CSS 識別子として安全なもの */
export function highlightName(index: number | 'default' | 'focus' | 'hover'): string {
  return typeof index === 'number' ? `a08-t${index}` : `a08-${index}`;
}

/**
 * 註のタグから、使うスタイルの番号（config.tags の添字）を求める。
 * 空配列なら default。
 */
export function styleIndicesForTags(config: StyleConfig, tags: string[]): number[] {
  const idx = new Set<number>();
  for (const tag of tags) {
    for (const t of tagAncestors(tag)) {
      const i = config.tags.findIndex(s => s.tag === t);
      if (i >= 0) {
        idx.add(i);
        break;
      }
    }
  }
  return [...idx].sort((a, b) => a - b);
}

function declToCss(decl: StyleDecl): string {
  return Object.entries(decl)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
}

/** ::highlight() 用の CSS を作る */
export function buildHighlightCss(config: StyleConfig): string {
  const light: string[] = [];
  const dark: string[] = [];
  const add = (name: string, st: HighlightStyle) => {
    light.push(`::highlight(${name}) { ${declToCss(st.light)} }`);
    if (st.dark) dark.push(`::highlight(${name}) { ${declToCss(st.dark)} }`);
  };
  add(highlightName('default'), config.default);
  config.tags.forEach((t, i) => add(highlightName(i), t.style));
  // ホバー・フォーカス中の註
  light.push(`::highlight(${highlightName('hover')}) { background-color: rgba(255, 140, 0, 0.30); }`);
  light.push(`::highlight(${highlightName('focus')}) { background-color: rgba(255, 120, 0, 0.55); }`);
  dark.push(`::highlight(${highlightName('hover')}) { background-color: rgba(255, 150, 40, 0.30); }`);
  dark.push(`::highlight(${highlightName('focus')}) { background-color: rgba(255, 140, 30, 0.50); }`);
  return `${light.join('\n')}\n@media (prefers-color-scheme: dark) {\n${dark.join('\n')}\n}\n`;
}

/** カードの左線などに使う代表色 */
export function accentColor(st: HighlightStyle, dark = false): string {
  const d = (dark && st.dark) || st.light;
  if (d['text-decoration-color']) return d['text-decoration-color'];
  const td = d['text-decoration'];
  if (td) {
    const m = td.match(/(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|\b[a-z]+\b)\s*$/i);
    if (m) return m[1];
  }
  if (d['background-color']) return d['background-color'];
  if (d.color) return d.color;
  return 'rgba(255, 200, 0, 0.8)';
}
