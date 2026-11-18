/**
 * 拡張内部（background / content script / side panel）のメッセージ。
 */
import type { EventMap, EventType, NoteView, RequestMap, RequestType, StyleConfig, ThemeInfo } from '@a08/core';

export type Settings = {
  port: number;
  token: string;
  /** 対訳型翻訳などで挿入される要素。テキストとして扱わない */
  ignoreSelectors: string[];
};

export const DEFAULT_IGNORE_SELECTORS = [
  // Immersive Translate（沉浸式翻译）
  '.immersive-translate-target-wrapper',
  '[data-immersive-translate-translation-element-mark]',
];

export const DEFAULT_SETTINGS: Settings = {
  port: 27183,
  token: '',
  ignoreSelectors: DEFAULT_IGNORE_SELECTORS,
};

export async function loadSettings(): Promise<Settings> {
  const s = (await chrome.storage.local.get('settings')).settings as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

export type ConnectionStatus = {
  state: 'connected' | 'connecting' | 'disconnected' | 'unauthorized' | 'no-token';
  vault?: string;
  folder?: string;
  styles?: StyleConfig;
  theme?: ThemeInfo;
  error?: string;
};

export type PageInfo = {
  url: string;
  uris: string[];
  title: string;
  notePath: string | null;
  anchored: number;
  total: number;
  /** 特定できなかった註の id */
  orphans: string[];
};

/** → background */
export type BgMessage =
  | { kind: 'rpc'; type: RequestType; params: unknown }
  | { kind: 'status' }
  | { kind: 'reconnect' }
  | { kind: 'contentReady' }
  | { kind: 'openSidePanel' };

export type RpcReply<T extends RequestType = RequestType> =
  | { ok: true; result: RequestMap[T]['result'] }
  | { ok: false; error: { code: string; message: string; data?: unknown } };

/** background → content script / side panel */
export type Broadcast =
  | { kind: 'event'; event: EventType; data: EventMap[EventType] }
  | { kind: 'status'; status: ConnectionStatus };

/** → content script */
export type ContentMessage =
  | { kind: 'pageInfo' }
  | { kind: 'scrollTo'; id: string; flash?: boolean }
  | { kind: 'annotateSelection' }
  | { kind: 'hoverAnnotation'; id: string | null }
  | Broadcast;

/** content script → side panel */
export type PanelMessage =
  | { kind: 'focusAnnotation'; id: string; path: string }
  | { kind: 'pageChanged'; info: PageInfo }
  | { kind: 'noteUpdated'; note: NoteView | null };

export async function rpc<T extends RequestType>(
  type: T,
  params: RequestMap[T]['params'],
): Promise<RequestMap[T]['result']> {
  const reply = (await chrome.runtime.sendMessage({ kind: 'rpc', type, params } satisfies BgMessage)) as
    | RpcReply<T>
    | undefined;
  if (!reply) throw Object.assign(new Error('拡張のバックグラウンドが応答しません'), { code: 'no_background' });
  if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
  return reply.result;
}
