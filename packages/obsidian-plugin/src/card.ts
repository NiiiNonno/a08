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
  /** 描いたカードに手を加える（vault 内のノートへの註の状態表示など） */
  decorate?: (card: HTMLElement, a: AnnotationData) => void;
};

/** vault 内のノートへの註か（source が URL でなく [[リンク]] やパス） */
export function isLocalSource(source: string): boolean {
  return !!source && !/^[a-z][a-z0-9+.-]*:/i.test(source.trim());
}

function localName(source: string): string {
  const m = source.match(/^\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]\s*$/);
  const name = m ? (m[2] ?? m[1]) : source;
  return name.split('/').pop()!.replace(/\.md$/, '');
}

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
  const card = el.createDiv({ cls: 'obsidiannot-card' });
  card.dataset.annotationId = a.id;
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

  const local = isLocalSource(a.source);
  const meta = card.createDiv({ cls: 'obsidiannot-meta' });
  if (a.source) meta.createSpan({ cls: 'obsidiannot-source', text: local ? localName(a.source) : hostOf(a.source) });
  if (a.created) meta.createSpan({ cls: 'obsidiannot-created', text: formatDate(String(a.created)) });
  if (a.source) meta.createSpan({ cls: 'obsidiannot-open-hint', text: local ? 'Click to open' : 'Click to open in browser' });
  applyCardTags(card, tags, ctx.styles, ctx.dark);

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
  ctx.decorate?.(card, a);
}

/**
 * カードの色とタグの表示を、コメントのタグに合わせる。
 * コメントはカード（コードブロック）の外にあるので、タグを書き換えてもカードは描き直されない。そのときにも呼ぶ。
 */
export function applyCardTags(card: HTMLElement, tags: string[], styles: StyleConfig, dark: boolean) {
  const idx = styleIndicesForTags(styles, tags);
  const st = idx.length ? styles.tags[idx[0]].style : styles.default;
  card.style.setProperty('--obsidiannot-accent', accentColor(st, dark));
  if (tags.length) card.dataset.tags = tags.join(' ');
  else delete card.dataset.tags;
  const meta = card.querySelector('.obsidiannot-meta');
  if (!meta) return;
  meta.querySelectorAll('.obsidiannot-tag').forEach(e => e.remove());
  const before = meta.querySelector('.obsidiannot-original, .obsidiannot-open-hint');
  for (const t of tags) {
    const span = (meta as HTMLElement).createSpan({ cls: 'obsidiannot-tag', text: `#${t}` });
    if (before) meta.insertBefore(span, before);
  }
}

/** ノートの全文から、その中のカードの色・タグを付け直す */
export function restyleCards(container: HTMLElement, noteText: string, styles: StyleConfig, dark: boolean) {
  const cards = container.querySelectorAll<HTMLElement>('.obsidiannot-card[data-annotation-id]');
  if (!cards.length) return;
  const tagsById = new Map(parseNote(noteText).annotations.map(a => [a.id, a.tags]));
  for (const card of Array.from(cards)) {
    const tags = tagsById.get(card.dataset.annotationId!);
    if (tags && tags.join(' ') !== (card.dataset.tags ?? '')) applyCardTags(card, tags, styles, dark);
  }
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
