import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { parseNote, type Selector } from '@a08/core';
import { NoteService } from '../src/note-service.ts';
import { FsVault } from '../src/fs-vault.ts';
import { startDevServer } from '../src/dev-server.ts';

const sel: Selector[] = [
  { type: 'TextQuoteSelector', exact: 'quick brown', prefix: 'The ', suffix: ' fox' },
  { type: 'TextPositionSelector', start: 4, end: 15 },
];

let dir: string;
let service: NoteService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'a08-'));
  service = new NoteService(new FsVault(dir), {
    folder: 'annotations',
    now: () => new Date('2026-11-18T12:00:00Z'),
  });
});

describe('NoteService', () => {
  it('creates a note on first annotation and appends later ones', async () => {
    const r1 = await service.createAnnotation({
      uris: ['https://example.com/a?utm_source=x#frag', 'https://example.com/canonical'],
      title: 'Example: A/B',
      source: 'https://example.com/a',
      selector: sel,
      comment: 'first #重要',
    });
    expect(r1.note.path).toBe('annotations/Example A B.md');
    expect(r1.note.uris).toEqual(['https://example.com/a', 'https://example.com/canonical']);
    expect(r1.note.annotations[0].tags).toEqual(['重要']);

    // canonical 経由・別 URL で開いても同じノートになり、URI が追加される
    const r2 = await service.createAnnotation({
      uris: ['https://mirror.example.org/a', 'https://example.com/canonical'],
      title: 'Mirror title',
      source: 'https://mirror.example.org/a',
      selector: sel,
    });
    expect(r2.note.path).toBe(r1.note.path);
    expect(r2.note.uris).toEqual([
      'https://example.com/a',
      'https://example.com/canonical',
      'https://mirror.example.org/a',
    ]);
    expect(r2.note.titles).toEqual(['Example: A/B', 'Mirror title']);
    expect(r2.note.annotations.map(a => a.id)).toEqual([r1.id, r2.id]);

    const looked = await service.lookup(['https://example.com/a#other']);
    expect(looked?.path).toBe(r1.note.path);
    expect(await service.lookup(['https://nothing.example/'])).toBeNull();
  });

  it('creates unique files for different pages with the same title', async () => {
    const a = await service.createAnnotation({ uris: ['https://a.example/'], title: 'Same', source: '', selector: sel });
    const b = await service.createAnnotation({ uris: ['https://b.example/'], title: 'Same', source: '', selector: sel });
    expect(a.note.path).toBe('annotations/Same.md');
    expect(b.note.path).toBe('annotations/Same (2).md');
  });

  it('serializes concurrent creations for the same page', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(i =>
        service.createAnnotation({ uris: ['https://c.example/'], title: 'C', source: '', selector: sel, comment: `c${i}` }),
      ),
    );
    const path = results[0].note.path;
    expect(results.every(r => r.note.path === path)).toBe(true);
    const note = parseNote((await readFile(join(dir, path), 'utf8')));
    expect(note.annotations.map(a => a.comment).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('updates and deletes comments', async () => {
    const { note, id } = await service.createAnnotation({ uris: ['https://d.example/'], title: 'D', source: '', selector: sel, comment: 'old' });
    const second = await service.createAnnotation({ uris: ['https://d.example/'], title: 'D', source: '', selector: sel, comment: 'keep' });
    const up = await service.updateComment(note.path, id, 'new line 1\n\nnew #定義');
    const a = up.note.annotations.find(x => x.id === id)!;
    expect(a.comment).toBe('new line 1\n\nnew #定義');
    expect(a.tags).toEqual(['定義']);
    expect(up.note.annotations.find(x => x.id === second.id)!.comment).toBe('keep');

    const emptied = await service.updateComment(note.path, id, '');
    expect(emptied.note.annotations.find(x => x.id === id)!.comment).toBe('');
    expect(emptied.note.annotations.find(x => x.id === second.id)!.comment).toBe('keep');

    const del = await service.deleteAnnotation(note.path, id);
    expect(del.note.annotations.map(x => x.id)).toEqual([second.id]);
    expect(del.note.annotations[0].comment).toBe('keep');
  });

  it('detects conflicting saves', async () => {
    const { note } = await service.createAnnotation({ uris: ['https://e.example/'], title: 'E', source: '', selector: sel });
    await writeFile(join(dir, note.path), note.content + '\nedited elsewhere\n');
    await expect(service.saveNote(note.path, 'x', note.version)).rejects.toMatchObject({ code: 'conflict' });
    const fresh = await service.getNote(note.path);
    const saved = await service.saveNote(note.path, fresh!.content + 'more\n', fresh!.version);
    expect(saved.note.content.endsWith('more\n')).toBe(true);
  });

  it('indexes existing notes and ignores _ files', async () => {
    await mkdir(join(dir, 'annotations/sub'), { recursive: true });
    await writeFile(join(dir, 'annotations/sub/x.md'), '---\nuris: https://x.example/p\n---\n');
    await writeFile(join(dir, 'annotations/_styles.md'), '---\nuris: https://x.example/p\n---\n');
    await service.rebuildIndex();
    expect(service.findPath(['https://x.example/p'])).toBe('annotations/sub/x.md');
  });
});

describe('AnnotationServer', () => {
  let srv: Awaited<ReturnType<typeof startDevServer>>;
  let vaultDir: string;
  const port = 27999;

  beforeAll(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'a08-srv-'));
    srv = await startDevServer({ vault: vaultDir, port, token: 'secret', quiet: true });
  });
  afterAll(async () => {
    await srv.stop();
    await rm(vaultDir, { recursive: true, force: true });
  });

  const connect = (token = 'secret', origin?: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, origin ? { origin } : {});
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

  const call = (ws: WebSocket, type: string, params: unknown) =>
    new Promise<any>(resolve => {
      const id = Math.floor(Math.random() * 1e9);
      const onMsg = (d: WebSocket.RawData) => {
        const m = JSON.parse(String(d));
        if (m.id === id) {
          ws.off('message', onMsg);
          resolve(m);
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, type, params }));
    });

  it('rejects bad tokens and web origins', async () => {
    await expect(connect('wrong')).rejects.toThrow();
    await expect(connect('secret', 'https://evil.example')).rejects.toThrow();
    const ok = await connect('secret', 'chrome-extension://abcdef');
    ok.close();
  });

  it('serves requests and broadcasts changes', async () => {
    const ws = await connect();
    const other = await connect();
    const events: any[] = [];
    other.on('message', d => {
      const m = JSON.parse(String(d));
      if (m.event) events.push(m);
    });

    const hello = await call(ws, 'hello', { client: 'test', version: 1 });
    expect(hello.ok).toBe(true);
    expect(hello.result.styles.tags.map((t: any) => t.tag)).toEqual(['重要', '定義', '疑問', '引用']);

    const created = await call(ws, 'createAnnotation', {
      uris: ['https://srv.example/'], title: 'Srv', source: 'https://srv.example/', selector: sel, comment: 'hi #重要',
    });
    expect(created.ok).toBe(true);
    const html = await call(ws, 'render', { path: created.result.note.path });
    expect(html.result.html).toContain('a08-card');
    expect(html.result.html).toContain('quick brown');

    const bad = await call(ws, 'saveNote', { path: created.result.note.path, content: 'x', baseVersion: 'old' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'conflict' } });

    await new Promise(r => setTimeout(r, 50));
    expect(events.some(e => e.event === 'noteChanged' && e.data.path === created.result.note.path)).toBe(true);

    // 外部（Obsidian など）での編集も通知される
    await writeFile(join(vaultDir, created.result.note.path), created.result.note.content + '\nexternal edit\n');
    await new Promise(r => setTimeout(r, 600));
    expect(events.filter(e => e.event === 'noteChanged').at(-1).data.note.content).toContain('external edit');

    // スタイル変更
    const stylesPath = join(vaultDir, 'annotations/_styles.md');
    const styles = await readFile(stylesPath, 'utf8');
    await writeFile(stylesPath, styles.replace('  重要:', '  最重要:\n    light: { color: red }\n  重要:'));
    await new Promise(r => setTimeout(r, 600));
    const st = events.filter(e => e.event === 'stylesChanged').at(-1);
    expect(st.data.styles.tags[0]).toEqual({ tag: '最重要', style: { light: { color: 'red' }, dark: undefined } });
    ws.close();
    other.close();
  });
});
