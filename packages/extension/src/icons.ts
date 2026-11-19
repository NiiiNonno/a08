/** lucide のアイコン（ISC License）。Obsidian と同じ名前で使う */
import { BookOpen, Check, FilePlus, MessageSquareQuote, PenLine, Pencil, Star, Trash2, X, createElement } from 'lucide';

const ICONS = {
  'book-open': BookOpen,
  check: Check,
  'file-plus': FilePlus,
  'message-square-quote': MessageSquareQuote,
  'pen-line': PenLine,
  pencil: Pencil,
  star: Star,
  'trash-2': Trash2,
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
