/**
 * PDF への註の描画と選択（packages/obsidian-plugin/src/local/pdf.ts）を、PDF.js の標準のビューアの上で確かめる。
 * Obsidian の PDF ビューアは PDF.js のビューアを元にしているので、文字の層の作り（textDivs・<br>・eventBus）は同じ。
 * Obsidian に組み込んだ形（ビューの取り方など）は実機でしか確かめられない。
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { makePdf } from '../packages/core/test/make-pdf.ts';

const OUT = resolve('e2e/.build/pdf-harness');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

let server: Server;
let base: string;
let browser: Browser;
let page: Page;

const PDF = makePdf([
  ['Web annotation lets readers attach notes.', 'The same phrase appears here.'],
  ['Second page text.', 'The same phrase appears here.'],
]);

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
  await build({
    entryPoints: [resolve('e2e/pdf-harness/entry.ts')],
    outfile: join(OUT, 'harness.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    alias: { obsidian: resolve('e2e/pdf-harness/obsidian-stub.ts') },
    logLevel: 'silent',
  });
  await copyFile(resolve('node_modules/pdfjs-dist/build/pdf.worker.mjs'), join(OUT, 'pdf.worker.mjs'));
  await copyFile(resolve('node_modules/pdfjs-dist/web/pdf_viewer.css'), join(OUT, 'pdf_viewer.css'));
  await copyFile(resolve('packages/obsidian-plugin/styles.css'), join(OUT, 'plugin.css'));
  await writeFile(join(OUT, 'index.html'), await readFile(resolve('e2e/pdf-harness/index.html')));
  server = createServer(async (req, res) => {
    try {
      const name = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/+/, '') || 'index.html';
      const body = await readFile(join(OUT, name));
      res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  page = await browser.newPage({ viewport: { width: 1000, height: 2400 } });
  page.on('pageerror', e => console.log('pageerror', e));
  await page.goto(`${base}/index.html`);
  await page.waitForFunction(() => (window as any).harness);
  await page.evaluate(bytes => (window as any).harness.open(bytes), Array.from(PDF));
});

test.afterAll(async () => {
  await browser?.close();
  server?.close();
});

test.describe.configure({ mode: 'serial' });

/** ページの文字の層で、その文字列の画面上の矩形 */
async function textRect(pageNumber: number, text: string) {
  return page.evaluate(
    ({ pageNumber, text }) => {
      const layer = document.querySelector(`.page[data-page-number="${pageNumber}"] .textLayer`)!;
      const w = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = (n as Text).data.indexOf(text);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + text.length);
        const b = r.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      }
      return null;
    },
    { pageNumber, text },
  );
}

async function drawnRects(pageNumber: number) {
  return page.evaluate(
    pageNumber =>
      Array.from(document.querySelectorAll<HTMLElement>(`.page[data-page-number="${pageNumber}"] .obsidiannot-pdf-rect`)).map(el => {
        const b = el.getBoundingClientRect();
        return { id: el.dataset.obsidiannotId, left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      }),
    pageNumber,
  );
}

let text = '';
let start2 = 0;

test('PDF の文字を取り出し、2 ページ目の註をその文字の上に描く', async () => {
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.page .textLayer span').length)).toBeGreaterThan(3);
  const m = await page.evaluate(() => (window as any).harness.model());
  text = m.text;
  expect(m.starts).toHaveLength(2);
  start2 = text.lastIndexOf('same phrase');
  expect(start2).toBeGreaterThan(m.starts[1]);
  await page.evaluate(
    ([s, e]) => (window as any).harness.setAnnos([{ id: 'a1', start: s, end: e, status: 'ok', styleKey: 'default' }]),
    [start2, start2 + 'same phrase'.length],
  );
  await expect.poll(async () => (await drawnRects(2)).length).toBe(1);
  expect(await drawnRects(1)).toHaveLength(0);
  const want = (await textRect(2, 'same phrase'))!;
  const [got] = await drawnRects(2);
  for (const k of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(got[k] - want[k])).toBeLessThan(2);
});

test('拡大するとページが描き直され、ハイライトも追従する', async () => {
  await page.evaluate(() => (window as any).harness.scale('2'));
  await expect
    .poll(async () => {
      const want = await textRect(2, 'same phrase');
      const [got] = await drawnRects(2);
      return !!want && !!got && Math.abs(got.left - want.left) < 3 && Math.abs(got.right - want.right) < 3 && Math.abs(got.top - want.top) < 3;
    })
    .toBe(true);
  await page.evaluate(() => (window as any).harness.scale('1'));
});

test('ハイライトを押すとその註、外を押すと何もない', async () => {
  await expect.poll(async () => (await drawnRects(2)).length).toBe(1);
  const [r] = await drawnRects(2);
  expect(await page.evaluate(([x, y]) => (window as any).harness.hitTest(x, y), [(r.left + r.right) / 2, (r.top + r.bottom) / 2])).toBe('a1');
  expect(await page.evaluate(([x, y]) => (window as any).harness.hitTest(x, y), [r.left - 40, r.top - 40])).toBeNull();
});

test('文字の層の選択を、PDF 全体の文字列の範囲にする', async () => {
  const sel = await page.evaluate(() => {
    const layer = document.querySelector('.page[data-page-number="1"] .textLayer')!;
    const w = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = (n as Text).data.indexOf('attach notes');
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 'attach notes'.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      return (window as any).harness.selection();
    }
    return null;
  });
  expect(sel).toMatchObject({ start: text.indexOf('attach notes'), end: text.indexOf('attach notes') + 'attach notes'.length });

  // ページをまたぐ選択（1 ページ目の最後の行から 2 ページ目の最初の行まで）
  const across = await page.evaluate(() => {
    const find = (p: number, t: string) => {
      const layer = document.querySelector(`.page[data-page-number="${p}"] .textLayer`)!;
      const w = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = (n as Text).data.indexOf(t);
        if (i >= 0) return { n, i };
      }
      throw new Error(t);
    };
    const a = find(1, 'appears here');
    const b = find(2, 'Second page');
    const r = document.createRange();
    r.setStart(a.n, a.i);
    r.setEnd(b.n, b.i + 'Second page'.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    return (window as any).harness.selection();
  });
  expect(across.text.slice(across.start, across.end)).toMatch(/^appears here\.\s+Second page$/);
});

test('PDF の該当箇所へのリンクは、ページと文字の層の番号で表す', async () => {
  const range = [start2, start2 + 'same phrase'.length];
  // PDF.js 本来の文字の層には番号（data-idx）がないので、ページだけのリンクになる
  expect(await page.evaluate(([s, e]) => (window as any).harness.linkTarget(s, e), range)).toBe('#page=2');

  // Obsidian の文字の層のように番号を振ると、Obsidian 標準の selection=開始の番号,位置,終わりの番号,位置 になる
  const expected = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll<HTMLElement>('.page[data-page-number="2"] .textLayer span')).filter(
      el => !el.classList.contains('markedContent'),
    );
    spans.forEach((el, i) => (el.dataset.idx = String(i)));
    const i = spans.findIndex(el => el.textContent!.includes('same phrase'));
    const off = spans[i].textContent!.indexOf('same phrase');
    return `#page=2&selection=${i},${off},${i},${off + 'same phrase'.length}`;
  });
  expect(await page.evaluate(([s, e]) => (window as any).harness.linkTarget(s, e), range)).toBe(expected);
});

test('下線のタグ（#定義・#疑問）は、箱の下に線を描く', async () => {
  // 既定のスタイルの順: 重要 t0, 定義 t1, 疑問 t2, 引用 t3
  const s1 = text.indexOf('Web annotation');
  const s2 = text.indexOf('attach notes');
  const s3 = text.indexOf('Second page');
  await page.evaluate(
    list => (window as any).harness.setAnnos(list),
    [
      { id: 'def', start: s1, end: s1 + 'Web annotation'.length, status: 'ok', styleKey: 't1' },
      { id: 'q', start: s2, end: s2 + 'attach notes'.length, status: 'ok', styleKey: 't2' },
      { id: 'cite', start: s3, end: s3 + 'Second page'.length, status: 'ok', styleKey: 't3' },
    ],
  );
  const after = (id: string) =>
    page.evaluate(id => {
      const el = document.querySelector<HTMLElement>(`.obsidiannot-pdf-rect[data-obsidiannot-id="${id}"]`);
      if (!el) return null;
      const cs = getComputedStyle(el, '::after');
      const box = el.getBoundingClientRect();
      return { content: cs.content, border: `${cs.borderTopStyle} ${cs.borderTopColor} ${cs.borderTopWidth}`, mask: cs.maskImage || (cs as any).webkitMaskImage, bg: getComputedStyle(el).backgroundColor, w: box.width };
    }, id);
  await expect.poll(() => after('def')).not.toBeNull();
  const def = (await after('def'))!;
  expect(def.content).not.toBe('none');
  expect(def.border).toBe('solid rgb(47, 111, 222) 2px');
  expect(def.bg).toBe('rgba(0, 0, 0, 0)');
  const q = (await after('q'))!;
  expect(q.mask).toContain('svg');
  // 全面のハイライト（#引用）には線を描かない
  const cite = (await after('cite'))!;
  expect(cite.content).toBe('none');
  expect(cite.bg).not.toBe('rgba(0, 0, 0, 0)');
  const r = await textRect(1, 'Web annotation');
  await page.screenshot({ path: 'test-results/pdf-underline.png', clip: { x: r!.left - 20, y: r!.top - 20, width: 520, height: 120 } });
});
