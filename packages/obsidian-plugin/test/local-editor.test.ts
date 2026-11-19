import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { anchorQuote, quoteAnchorOf, selectorsForRange } from '@a08/core';
import { annoField, setAnnos } from '../src/local/editor.ts';

const PAD = 'あいうえおかきくけこさしすせそたちつてとなにぬねの'.repeat(3);
const TEXT = `${PAD}前の段落。\n\n大切な一文がここにある。後ろの文。\n\nずっと後ろの段落。${PAD}`;

function setup() {
  const from = TEXT.indexOf('大切な一文');
  const to = from + '大切な一文'.length;
  let state = EditorState.create({ doc: TEXT, extensions: [annoField] });
  state = state.update({ effects: setAnnos.of([{ id: 'a', from, to, status: 'ok', styleKey: 'default' }]) }).state;
  return { state, from, to };
}

const anno = (s: EditorState) => s.field(annoField).annos[0];

describe('annoField（編集の差分で位置をずらす）', () => {
  it('前に文字を足すと、その分だけずれる（文字列は探し直さない）', () => {
    const { state, from, to } = setup();
    const s = state.update({ changes: { from: 0, insert: 'あいう' } }).state;
    expect(anno(s)).toMatchObject({ from: from + 3, to: to + 3 });
    // 遠い編集では確認の印は付かない
    expect(anno(s).dirty).toBeFalsy();
  });

  it('後ろの段落の編集では動かない', () => {
    const { state, from, to } = setup();
    const s = state.update({ changes: { from: TEXT.length, insert: '追記' } }).state;
    expect(anno(s)).toMatchObject({ from, to });
    expect(anno(s).dirty).toBeFalsy();
  });

  it('範囲の中の編集は範囲が伸び、確認の印が付く', () => {
    const { state, from, to } = setup();
    const s = state.update({ changes: { from: from + 3, insert: 'とても' } }).state;
    expect(anno(s)).toMatchObject({ from, to: to + 3, dirty: true });
  });

  it('範囲の端への入力は範囲に含めない', () => {
    const { state, from, to } = setup();
    let s = state.update({ changes: { from, insert: 'X' } }).state;
    expect(anno(s)).toMatchObject({ from: from + 1, to: to + 1 });
    s = s.update({ changes: { from: to + 1, insert: 'Y' } }).state;
    expect(anno(s)).toMatchObject({ from: from + 1, to: to + 1 });
  });

  it('前後の文脈の近くの編集にも確認の印が付く', () => {
    const { state, to } = setup();
    const s = state.update({ changes: { from: to + 5, insert: 'Z' } }).state;
    expect(anno(s).dirty).toBe(true);
  });

  it('中を書き換えたあとの確認で、前後の文脈から新しい引用文になる', () => {
    const { state, from, to } = setup();
    const quote = quoteAnchorOf(selectorsForRange(TEXT, from, to))!;
    const s = state.update({ changes: { from: from + 3, to: from + 5, insert: '二文' } }).state;
    const e = anno(s);
    const r = anchorQuote(s.doc.toString(), { ...quote, start: e.from });
    expect(r).toMatchObject({ status: 'changed', start: e.from, end: e.to, exact: '大切な二文' });
  });
});
