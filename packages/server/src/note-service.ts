/**
 * vault 内の註ノートを扱うサービス。Obsidian プラグインと開発用サーバーで共用する。
 * ファイル操作は VaultAdapter に任せる。
 */
import {
  ProtocolError,
  addToFrontmatter,
  appendAnnotation,
  createNoteContent,
  ensureBlockId,
  fileNameFromTitle,
  localIsoString,
  newAnnotationId,
  newBlockId,
  normalizeUri,
  parseNote,
  type AnnotationData,
  type NoteView,
  type RequestMap,
} from '@a08/core';

export interface VaultAdapter {
  /** folder 以下の .md ファイルのパス（vault 相対, `/` 区切り） */
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** 新規作成または上書き */
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** 移動・改名（Obsidian ではリンクも更新する） */
  rename(from: string, to: string): Promise<void>;
  /** バイナリ（画像など）。なければ null */
  readBinary(path: string): Promise<Uint8Array | null>;
}

export function contentVersion(content: string): string {
  // FNV-1a 32bit ×2（異なる初期値）＋長さ
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}-${content.length.toString(36)}`;
}

export function toNoteView(path: string, content: string): NoteView {
  const parsed = parseNote(content);
  return {
    path,
    version: contentVersion(content),
    content,
    titles: parsed.titles,
    uris: parsed.uris,
    annotations: parsed.annotations.map(a => {
      const { startOffset: _s, endOffset: _e, blockEndLine: _b, headEndLine: _h, ...rest } = a;
      return rest;
    }),
  };
}

type IndexEntry = { uris: Set<string>; titles: string[] };

export type NoteServiceOptions = {
  /** 註ノートのフォルダ（vault 相対） */
  folder: string;
  now?: () => Date;
};

export class NoteService {
  readonly vault: VaultAdapter;
  folder: string;
  private index = new Map<string, IndexEntry>();
  private locks = new Map<string, Promise<unknown>>();
  private now: () => Date;

  constructor(vault: VaultAdapter, options: NoteServiceOptions) {
    this.vault = vault;
    this.folder = options.folder.replace(/^\/+|\/+$/g, '');
    this.now = options.now ?? (() => new Date());
  }

  /** 註ノートとして扱うパスか（_ で始まるファイルは除く） */
  isNotePath(path: string): boolean {
    if (!path.endsWith('.md')) return false;
    if (this.folder && !path.startsWith(`${this.folder}/`)) return false;
    const name = path.split('/').pop()!;
    return !name.startsWith('_');
  }

  async rebuildIndex(): Promise<void> {
    this.index.clear();
    const paths = await this.vault.list(this.folder);
    await Promise.all(
      paths.filter(p => this.isNotePath(p)).map(async p => {
        const c = await this.vault.read(p);
        if (c != null) this.indexContent(p, c);
      }),
    );
  }

  private indexContent(path: string, content: string) {
    const n = parseNote(content);
    this.index.set(path, { uris: new Set(n.uris.map(normalizeUri)), titles: n.titles });
  }

  /** ファイルの変更を通知する。註ノートなら索引を更新して NoteView を返す */
  async fileChanged(path: string): Promise<NoteView | null | undefined> {
    if (!this.isNotePath(path)) return undefined;
    const c = await this.vault.read(path);
    if (c == null) {
      this.index.delete(path);
      return null;
    }
    this.indexContent(path, c);
    return toNoteView(path, c);
  }

  fileDeleted(path: string) {
    this.index.delete(path);
  }

  fileRenamed(oldPath: string, newPath: string) {
    const e = this.index.get(oldPath);
    this.index.delete(oldPath);
    if (e && this.isNotePath(newPath)) this.index.set(newPath, e);
  }

  /** URI 候補に一致するノートのパス（複数あれば最初に見つかったもの） */
  findPath(uris: string[]): string | null {
    const wanted = uris.map(normalizeUri).filter(Boolean);
    for (const u of wanted) {
      for (const [path, e] of this.index) {
        if (e.uris.has(u)) return path;
      }
    }
    return null;
  }

  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(path) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(path, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(path) === tail) this.locks.delete(path);
    }
  }

  private async readNote(path: string): Promise<string> {
    const c = await this.vault.read(path);
    if (c == null) throw new ProtocolError('not_found', `ノートがありません: ${path}`);
    return c;
  }

  private async writeNote(path: string, content: string): Promise<NoteView> {
    await this.vault.write(path, content);
    this.indexContent(path, content);
    return toNoteView(path, content);
  }

  async lookup(uris: string[]): Promise<NoteView | null> {
    const path = this.findPath(uris);
    if (!path) return null;
    const c = await this.vault.read(path);
    return c == null ? null : toNoteView(path, c);
  }

  async getNote(path: string): Promise<NoteView | null> {
    const c = await this.vault.read(path);
    return c == null ? null : toNoteView(path, c);
  }

  private async uniquePath(title: string): Promise<string> {
    const base = fileNameFromTitle(title);
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base} (${i})`;
      const p = this.folder ? `${this.folder}/${name}.md` : `${name}.md`;
      if (!(await this.vault.exists(p))) return p;
    }
  }

  async createAnnotation(
    params: RequestMap['createAnnotation']['params'],
  ): Promise<{ note: NoteView; id: string; blockId?: string }> {
    const uris = dedupeUris(params.uris.filter(Boolean));
    const title = params.title.trim() || uris[0] || 'untitled';
    let path = params.path && (await this.vault.exists(params.path)) ? params.path : this.findPath(uris);
    let created = false;
    if (!path) {
      // 同時に2つ作られないよう、タイトルでロックする
      path = await this.withLock(`new:${title}`, async () => {
        const again = this.findPath(uris);
        if (again) return again;
        const p = await this.uniquePath(title);
        await this.writeNote(p, createNoteContent({ titles: [title], uris }, this.now()));
        created = true;
        return p;
      });
    }
    const target = path;
    return this.withLock(target, async () => {
      let content = await this.readNote(target);
      if (!created) {
        // 未登録の URI（別経路で開いた場合など）とタイトルを追加
        const before = parseNote(content);
        const known = new Set(before.uris.map(normalizeUri));
        const newUris = uris.filter(u => !known.has(normalizeUri(u)));
        content = addToFrontmatter(
          content,
          {
            uris: newUris,
            titles: newUris.length && title && !before.titles.includes(title) ? [title] : [],
          },
          (a, b) => normalizeUri(a) === normalizeUri(b),
        );
      }
      const id = newAnnotationId();
      const data: AnnotationData = {
        id,
        created: localIsoString(this.now()),
        source: params.source || uris[0] || '',
        selector: params.selector,
      };
      let blockId: string | undefined;
      if (params.blockId) {
        const used = new Set(parseNote(content).annotations.map(x => x.blockId));
        do blockId = newBlockId();
        while (used.has(blockId) || content.includes(`^${blockId}`));
      }
      content = appendAnnotation(content, data, params.comment ?? '', blockId).text;
      const note = await this.writeNote(target, content);
      return { note, id, blockId };
    });
  }

  /** 照: 註にブロック ID を付ける（既にあればそのまま） */
  async ensureBlockId(path: string, id: string): Promise<{ note: NoteView; blockId: string; changed: boolean }> {
    return this.withLock(path, async () => {
      const content = await this.readNote(path);
      const r = ensureBlockId(content, id);
      if (!r) throw new ProtocolError('not_found', `註がありません: ${id}`);
      const note = r.changed ? await this.writeNote(path, r.text) : toNoteView(path, content);
      return { note, blockId: r.blockId, changed: r.changed };
    });
  }

  /** ノートの改名。name は拡張子なしのファイル名（同じフォルダ内） */
  async renameNote(path: string, name: string): Promise<{ note: NoteView; changed: boolean }> {
    const clean = fileNameFromTitle(name);
    if (!name.trim() || clean !== name.trim()) {
      throw new ProtocolError('bad_request', 'ファイル名に使えない文字が含まれています（\\ / : * ? " < > | # ^ [ ]）');
    }
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const to = `${dir}${clean}.md`;
    return this.withLock(path, async () => {
      await this.readNote(path);
      if (to === path) return { note: (await this.getNote(path))!, changed: false };
      if (await this.vault.exists(to)) throw new ProtocolError('conflict', `同じ名前のファイルがあります: ${clean}`);
      await this.vault.rename(path, to);
      this.fileRenamed(path, to);
      const c = await this.readNote(to);
      this.indexContent(to, c);
      return { note: toNoteView(to, c), changed: true };
    });
  }

  /** vault 内の画像を読む */
  async readResource(path: string): Promise<{ mime: string; base64: string }> {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const mime = IMAGE_TYPES[ext];
    if (!mime || path.split('/').some(seg => seg === '..' || seg === '')) {
      throw new ProtocolError('bad_request', `扱えないファイルです: ${path}`);
    }
    const data = await this.vault.readBinary(path);
    if (!data) throw new ProtocolError('not_found', path);
    if (data.byteLength > 24 * 1024 * 1024) throw new ProtocolError('too_large', `大きすぎます: ${path}`);
    return { mime, base64: toBase64(data) };
  }

  async updateComment(path: string, id: string, comment: string): Promise<{ note: NoteView }> {
    return this.withLock(path, async () => {
      const content = await this.readNote(path);
      const parsed = parseNote(content);
      const a = parsed.annotations.find(x => x.id === id);
      if (!a) throw new ProtocolError('not_found', `註がありません: ${id}`);
      const lines = content.split('\n');
      const before = lines.slice(0, a.headEndLine + 1);
      const after = lines.slice(a.endLine + 1);
      const body = comment.replace(/\s+$/, '');
      // ブロック ID 行の直後は空行を挟む（でないと ID として認識されない）
      const mid = body ? (a.blockId ? ['', body.replace(/^\s*\n/, '')] : [body]) : [];
      // 後続と詰まらないよう空行を1つ入れる
      if (after.length && after[0].trim() !== '') mid.push('');
      const out = [...before, ...mid, ...after].join('\n');
      return { note: await this.writeNote(path, out) };
    });
  }

  async deleteAnnotation(path: string, id: string): Promise<{ note: NoteView }> {
    return this.withLock(path, async () => {
      const content = await this.readNote(path);
      const parsed = parseNote(content);
      const a = parsed.annotations.find(x => x.id === id);
      if (!a) throw new ProtocolError('not_found', `註がありません: ${id}`);
      const lines = content.split('\n');
      let end = a.endLine + 1;
      while (end < lines.length && lines[end].trim() === '') end++;
      let start = a.startLine;
      // 直前の空行も1つ詰める（先頭以外）
      if (end >= lines.length) {
        while (start > 0 && lines[start - 1].trim() === '') start--;
      }
      const out = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
      return { note: await this.writeNote(path, out.endsWith('\n') ? out : `${out}\n`) };
    });
  }

  async saveNote(path: string, content: string, baseVersion: string): Promise<{ note: NoteView }> {
    return this.withLock(path, async () => {
      const current = await this.vault.read(path);
      if (current != null && contentVersion(current) !== baseVersion) {
        throw new ProtocolError('conflict', 'ノートが他で変更されています', toNoteView(path, current));
      }
      return { note: await this.writeNote(path, content) };
    });
  }
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

function toBase64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

export function dedupeUris(uris: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of uris) {
    const n = normalizeUri(u);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    // フラグメントや追跡パラメータは保存しない
    out.push(/^https?:/i.test(n) && !n.includes('web.archive.org/web/*/') ? n : u.trim());
  }
  return out;
}
