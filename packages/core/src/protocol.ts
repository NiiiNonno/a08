/**
 * Chrome 拡張 ⇄ Obsidian プラグイン間の WebSocket メッセージ。
 *
 * 接続: ws://127.0.0.1:<port>/?token=<token>
 * - 拡張 → プラグイン: Request（id 付き）。プラグインは同じ id で Response を返す
 * - プラグイン → 拡張: Event（id なし）
 */
import type { AnnotationData, Selector } from './types.ts';
import type { StyleConfig } from './styles.ts';

export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 27183;

export type AnnotationView = AnnotationData & {
  comment: string;
  tags: string[];
  /** Obsidian のブロック ID（`^` なし）。照で付く */
  blockId?: string;
  startLine: number;
  endLine: number;
};

export type NoteView = {
  path: string;
  /** 楽観的排他制御用。内容のハッシュ */
  version: string;
  content: string;
  titles: string[];
  uris: string[];
  annotations: AnnotationView[];
};

export type ThemeInfo = {
  dark: boolean;
  /** Obsidian の CSS 変数（--background-primary など） */
  vars: Record<string, string>;
  /** appearance の版。変わったらサイドパネルが取り直す */
  cssVersion?: string;
};

/** サイドパネルで Obsidian と同じ見た目にするための CSS */
export type Appearance = {
  version: string;
  /** Obsidian の全スタイルシート（テーマ・スニペット・プラグインを含む）。body/html は書き換え済み */
  css: string;
  /** Obsidian の body の class（theme-dark など） */
  bodyClass: string;
  /** body / html のインライン style（アクセントカラー --accent-h などはここに入る） */
  bodyStyle?: string;
  rootStyle?: string;
};

export type RequestMap = {
  /** 接続維持（MV3 の service worker は通信がないと止まる） */
  ping: { params: Record<string, never>; result: 'pong' };
  hello: {
    params: { client: string; version: number };
    result: { vault: string; folder: string; styles: StyleConfig; theme: ThemeInfo; version: number };
  };
  /** 閲覧中ページの候補 URI からノートを探す */
  lookup: { params: { uris: string[] }; result: NoteView | null };
  getNote: { params: { path: string }; result: NoteView | null };
  createAnnotation: {
    params: {
      /** 先頭が閲覧中のページの URL。ほかは canonical や DOI など */
      uris: string[];
      title: string;
      /** 註をつけた文書の URI（通常は uris[0]） */
      source: string;
      selector: Selector[];
      comment?: string;
      /** 既にノートがあるときに使う（なければ uris から探す/作る） */
      path?: string;
      /** 照: ブロック ID を付けてリンクを返す */
      blockId?: boolean;
    };
    result: { note: NoteView; id: string; link?: string };
  };
  /** 照: 註にブロック ID を付け（なければ）、ブロックへの内部リンクを返す */
  linkToAnnotation: {
    params: { path: string; id: string };
    result: { note: NoteView; link: string };
  };
  /** ノートのファイル名を変える（name は拡張子なし）。Obsidian ではリンクも更新される */
  renameNote: {
    params: { path: string; name: string };
    result: { note: NoteView };
  };
  /** コメントだけを書き換える */
  updateComment: {
    params: { path: string; id: string; comment: string };
    result: { note: NoteView };
  };
  deleteAnnotation: {
    params: { path: string; id: string };
    result: { note: NoteView };
  };
  /** ノート全体を保存する。baseVersion が現在と違えば conflict エラー */
  saveNote: {
    params: { path: string; content: string; baseVersion: string };
    result: { note: NoteView };
  };
  /** Obsidian のレンダラーで HTML にする */
  render: { params: { path: string }; result: { html: string } };
  /** Obsidian の CSS 一式 */
  appearance: { params: Record<string, never>; result: Appearance | null };
  /** vault 内の画像（描画結果の data-obsidiannot-resource） */
  getResource: { params: { path: string }; result: { mime: string; base64: string } };
  openInObsidian: { params: { path: string; id?: string }; result: null };
  /** markdown 中の内部リンクを Obsidian で開く */
  openLink: { params: { link: string; sourcePath: string }; result: null };
};

export type RequestType = keyof RequestMap;

export type Request<T extends RequestType = RequestType> = {
  id: number;
  type: T;
  params: RequestMap[T]['params'];
};

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string; data?: unknown } };

export type EventMap = {
  noteChanged: { path: string; note: NoteView | null };
  stylesChanged: { styles: StyleConfig };
  themeChanged: { theme: ThemeInfo };
  /** Obsidian で註がクリックされた。ブラウザで該当箇所を出す */
  reveal: {
    path: string;
    id: string;
    uris: string[];
    source: string;
    /** Text Fragment 付き URL（タブがないとき開く URL） */
    url: string;
  };
};

export type EventType = keyof EventMap;
export type ServerEvent<T extends EventType = EventType> = {
  event: T;
  data: EventMap[T];
};

export class ProtocolError extends Error {
  code: string;
  data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
