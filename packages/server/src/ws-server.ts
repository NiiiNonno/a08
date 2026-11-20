/**
 * 拡張からの WebSocket 接続を受けるサーバー。127.0.0.1 のみで待ち受ける。
 *
 * 認証:
 * - クエリの token が一致すること
 * - Origin ヘッダがあれば chrome-extension:// であること
 *   （Web ページが localhost の WebSocket に接続するのを防ぐ）
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { WebSocketServer, WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  type EventMap,
  type EventType,
  type NoteView,
  type Request,
  type RequestMap,
  type RequestType,
  type Response,
  DEFAULT_HOST_OPTIONS,
  type HostOptions,
  type StyleConfig,
  type ThemeInfo,
  type Appearance,
} from '@a08/core';
import type { NoteService } from './note-service.ts';

export type HostHooks = {
  vaultName(): string;
  theme(): ThemeInfo;
  /** タグ別のハイライト設定 */
  styles(): StyleConfig;
  /** ブラウザにも効く設定（照でリンクをコピーするか など） */
  options?(): HostOptions;
  /** ブロックへの内部リンク（[[ノート#^id]] など） */
  linkTo(path: string, blockId: string): string;
  /** サイドパネル用の CSS 一式（なければ null） */
  appearance?(): Appearance | null;
  /** markdown → HTML（Obsidian のレンダラー） */
  render(path: string, content: string): Promise<string>;
  openInObsidian(path: string, id?: string): Promise<void>;
  openLink(link: string, sourcePath: string): Promise<void>;
  log?(msg: string, ...args: unknown[]): void;
};

export type ServerOptions = {
  port: number;
  token: string;
  service: NoteService;
  hooks: HostHooks;
  /** 許可する Origin（既定: chrome-extension:// で始まるもの） */
  allowOrigin?: (origin: string) => boolean;
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class AnnotationServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private opts: ServerOptions;

  constructor(opts: ServerOptions) {
    this.opts = opts;
  }

  get clientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  async start(): Promise<void> {
    const { port } = this.opts;
    const http = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Obsidiannot server\n');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

    http.on('upgrade', (req, socket, head) => {
      if (!this.authorize(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });

    wss.on('connection', ws => {
      this.opts.hooks.log?.('client connected');
      ws.on('message', data => {
        void this.handleMessage(ws, String(data));
      });
    });

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
    this.http = http;
    this.wss = wss;
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.wss?.close();
    await new Promise<void>(resolve => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = null;
    this.wss = null;
  }

  private authorize(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('token') ?? '';
    if (!this.opts.token || !safeEqual(token, this.opts.token)) return false;
    const origin = req.headers.origin;
    if (origin) {
      const allow = this.opts.allowOrigin ?? (o => o.startsWith('chrome-extension://'));
      if (!allow(origin)) return false;
    }
    return true;
  }

  broadcast<T extends EventType>(event: T, data: EventMap[T]): void {
    const msg = JSON.stringify({ event, data });
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
  }

  noteChanged(path: string, note: NoteView | null) {
    this.broadcast('noteChanged', { path, note });
  }

  /** 要求への応答を先に返してから変更を通知する */
  private noteChangedAfterReply(path: string, note: NoteView | null) {
    setTimeout(() => this.noteChanged(path, note), 0);
  }

  private async handleMessage(ws: WebSocket, raw: string) {
    let req: Request;
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof req?.id !== 'number' || typeof req.type !== 'string') return;
    let res: Response;
    try {
      const result = await this.dispatch(req.type, (req.params ?? {}) as never);
      res = { id: req.id, ok: true, result };
    } catch (e) {
      const err =
        e instanceof ProtocolError
          ? { code: e.code, message: e.message, data: e.data }
          : { code: 'internal', message: e instanceof Error ? e.message : String(e) };
      this.opts.hooks.log?.('request failed', req.type, err);
      res = { id: req.id, ok: false, error: err };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
  }

  private async dispatch<T extends RequestType>(
    type: T,
    p: RequestMap[T]['params'],
  ): Promise<RequestMap[T]['result']> {
    const { service, hooks } = this.opts;
    const params = p as never as Record<string, unknown>;
    const str = (k: string) => {
      const v = params[k];
      if (typeof v !== 'string') throw new ProtocolError('bad_request', `${k} がありません`);
      return v;
    };
    let result: unknown;
    switch (type) {
      case 'ping':
        result = 'pong';
        break;
      case 'hello':
        result = {
          vault: hooks.vaultName(),
          folder: service.folder,
          styles: hooks.styles(),
          theme: hooks.theme(),
          options: hooks.options?.() ?? DEFAULT_HOST_OPTIONS,
          version: PROTOCOL_VERSION,
        };
        break;
      case 'lookup':
        result = await service.lookup(Array.isArray(params.uris) ? (params.uris as string[]) : []);
        break;
      case 'getNote':
        result = await service.getNote(str('path'));
        break;
      case 'createAnnotation': {
        const cp = p as RequestMap['createAnnotation']['params'];
        if (!Array.isArray(cp.uris) || !Array.isArray(cp.selector)) {
          throw new ProtocolError('bad_request', 'uris と selector が必要です');
        }
        const r = await service.createAnnotation(cp);
        this.noteChangedAfterReply(r.note.path, r.note);
        // ブロック ID は全部の註に付くが、リンクを返すのは照（blockId を求められたとき）だけ
        result = { note: r.note, id: r.id, ...(cp.blockId && r.blockId ? { link: hooks.linkTo(r.note.path, r.blockId) } : {}) };
        break;
      }
      case 'linkToAnnotation': {
        const r = await service.ensureBlockId(str('path'), str('id'));
        if (r.changed) this.noteChangedAfterReply(r.note.path, r.note);
        result = { note: r.note, link: hooks.linkTo(r.note.path, r.blockId) };
        break;
      }
      case 'createNote': {
        const cp = p as RequestMap['createNote']['params'];
        if (!Array.isArray(cp.uris)) throw new ProtocolError('bad_request', 'uris が必要です');
        const r = await service.createNote(cp.uris, typeof cp.title === 'string' ? cp.title : '');
        if (r.created) this.noteChangedAfterReply(r.note.path, r.note);
        result = r;
        break;
      }
      case 'deleteNote': {
        const path = str('path');
        await service.deleteNote(path);
        this.noteChangedAfterReply(path, null);
        result = null;
        break;
      }
      case 'renameNote': {
        const from = str('path');
        const r = await service.renameNote(from, str('name'));
        if (r.changed) {
          this.noteChangedAfterReply(from, null);
          this.noteChangedAfterReply(r.note.path, r.note);
        }
        result = { note: r.note };
        break;
      }
      case 'appearance':
        result = hooks.appearance?.() ?? null;
        break;
      case 'getResource':
        result = await service.readResource(str('path'));
        break;
      case 'updateComment': {
        const r = await service.updateComment(str('path'), str('id'), str('comment'));
        this.noteChangedAfterReply(r.note.path, r.note);
        result = r;
        break;
      }
      case 'deleteAnnotation': {
        const r = await service.deleteAnnotation(str('path'), str('id'));
        this.noteChangedAfterReply(r.note.path, r.note);
        result = r;
        break;
      }
      case 'saveNote': {
        const r = await service.saveNote(str('path'), str('content'), str('baseVersion'));
        this.noteChangedAfterReply(r.note.path, r.note);
        result = r;
        break;
      }
      case 'render': {
        const path = str('path');
        const content = await service.vault.read(path);
        if (content == null) throw new ProtocolError('not_found', path);
        result = { html: await hooks.render(path, content) };
        break;
      }
      case 'openInObsidian':
        await hooks.openInObsidian(str('path'), typeof params.id === 'string' ? params.id : undefined);
        result = null;
        break;
      case 'openLink':
        await hooks.openLink(str('link'), str('sourcePath'));
        result = null;
        break;
      default:
        throw new ProtocolError('unknown_request', `不明な要求: ${String(type)}`);
    }
    return result as RequestMap[T]['result'];
  }
}
