/**
 * ディレクトリを vault とみなす VaultAdapter（開発用サーバーとテスト用）。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { VaultAdapter } from './note-service.ts';

export class FsVault implements VaultAdapter {
  readonly root: string;
  /** 自分で書き込んだ直後の変更通知を抑えるため */
  private recentWrites = new Map<string, string>();

  constructor(root: string) {
    this.root = root;
  }

  private abs(p: string) {
    const a = join(this.root, p);
    if (!a.startsWith(this.root)) throw new Error('path escapes vault');
    return a;
  }

  async list(folder: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith('.md')) out.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    await walk(this.abs(folder));
    return out;
  }

  async read(p: string): Promise<string | null> {
    try {
      return await readFile(this.abs(p), 'utf8');
    } catch {
      return null;
    }
  }

  async write(p: string, content: string): Promise<void> {
    await mkdir(dirname(this.abs(p)), { recursive: true });
    this.recentWrites.set(p, content);
    await writeFile(this.abs(p), content, 'utf8');
  }

  async exists(p: string): Promise<boolean> {
    try {
      await stat(this.abs(p));
      return true;
    } catch {
      return false;
    }
  }

  /** 外部からの変更を監視する（自分の書き込みは通知しない） */
  watch(onChange: (path: string) => void): FSWatcher {
    const timers = new Map<string, NodeJS.Timeout>();
    return watch(this.root, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const p = String(name).split(sep).join('/');
      if (!p.endsWith('.md')) return;
      clearTimeout(timers.get(p));
      timers.set(
        p,
        setTimeout(async () => {
          const c = await this.read(p);
          if (c != null && this.recentWrites.get(p) === c) return;
          this.recentWrites.delete(p);
          onChange(p);
        }, 100),
      );
    });
  }
}
