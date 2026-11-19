/**
 * 編集表示（ソース・Live Preview）の註のハイライト。
 *
 * 註の範囲はエディタの状態の中で持ち、編集のたびに差分の分だけずらす（文字列を探し直さない）。
 * 範囲やその前後の文脈に触れる編集があった註にだけ「確認が必要」の印を付け、
 * 打鍵が止まってから印の付いた註だけを確かめる（onIdle）。
 */
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { CONTEXT_LENGTH, type AnchorStatus } from '@a08/core';

export type EditorAnno = {
  id: string;
  from: number;
  to: number;
  status: AnchorStatus;
  /** スタイルのクラス名の末尾（default, t0, ...） */
  styleKey: string;
  /** 範囲か前後の文脈に触れる編集があった */
  dirty?: boolean;
};

type FieldValue = { annos: EditorAnno[]; flash: string | null };

export const setAnnos = StateEffect.define<EditorAnno[]>();
export const setFlash = StateEffect.define<string | null>();

export const annoField = StateField.define<FieldValue>({
  create: () => ({ annos: [], flash: null }),
  update(value, tr) {
    let v = value;
    if (tr.docChanged && v.annos.length) {
      const annos = v.annos.map(a => {
        // 範囲の端への入力は範囲に含めない
        let from = tr.changes.mapPos(a.from, 1);
        let to = tr.changes.mapPos(a.to, -1);
        if (to < from) to = from;
        let dirty = a.dirty;
        if (!dirty) {
          tr.changes.iterChangedRanges((fromA, toA) => {
            if (fromA <= a.to + CONTEXT_LENGTH && toA >= a.from - CONTEXT_LENGTH) dirty = true;
          });
        }
        if (from === a.from && to === a.to && dirty === a.dirty) return a;
        return { ...a, from, to, dirty };
      });
      v = { ...v, annos };
    }
    for (const e of tr.effects) {
      if (e.is(setAnnos)) v = { ...v, annos: e.value };
      else if (e.is(setFlash)) v = { ...v, flash: e.value };
    }
    return v;
  },
  provide: f => EditorView.decorations.from(f, buildDecorations),
});

function buildDecorations(v: FieldValue): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const a of v.annos) {
    if (a.status === 'orphan' || a.to <= a.from) continue;
    const cls = ['obsidiannot-mark', `obsidiannot-mark-${a.styleKey}`];
    if (a.status === 'tentative') cls.push('is-tentative');
    if (v.flash === a.id) cls.push('is-flash');
    ranges.push(Decoration.mark({ class: cls.join(' '), attributes: { 'data-obsidiannot-id': a.id } }).range(a.from, a.to));
  }
  return Decoration.set(ranges, true);
}

export type EditorHooks = {
  /** エディタができた（ファイルを開いた）とき */
  attached(view: EditorView, path: string): void;
  /** 打鍵が止まったとき（確認が必要な註か、見つからない註があるときだけ） */
  idle(view: EditorView, path: string): void;
  /** 見つからない註がある（消した文を戻したときに探し直すため） */
  hasOrphans(path: string): boolean;
  /** ハイライトを押したとき */
  clicked(path: string, id: string): void;
};

export function editorPath(view: EditorView): string | null {
  return view.state.field(editorInfoField, false)?.file?.path ?? null;
}

export function localEditorExtension(hooks: EditorHooks, idleMs = 1500): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: number | undefined;
      private path: string | null;
      constructor(private view: EditorView) {
        this.path = editorPath(view);
        const p = this.path;
        if (p) window.setTimeout(() => hooks.attached(view, p), 0);
      }
      update(u: ViewUpdate) {
        const p = editorPath(u.view);
        if (p !== this.path) {
          this.path = p;
          if (p) window.setTimeout(() => hooks.attached(u.view, p), 0);
        }
        if (!u.docChanged) return;
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          const path = editorPath(this.view);
          if (path && (this.view.state.field(annoField).annos.some(a => a.dirty) || hooks.hasOrphans(path))) hooks.idle(this.view, path);
        }, idleMs);
      }
      destroy() {
        window.clearTimeout(this.timer);
      }
    },
    {
      eventHandlers: {
        click(ev, view) {
          const el = (ev.target as HTMLElement | null)?.closest?.('[data-obsidiannot-id]') as HTMLElement | null;
          const id = el?.dataset.obsidiannotId;
          const path = editorPath(view);
          // 範囲選択中や修飾キー付きのクリックは邪魔しない
          if (id && path && view.state.selection.main.empty) hooks.clicked(path, id);
        },
      },
    },
  );
  return [annoField, plugin];
}
