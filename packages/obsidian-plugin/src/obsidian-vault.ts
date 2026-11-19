import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import type { VaultAdapter } from '@a08/server';

export class ObsidianVault implements VaultAdapter {
  private app: App;
  constructor(app: App) {
    this.app = app;
  }

  async list(folder: string): Promise<string[]> {
    const prefix = folder ? `${normalizePath(folder)}/` : '';
    return this.app.vault
      .getMarkdownFiles()
      .map(f => f.path)
      .filter(p => p.startsWith(prefix));
  }

  async read(path: string): Promise<string | null> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? this.app.vault.read(f) : null;
  }

  async write(path: string, content: string): Promise<void> {
    const p = normalizePath(path);
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) {
      await this.app.vault.modify(f, content);
      return;
    }
    const dir = p.split('/').slice(0, -1).join('/');
    if (dir && !(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
      await this.app.vault.createFolder(dir).catch(() => undefined);
    }
    await this.app.vault.create(p, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) != null;
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(from));
    if (!(f instanceof TFile)) throw new Error(`ファイルがありません: ${from}`);
    // fileManager 経由だと、このノートへのリンクも設定どおり更新される
    await this.app.fileManager.renameFile(f, normalizePath(to));
  }

  async trash(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) throw new Error(`ファイルがありません: ${path}`);
    // 「削除したファイル」の設定（システムのゴミ箱 / .trash / 完全に削除）に従う
    await this.app.fileManager.trashFile(f);
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? new Uint8Array(await this.app.vault.readBinary(f)) : null;
  }
}
