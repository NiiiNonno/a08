/**
 * vault 内の註ノートを扱うサービス。Obsidian プラグインと開発用サーバーで共用する。
 * ファイル操作は VaultAdapter に任せる。
 */
import {
  DEFAULT_STYLES,
  DEFAULT_STYLES_YAML,
  ProtocolError,
  STYLES_LANG,
  addToFrontmatter,
  appendAnnotation,
  createNoteContent,
  fileNameFromTitle,
  localIsoString,
  newAnnotationId,
  normalizeUri,
  parseNote,
  styleConfigFromMarkdown,
  type AnnotationData,
  type NoteView,
  type RequestMap,
  type StyleConfig,
} from '@a08/core';

export interface VaultAdapter {
  /** folder 以下の .md ファイルのパス（vault 相対, `/` 区切り） */
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** 新規作成または上書き */
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
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
      const { startOffset: _s, endOffset: _e, blockEndLine: _b, ...rest } = a;
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
  private stylesCache: StyleConfig | null = null;

  constructor(vault: VaultAdapter, options: NoteServiceOptions) {
    this.vault = vault;
    this.folder = options.folder.replace(/^\/+|\/+$/g, '');
    this.now = options.now ?? (() => new Date());
  }

  get stylesPath(): string {
    return `${this.folder}/_styles.md`;
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

  /**
   * ファイルの変更を通知する。註ノートなら索引を更新して NoteView を返す。
   * スタイル設定ファイルなら 'styles' を返す。
   */
  async fileChanged(path: string): Promise<NoteView | null | 'styles' | undefined> {
    if (path === this.stylesPath) {
      this.stylesCache = null;
      return 'styles';
    }
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
    if (path === this.stylesPath) this.stylesCache = null;
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

  async getStyles(): Promise<StyleConfig> {
    if (this.stylesCache) return this.stylesCache;
    const md = await this.vault.read(this.stylesPath);
    this.stylesCache = md ? styleConfigFromMarkdown(md).config : DEFAULT_STYLES;
    return this.stylesCache;
  }

  /** スタイル設定ファイルがなければ作る */
  async ensureStylesFile(): Promise<void> {
    if (await this.vault.exists(this.stylesPath)) return;
    const md =
      '# 註のハイライト設定\n\n' +
      'コメントに書いた `#タグ` ごとに、ブラウザでのハイライトの見た目を変えられます。\n' +
      '下のブロックを編集すると、開いているページにすぐ反映されます。\n\n' +
      '```' + STYLES_LANG + '\n' + DEFAULT_STYLES_YAML + '```\n';
    await this.vault.write(this.stylesPath, md);
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
  ): Promise<{ note: NoteView; id: string }> {
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
      content = appendAnnotation(content, data, params.comment ?? '').text;
      const note = await this.writeNote(target, content);
      return { note, id };
    });
  }

  async updateComment(path: string, id: string, comment: string): Promise<{ note: NoteView }> {
    return this.withLock(path, async () => {
      const content = await this.readNote(path);
      const parsed = parseNote(content);
      const a = parsed.annotations.find(x => x.id === id);
      if (!a) throw new ProtocolError('not_found', `註がありません: ${id}`);
      const lines = content.split('\n');
      const before = lines.slice(0, a.blockEndLine + 1);
      const after = lines.slice(a.endLine + 1);
      const body = comment.replace(/\s+$/, '');
      const mid = body ? [body] : [];
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
