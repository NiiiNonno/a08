/**
 * Obsidian なしで拡張を試すための開発用サーバー。
 *
 *   npm run dev-server -- --vault test-vault --port 27183 --token devtoken [--styles styles.yaml]
 *
 * Obsidian プラグインと同じプロトコルを話す。HTML 化は marked による簡易版。
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Marked } from 'marked';
import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import { ANNOTATION_LANG, DEFAULT_PORT, DEFAULT_STYLES, displayQuote, parseStyleConfig, quoteOf, type AnnotationData, type Appearance, type StyleConfig, type ThemeInfo } from '@a08/core';
import { NoteService } from './note-service.ts';
import { AnnotationServer } from './ws-server.ts';
import { FsVault } from './fs-vault.ts';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createDevRenderer() {
  const marked = new Marked();
  marked.use({
    renderer: {
      // vault 内の画像は Obsidian プラグインと同じく data-obsidiannot-resource にする
      image({ href, text }) {
        if (/^(https?:|data:)/i.test(href)) return false;
        return `<img data-obsidiannot-resource="${escapeHtml(decodeURI(href))}" alt="${escapeHtml(text)}">`;
      },
      code({ text, lang }) {
        if (lang !== ANNOTATION_LANG) return false;
        let a: AnnotationData;
        try {
          a = parseYaml(text);
        } catch {
          return `<pre>${escapeHtml(text)}</pre>`;
        }
        return (
          `<div class="obsidiannot-card" data-annotation-id="${escapeHtml(String(a.id))}">` +
          `<blockquote class="obsidiannot-quote">${escapeHtml(displayQuote(quoteOf(a)))}</blockquote>` +
          `<div class="obsidiannot-meta">${escapeHtml(String(a.created ?? ''))}</div></div>`
        );
      },
    },
  });
  // ブロック ID 行（^xxxx）は Obsidian と同じく表示しない
  return (md: string) =>
    marked.parse(md.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\^[A-Za-z0-9-]+[ \t]*$/gm, '')) as string;
}

export const DEV_THEME: ThemeInfo = { dark: false, vars: {} };

export async function startDevServer(opts: {
  vault: string;
  port: number;
  token: string;
  folder?: string;
  /** スタイル設定（YAML）のファイル */
  styles?: string;
  /** サイドパネルに渡す CSS（テスト用。Obsidian では画面の CSS 一式） */
  appearance?: Appearance;
  /** テーマ（テスト用。Obsidian では画面の CSS 変数） */
  theme?: ThemeInfo;
  /** markdown → HTML を差し替える（テスト用。Obsidian の描画結果をまねる） */
  render?: (path: string, content: string) => Promise<string>;
  quiet?: boolean;
}) {
  const vault = new FsVault(resolve(opts.vault));
  const service = new NoteService(vault, { folder: opts.folder ?? 'obsidiannot' });
  await service.rebuildIndex();
  let styles: StyleConfig = DEFAULT_STYLES;
  const loadStyles = async () => {
    if (opts.styles) styles = parseStyleConfig(await readFile(resolve(opts.styles), 'utf8')).config;
  };
  await loadStyles();
  const render = createDevRenderer();
  const log = opts.quiet ? undefined : (m: string, ...a: unknown[]) => console.log(`[obsidiannot] ${m}`, ...a);
  const server = new AnnotationServer({
    port: opts.port,
    token: opts.token,
    service,
    hooks: {
      vaultName: () => 'dev-vault',
      theme: () => ({ ...(opts.theme ?? DEV_THEME), ...(opts.appearance ? { cssVersion: opts.appearance.version } : {}) }),
      appearance: () => opts.appearance ?? null,
      styles: () => styles,
      linkTo: (p, blockId) => `[[${p.split('/').pop()!.replace(/\.md$/, '')}#^${blockId}]]`,
      render: opts.render ?? (async (_p, content) => render(content)),
      openInObsidian: async (p, id) => log?.('openInObsidian', p, id),
      openLink: async (l, s) => log?.('openLink', l, s),
      log,
    },
  });
  await server.start();
  const watcher = vault.watch(async p => {
    const r = await service.fileChanged(p);
    if (r !== undefined) server.noteChanged(p, r);
  });
  return {
    server,
    service,
    /** スタイル設定を差し替えて配信する（テスト用） */
    setStyles(s: StyleConfig) {
      styles = s;
      server.broadcast('stylesChanged', { styles });
    },
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
      folder: { type: 'string', default: 'obsidiannot' },
      styles: { type: 'string' },
    },
  });
  const s = await startDevServer({
    vault: values.vault!,
    port: Number(values.port),
    token: values.token!,
    folder: values.folder,
    styles: values.styles,
  });
  console.log(`Obsidiannot dev server: ws://127.0.0.1:${values.port}/?token=${values.token}  vault=${resolve(values.vault!)}`);
  process.on('SIGINT', async () => {
    await s.stop();
    process.exit(0);
  });
}
