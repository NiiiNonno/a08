/**
 * 本文を選んだときに出る、註・照のボタン（Chrome 拡張の adder にあたるもの）。
 * 編集表示・閲覧表示のどちらでも出る。選んだ範囲は「再配置」のために覚えておく。
 */
import { FileView, MarkdownView, setIcon, type View } from 'obsidian';
import type ObsidiannotPlugin from '../main.ts';
import type { LocalAnnotations, SourceRange } from './manager.ts';

export class SelectionAdder {
  private el: HTMLElement | null = null;
  private current: SourceRange | null = null;
  private timer: number | undefined;

  constructor(
    private plugin: ObsidiannotPlugin,
    private local: LocalAnnotations,
  ) {}

  register() {
    const doc = document;
    const schedule = () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.update(), 180);
    };
    this.plugin.registerDomEvent(doc, 'selectionchange', schedule);
    this.plugin.registerDomEvent(doc, 'mouseup', schedule);
    this.plugin.registerDomEvent(doc, 'keyup', schedule);
    this.plugin.registerDomEvent(doc, 'scroll', () => this.hide(), { capture: true });
    this.plugin.register(() => this.el?.remove());
  }

  /** 今の選択範囲（ボタン・コマンド用） */
  selection(): SourceRange | null {
    return this.local.selectionInView(this.plugin.app.workspace.getActiveViewOfType(FileView));
  }

  private update() {
    // ノート（MarkdownView）と PDF のビュー
    const view = this.plugin.app.workspace.getActiveViewOfType(FileView);
    const r = this.local.selectionInView(view);
    if (!view || !r) {
      // ボタンを押している途中は消さない
      if (!this.el?.matches(':hover')) this.hide();
      return;
    }
    this.current = r;
    this.local.rememberSelection(r);
    const rect = this.selectionRect(view);
    if (!rect) return this.hide();
    this.show(rect);
  }

  private selectionRect(view: View): DOMRect | null {
    const sel = view.containerEl.ownerDocument.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const rects = sel.getRangeAt(0).getClientRects();
      const last = rects[rects.length - 1];
      if (last) return last;
    }
    // 編集表示でフォーカスが外れていると DOM の選択がないので、エディタから位置を取る
    if (!(view instanceof MarkdownView)) return null;
    const cm = (view.editor as unknown as { cm?: { coordsAtPos(p: number): { left: number; right: number; top: number; bottom: number } | null } }).cm;
    const c = this.current && cm?.coordsAtPos(this.current.end);
    return c ? new DOMRect(c.left, c.top, 1, c.bottom - c.top) : null;
  }

  private show(rect: DOMRect) {
    if (!this.el) {
      this.el = document.body.createDiv({ cls: 'obsidiannot-adder' });
      const button = (icon: string, label: string, kind: 'chu' | 'sho') => {
        const b = this.el!.createEl('button', { attr: { 'aria-label': label, title: label } });
        setIcon(b, icon);
        b.createSpan({ text: label.slice(0, 1) });
        // 押したときに選択範囲が外れないように
        b.addEventListener('mousedown', ev => ev.preventDefault());
        b.addEventListener('click', ev => {
          ev.preventDefault();
          const r = this.current;
          this.hide();
          if (r) void this.local.create(kind, r);
        });
      };
      button('message-square-quote', '註（コメントを付ける）', 'chu');
      button('star', '照（ハイライトしてリンクをコピー）', 'sho');
    }
    const el = this.el;
    el.style.display = 'flex';
    const w = el.offsetWidth || 90;
    const left = Math.min(Math.max(8, rect.right - w / 2), window.innerWidth - w - 8);
    const top = rect.bottom + 8 + 36 > window.innerHeight ? rect.top - 8 - 36 : rect.bottom + 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  hide() {
    if (this.el) this.el.style.display = 'none';
  }
}
