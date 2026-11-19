/** lucide のアイコン（ISC License）。Obsidian と同じ名前で使う */
import { BookOpen, Check, Gem, MessageSquareQuote, PenLine, Pencil, Star, X, createElement } from 'lucide';

const ICONS = {
  'book-open': BookOpen,
  check: Check,
  gem: Gem,
  'message-square-quote': MessageSquareQuote,
  'pen-line': PenLine,
  pencil: Pencil,
  star: Star,
  x: X,
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGElement {
  const el = createElement(ICONS[name]);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('class', `svg-icon lucide lucide-${name}`);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export function iconHtml(name: IconName, size = 16): string {
  return icon(name, size).outerHTML;
}
