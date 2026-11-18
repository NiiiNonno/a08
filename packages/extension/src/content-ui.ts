/** content script の Shadow DOM 用 CSS */
export const UI_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.adder, .editor, .toast {
  position: absolute;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  color: #1f2328;
  background: #ffffff;
  border: 1px solid rgba(0,0,0,.15);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,.18);
}
.adder { display: flex; padding: 2px; gap: 2px; }
.adder[hidden], .editor[hidden], .toast[hidden] { display: none; }
button {
  font: inherit;
  color: inherit;
  background: transparent;
  border: none;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  white-space: nowrap;
}
button:hover { background: rgba(0,0,0,.07); }
button.primary { background: #2f6fde; color: #fff; }
button.primary:hover { background: #255fc4; }
.editor { width: 340px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.editor .quote {
  max-height: 5.5em;
  overflow: auto;
  color: #57606a;
  border-left: 3px solid rgba(255,190,0,.9);
  padding-left: 8px;
  white-space: pre-wrap;
}
.editor textarea {
  font: inherit;
  color: inherit;
  background: #f6f8fa;
  border: 1px solid rgba(0,0,0,.15);
  border-radius: 6px;
  min-height: 6em;
  resize: vertical;
  padding: 6px;
  outline: none;
}
.editor textarea:focus { border-color: #2f6fde; }
.editor .row { display: flex; gap: 6px; align-items: center; }
.editor .hint { flex: 1; color: #8c959f; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast {
  position: fixed;
  right: 16px;
  bottom: 16px;
  padding: 8px 14px;
}
.toast.error { border-color: #d93025; color: #b42318; }
.markers { position: absolute; top: 0; left: 0; width: 0; height: 0; }
.marker {
  position: absolute;
  width: 5px;
  border-radius: 3px;
  background: var(--c, rgba(255,200,0,.8));
  opacity: .75;
  cursor: pointer;
}
.marker:hover { opacity: 1; width: 7px; }
@media (prefers-color-scheme: dark) {
  .adder, .editor, .toast { color: #e6edf3; background: #22272e; border-color: rgba(255,255,255,.15); }
  button:hover { background: rgba(255,255,255,.1); }
  .editor textarea { background: #1c2128; border-color: rgba(255,255,255,.15); }
  .editor .quote { color: #9da7b3; }
  .toast.error { color: #ff7b72; }
}
`;
