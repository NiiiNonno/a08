/** テスト用の obsidian の代わり（editor.ts が使うものだけ） */
import { StateField } from '@codemirror/state';

export const editorInfoField = StateField.define<{ file: { path: string } | null }>({
  create: () => ({ file: { path: 'note.md' } }),
  update: v => v,
});
