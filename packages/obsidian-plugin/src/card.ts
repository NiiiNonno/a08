/**
 * ```obsidiannot ブロックを「引用カード」として描く。
 * カード全体のクリックで、ブラウザの該当箇所を開く。
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
  /** 引用の前後の文脈も表示する */
  showContext: boolean;
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
  el.addClass('obsidiannot-card-host');
  let a: AnnotationData;
  try {
    a = parseYaml(source);
    if (!a || typeof a !== 'object' || a.id == null) throw new Error('id がありません');
  } catch (e) {
    const err = el.createDiv({ cls: 'obsidiannot-card obsidiannot-card-error' });
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

  const card = el.createDiv({ cls: 'obsidiannot-card' });
  card.dataset.annotationId = a.id;
  card.style.setProperty('--obsidiannot-accent', accentColor(st, ctx.dark));
  if (tags.length) card.dataset.tags = tags.join(' ');
  if (a.source) card.setAttr('title', a.source);

  const q = a.selector.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
  const quote = card.createEl('blockquote', { cls: 'obsidiannot-quote' });
  if (ctx.showContext && q?.prefix) {
    quote.createSpan({ cls: 'obsidiannot-context', text: `…${q.prefix.replace(/\s+/g, ' ').slice(-24)}` });
  }
  quote.createSpan({ cls: 'obsidiannot-exact', text: displayQuote(quoteOf(a)) || '（引用なし）' });
  if (ctx.showContext && q?.suffix) {
    quote.createSpan({ cls: 'obsidiannot-context', text: `${q.suffix.replace(/\s+/g, ' ').slice(0, 24)}…` });
  }

  const meta = card.createDiv({ cls: 'obsidiannot-meta' });
  if (a.source) meta.createSpan({ cls: 'obsidiannot-source', text: hostOf(a.source) });
  if (a.created) meta.createSpan({ cls: 'obsidiannot-created', text: formatDate(String(a.created)) });
  for (const t of tags) meta.createSpan({ cls: 'obsidiannot-tag', text: `#${t}` });
  if (a.source) meta.createSpan({ cls: 'obsidiannot-open-hint', text: 'Click to open in browser' });

  // Live Preview ではクリックでソース編集に入るのを止める（編集はブロック右上の </> から）
  const stop = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  card.addEventListener('mousedown', stop);
  card.addEventListener('click', ev => {
    stop(ev);
    if (a.source) ctx.onReveal(a);
  });
}

export function renderStylesPreview(config: StyleConfig, el: HTMLElement, dark: boolean, error?: string) {
  const box = el.createDiv({ cls: 'obsidiannot-styles' });
  if (error) box.createDiv({ cls: 'obsidiannot-card-error', text: `設定を読めません（既定値を使用中）: ${error}` });
  const row = (label: string, decl: Record<string, string | undefined>) => {
    const r = box.createDiv({ cls: 'obsidiannot-style-row' });
    r.createSpan({ cls: 'obsidiannot-style-label', text: label });
    const sample = r.createSpan({ cls: 'obsidiannot-style-sample', text: 'ハイライトの見本 Sample text' });
    for (const [k, v] of Object.entries(decl)) if (v) sample.style.setProperty(k, v);
  };
  const pick = (s: StyleConfig['default']) => (dark && s.dark) || s.light;
  row('（タグなし）', pick(config.default));
  for (const t of config.tags) row(`#${t.tag}`, pick(t.style));
}
