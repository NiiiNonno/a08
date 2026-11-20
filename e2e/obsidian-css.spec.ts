/**
 * 実際の Obsidian の CSS（app.css）でサイドパネルを確かめる。
 * Obsidian の CSS はリポジトリに含めないので、環境変数で場所を渡したときだけ動く:
 *
 *   OBSIDIAN_ASAR=~/.config/obsidian/obsidian-1.15.1.asar npx playwright test obsidian-css
 *
 * asar から app.css を取り出し、Obsidian の画面をまねたページでプラグインと同じ方法で CSS を集め、
 * Obsidian の描画結果に近い HTML と一緒にサイドパネルへ渡す。
 */
import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { closeSync, openSync, readSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { parse as parseYaml } from 'yaml';
import { parseNote, displayQuote, quoteOf, type Appearance, type ThemeInfo } from '@a08/core';
import { startDevServer } from '../packages/server/src/dev-server.ts';

const ASAR = process.env.OBSIDIAN_ASAR;
test.skip(!ASAR, 'OBSIDIAN_ASAR が未指定');

const EXT = resolve('packages/extension/dist');
const FIXTURES = resolve('e2e/fixtures');
const WS_PORT = 27997;
const TOKEN = 'e2e-obsidian-css';

/** asar から 1 ファイルを読む */
function readAsar(file: string, want: string): string {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const hb = Buffer.alloc(jsonLen);
    readSync(fd, hb, 0, jsonLen, 16);
    const header = JSON.parse(hb.toString('utf8'));
    const node = want.split('/').reduce((n, k) => n.files[k], header);
    const buf = Buffer.alloc(node.size);
    readSync(fd, buf, 0, node.size, 8 + headerSize + Number(node.offset));
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Obsidian の描画結果をまねた HTML（コードブロックは註カード、コールアウトも出す） */
function obsidianLikeRender(content: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const note = parseNote(content);
  const parts: string[] = [];
  for (const a of note.annotations) {
    const data = parseYaml(content.split('\n').slice(a.startLine + 1, a.blockEndLine).join('\n'));
    parts.push(
      `<div class="el-pre"><div class="block-language-obsidiannot obsidiannot-card-host">` +
        `<div class="obsidiannot-card" data-annotation-id="${esc(a.id)}" style="--obsidiannot-accent: rgba(255, 190, 0, 0.55);">` +
        `<blockquote class="obsidiannot-quote"><span class="obsidiannot-exact">${esc(displayQuote(quoteOf(data)))}</span></blockquote>` +
        `<div class="obsidiannot-meta"><span class="obsidiannot-source">127.0.0.1</span><span class="obsidiannot-open-hint">Click to open in browser</span></div>` +
        `</div></div></div>`,
    );
    if (a.comment) parts.push(`<div class="el-p"><p dir="auto">${esc(a.comment)}</p></div>`);
  }
  parts.push(
    '<div class="el-div"><div data-callout-metadata="" data-callout-fold="" data-callout="note" class="callout">' +
      '<div class="callout-title" dir="auto"><div class="callout-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="svg-icon lucide-pencil"><path d="M12 20h9"></path></svg></div>' +
      '<div class="callout-title-inner">Note</div></div><div class="callout-content"><p dir="auto">コールアウトの本文</p></div></div></div>',
  );
  return parts.join('');
}

let http: Server;
let base: string;
let vault: string;
let dev: Awaited<ReturnType<typeof startDevServer>>;
let context: BrowserContext;
let extId: string;
let appearance: Appearance;
let theme: ThemeInfo;

test.beforeAll(async () => {
  // 1. Obsidian の画面をまねたページで、プラグインと同じ方法で CSS を集める
  const appCss = readAsar(ASAR!, 'app.css');
  const pluginCss = await readFile('packages/obsidian-plugin/styles.css', 'utf8');
  const bundle = await build({
    entryPoints: ['packages/obsidian-plugin/src/appearance.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'AP',
  });
  const browser = await chromium.launch({ channel: 'chromium' });
  const p = await browser.newPage();
  await p.setContent(
    `<html><head><style>${appCss}</style><style>${pluginCss}</style></head>` +
      `<body class="theme-dark mod-linux is-frameless show-inline-title" style="--accent-h: 280; --accent-s: 80%; --accent-l: 60%;"></body></html>`,
  );
  await p.addScriptTag({ content: bundle.outputFiles[0].text });
  const ap = (await p.evaluate('AP.collectAppearance(document)')) as Omit<Appearance, 'version'>;
  appearance = { ...ap, version: 'real-obsidian' };
  // プラグインの theme() と同じく、計算後の CSS 変数（パネルの枠の色）
  const vars = await p.evaluate(names => {
    const cs = getComputedStyle(document.body);
    return Object.fromEntries(names.map(n => [n, cs.getPropertyValue(n).trim()]).filter(([, v]) => v));
  }, ['--background-primary', '--background-secondary', '--background-modifier-border', '--background-modifier-hover', '--text-normal', '--text-muted', '--text-faint', '--interactive-accent', '--text-on-accent', '--link-color', '--tag-color', '--font-text', '--font-monospace']);
  theme = { dark: true, vars };
  await browser.close();

  http = createServer(async (req, res) => {
    try {
      const name = (req.url ?? '/').split('?')[0].replace(/^\/+/, '') || 'article.html';
      const body = await readFile(join(FIXTURES, name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

  vault = await mkdtemp(join(tmpdir(), 'obsidiannot-css-'));
  await mkdir(join(vault, 'obsidiannot'));
  dev = await startDevServer({
    vault,
    port: WS_PORT,
    token: TOKEN,
    quiet: true,
    appearance,
    theme,
    render: async (_p, content) => obsidianLikeRender(content),
  });
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 420, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extId = new URL(sw.url()).host;
  await sw.evaluate(
    async ({ port, token }) => chrome.storage.local.set({ settings: { port, token, ignoreSelectors: [], } }),
    { port: WS_PORT, token: TOKEN },
  );
  await expect.poll(() => dev.server.clientCount, { timeout: 10_000 }).toBeGreaterThan(0);
  for (const pg of context.pages()) if (pg.url().startsWith('chrome-extension://')) await pg.close();
});

test.afterAll(async () => {
  await context?.close();
  await dev?.stop();
  http?.close();
  if (vault) await rm(vault, { recursive: true, force: true });
});

async function openPanel(page: Page): Promise<Page> {
  const tabId = await context.serviceWorkers()[0].evaluate(async u => (await chrome.tabs.query({})).find(t => t.url === u)!.id!, page.url());
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 420, height: 800 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  return panel;
}

test('実際の Obsidian の CSS でも、本文・カード・コールアウトが見え、編集モードでは閲覧表示が隠れる', async () => {
  const block = (id: string, exact: string) =>
    ['```obsidiannot', `id: ${id}`, `source: ${base}/article.html`, 'selector:', '  - type: TextQuoteSelector', `    exact: ${exact}`, '```'].join('\n');
  await writeFile(
    join(vault, 'obsidiannot', 'A Test Article.md'),
    ['---', 'titles:', '  - A Test Article on Annotation', 'uris:', `  - ${base}/article.html`, '---', '',
      block('aaa', 'specific passages'), 'ひとつめのコメント #重要', '',
      block('bbb', 'approximate matching'), 'ふたつめのコメント', ''].join('\n'),
  );
  await dev.service.rebuildIndex();
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  const panel = await openPanel(page);
  const logs: string[] = [];
  panel.on('console', m => logs.push(m.text()));
  const card = panel.locator('.obsidiannot-card').first();
  await expect(card).toBeVisible();
  // Obsidian の CSS が当たっている（簡易表示に切り替わっていない）
  await expect.poll(() => panel.evaluate(() => (document.querySelector('#view')!.shadowRoot!.getElementById('obsidian') as HTMLStyleElement).media)).toBe('all');
  expect(logs.filter(l => l.includes('簡易表示'))).toEqual([]);
  // 本文とコールアウトが見え、文字色が背景と同じでない
  await expect(panel.locator('.callout')).toBeVisible();
  await expect(panel.locator('.el-p p').first()).toBeVisible();
  const colors = await panel.locator('.el-p p').first().evaluate(el => ({ fg: getComputedStyle(el).color, bg: getComputedStyle(document.body).backgroundColor }));
  expect(colors.fg).not.toBe(colors.bg);
  // body のインライン style（アクセントカラー）が届いている
  expect(await card.evaluate(el => getComputedStyle(el).getPropertyValue('--accent-h').trim())).toBe('280');
  // カードの上の余白は、下のコメントとの間より広い
  const gap = await panel.evaluate(() => {
    const root = document.querySelector('#view')!.shadowRoot!;
    const cards = root.querySelectorAll('.obsidiannot-card');
    const ps = root.querySelectorAll('.el-p p');
    const above = cards[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom;
    const below = ps[1].getBoundingClientRect().top - cards[1].getBoundingClientRect().bottom;
    return { above, below };
  });
  expect(gap.above).toBeGreaterThan(gap.below);
  // ヘッダーのボタンが隠れず押せる
  await expect(panel.locator('#b-obsidian')).toBeEnabled();

  await panel.screenshot({ path: 'e2e/screenshots/sidepanel-obsidian-css.png' });

  // 編集モード: 閲覧表示は隠れ、エディタが上から始まる。アイコンは book-open
  await panel.locator('#b-mode').click();
  await expect(panel.locator('.cm-editor')).toBeVisible();
  await expect(panel.locator('#view')).toBeHidden();
  expect((await panel.locator('.cm-editor').boundingBox())!.y).toBeLessThan(120);
  await expect(panel.locator('#b-mode svg.lucide-book-open')).toHaveCount(1);
  await panel.locator('#b-mode').click();
  await expect(panel.locator('#b-mode svg.lucide-pen-line')).toHaveCount(1);
  await expect(card).toBeVisible();

  await panel.close();
  await page.close();
});
