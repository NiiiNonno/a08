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
}
