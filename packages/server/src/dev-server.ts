/**
 * Obsidian なしで拡張を試すための開発用サーバー。
 *
 *   npm run dev-server -- --vault test-vault --port 27183 --token devtoken
 *
 * Obsidian プラグインと同じプロトコルを話す。HTML 化は marked による簡易版。
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Marked } from 'marked';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_PORT, displayQuote, quoteOf, type AnnotationData, type ThemeInfo } from '@a08/core';
import { NoteService } from './note-service.ts';
import { AnnotationServer } from './ws-server.ts';
import { FsVault } from './fs-vault.ts';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createDevRenderer() {
  const marked = new Marked();
  marked.use({
    renderer: {
      code({ text, lang }) {
        if (lang !== 'annotation') return false;
        let a: AnnotationData;
        try {
          a = parseYaml(text);
        } catch {
          return `<pre>${escapeHtml(text)}</pre>`;
        }
        return (
          `<div class="a08-card" data-annotation-id="${escapeHtml(String(a.id))}">` +
          `<blockquote class="a08-quote">${escapeHtml(displayQuote(quoteOf(a)))}</blockquote>` +
          `<div class="a08-meta">${escapeHtml(String(a.created ?? ''))}</div></div>`
        );
      },
    },
  });
  return (md: string) => marked.parse(md.replace(/^---\n[\s\S]*?\n---\n/, '')) as string;
}

export const DEV_THEME: ThemeInfo = { dark: false, vars: {} };

export async function startDevServer(opts: { vault: string; port: number; token: string; folder?: string; quiet?: boolean }) {
  const vault = new FsVault(resolve(opts.vault));
  const service = new NoteService(vault, { folder: opts.folder ?? 'annotations' });
  await service.ensureStylesFile();
  await service.rebuildIndex();
  const render = createDevRenderer();
  const log = opts.quiet ? undefined : (m: string, ...a: unknown[]) => console.log(`[a08] ${m}`, ...a);
  const server = new AnnotationServer({
    port: opts.port,
    token: opts.token,
    service,
    hooks: {
      vaultName: () => 'dev-vault',
      theme: () => DEV_THEME,
      render: async (_p, content) => render(content),
      openInObsidian: async (p, id) => log?.('openInObsidian', p, id),
      openLink: async (l, s) => log?.('openLink', l, s),
      log,
    },
  });
  await server.start();
  const watcher = vault.watch(async p => {
    const r = await service.fileChanged(p);
    if (r === 'styles') server.broadcast('stylesChanged', { styles: await service.getStyles() });
    else if (r !== undefined) server.noteChanged(p, r);
  });
  return {
    server,
    service,
    async stop() {
      watcher.close();
      await server.stop();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      vault: { type: 'string', default: 'test-vault' },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      token: { type: 'string', default: 'devtoken' },
      folder: { type: 'string', default: 'annotations' },
    },
  });
  const s = await startDevServer({
    vault: values.vault!,
    port: Number(values.port),
    token: values.token!,
    folder: values.folder,
  });
  console.log(`a08 dev server: ws://127.0.0.1:${values.port}/?token=${values.token}  vault=${resolve(values.vault!)}`);
  process.on('SIGINT', async () => {
    await s.stop();
    process.exit(0);
  });
}
