/**
 * ```annotation ブロックを「引用カード」として描く。
 */
import { parse as parseYaml } from 'yaml';
import {
  accentColor,
  displayQuote,
  parseNote,
  quoteOf,
  styleIndicesForTags,
  type AnnotationData,
  type StyleConfig,
  type TextQuoteSelector,
} from '@a08/core';

export type CardContext = {
  /** ブロックを含むノートの全文（タグを知るため）。取れなければ null */
  noteText: string | null;
  styles: StyleConfig;
  dark: boolean;
  onReveal: (a: AnnotationData) => void;
};

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || u.protocol.replace(/:$/, '');
  } catch {
    return uri;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderCard(source: string, el: HTMLElement, ctx: CardContext) {
  el.addClass('a08-card-host');
  let a: AnnotationData;
  try {
    a = parseYaml(source);
    if (!a || typeof a !== 'object' || a.id == null) throw new Error('id がありません');
  } catch (e) {
    const err = el.createDiv({ cls: 'a08-card a08-card-error' });
    err.createDiv({ text: `註ブロックを読めません: ${e instanceof Error ? e.message : e}` });
    err.createEl('pre', { text: source });
    return;
  }
  a.id = String(a.id);
  a.selector = Array.isArray(a.selector) ? a.selector : [];

  let tags: string[] = [];
  if (ctx.noteText) {
    const found = parseNote(ctx.noteText).annotations.find(x => x.id === a.id);
    if (found) tags = found.tags;
  }
  const idx = styleIndicesForTags(ctx.styles, tags);
  const st = idx.length ? ctx.styles.tags[idx[0]].style : ctx.styles.default;

  const card = el.createDiv({ cls: 'a08-card' });
  card.dataset.annotationId = a.id;
  card.style.setProperty('--a08-accent', accentColor(st, ctx.dark));
  if (tags.length) card.dataset.tags = tags.join(' ');

  const q = a.selector.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
  const quote = card.createEl('blockquote', { cls: 'a08-quote' });
  if (q?.prefix) quote.createSpan({ cls: 'a08-context', text: `…${q.prefix.replace(/\s+/g, ' ').slice(-24)}` });
  quote.createSpan({ cls: 'a08-exact', text: displayQuote(quoteOf(a)) || '（引用なし）' });
  if (q?.suffix) quote.createSpan({ cls: 'a08-context', text: `${q.suffix.replace(/\s+/g, ' ').slice(0, 24)}…` });

  const meta = card.createDiv({ cls: 'a08-meta' });
  if (a.source) {
    const src = meta.createEl('a', { cls: 'a08-source', text: hostOf(a.source), href: a.source });
    src.setAttr('title', a.source);
    src.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      ctx.onReveal(a);
    });
  }
  if (a.created) meta.createSpan({ cls: 'a08-created', text: formatDate(String(a.created)) });
  for (const t of tags) meta.createSpan({ cls: 'a08-tag', text: `#${t}` });

  const btn = meta.createEl('button', { cls: 'a08-reveal', text: 'ブラウザで開く' });
  btn.dataset.a08Action = 'reveal';
  btn.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    ctx.onReveal(a);
  });
  quote.addEventListener('click', ev => {
    // Live Preview でクリックするとソース編集に入るので、修飾キー付きのときだけ移動する
    if (ev.ctrlKey || ev.metaKey || card.closest('.markdown-reading-view, .markdown-preview-view')) {
      ev.preventDefault();
      ctx.onReveal(a);
    }
  });
}

export function renderStylesPreview(config: StyleConfig, el: HTMLElement, dark: boolean, error?: string) {
  const box = el.createDiv({ cls: 'a08-styles' });
  if (error) box.createDiv({ cls: 'a08-card-error', text: `設定を読めません（既定値を使用中）: ${error}` });
  const row = (label: string, decl: Record<string, string | undefined>) => {
    const r = box.createDiv({ cls: 'a08-style-row' });
    r.createSpan({ cls: 'a08-style-label', text: label });
    const sample = r.createSpan({ cls: 'a08-style-sample', text: 'ハイライトの見本 Sample text' });
    for (const [k, v] of Object.entries(decl)) if (v) sample.style.setProperty(k, v);
  };
  const pick = (s: StyleConfig['default']) => (dark && s.dark) || s.light;
  row('（タグなし）', pick(config.default));
  for (const t of config.tags) row(`#${t.tag}`, pick(t.style));
}
