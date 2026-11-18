/**
 * 拡張を読み込んだ Chromium と開発用サーバー（Obsidian プラグインと同じプロトコル）で
 * 通しの動作を確かめる。
 */
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseNote } from '@a08/core';
import { startDevServer } from '../packages/server/src/dev-server.ts';

const EXT = resolve('packages/extension/dist');
const FIXTURES = resolve('e2e/fixtures');
const WS_PORT = 27998;
const TOKEN = 'e2e-token';

let http: Server;
let base: string;
let vault: string;
let dev: Awaited<ReturnType<typeof startDevServer>>;
let context: BrowserContext;
let sw: Worker;
let extId: string;

async function noteFiles(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(join(vault, 'annotations'))).filter(f => f.endsWith('.md') && !f.startsWith('_'));
}

async function readOnlyNote() {
  const files = await noteFiles();
  expect(files).toHaveLength(1);
  const path = join(vault, 'annotations', files[0]);
  return { path, text: await readFile(path, 'utf8') };
}

/** ページ内の文字列を選択して mouseup を送る（ユーザーのドラッグ選択の代わり） */
async function selectText(page: Page, text: string, occurrence = 0) {
  await page.evaluate(
    ({ text, occurrence }) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = (n as Text).data.indexOf(text);
        if (i >= 0 && seen++ === occurrence) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + text.length);
          const sel = getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          const rect = r.getBoundingClientRect();
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right, clientY: rect.bottom }));
          return;
        }
      }
      throw new Error(`text not found: ${text}`);
    },
    { text, occurrence },
  );
}

async function highlightState(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const [name, h] of CSS.highlights) out[name] = [...h].map(r => (r as Range).toString());
    return out;
  });
}

async function tabIdOf(url: string): Promise<number> {
  return sw.evaluate(async u => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url === u)!.id!;
  }, url);
}

test.beforeAll(async () => {
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

  vault = await mkdtemp(join(tmpdir(), 'a08-e2e-'));
  dev = await startDevServer({ vault, port: WS_PORT, token: TOKEN, quiet: true });

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extId = new URL(sw.url()).host;
  await sw.evaluate(
    async ({ port, token }) => {
      await chrome.storage.local.set({
        settings: {
          port,
          token,
          ignoreSelectors: ['.immersive-translate-target-wrapper', '[data-immersive-translate-translation-element-mark]'],
        },
      });
    },
    { port: WS_PORT, token: TOKEN },
  );
  // 接続を待つ
  await expect
    .poll(async () => (await sw.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ kind: 'status' }, r)).catch(() => null))) as any, { timeout: 10_000 })
    .not.toBeNull();
  await expect.poll(() => dev.server.clientCount, { timeout: 10_000 }).toBeGreaterThan(0);
  // 設定画面が開いていれば閉じる
  for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();
});

test.afterAll(async () => {
  await context?.close();
  await dev?.stop();
  http?.close();
  await rm(vault, { recursive: true, force: true });
});

test.describe.configure({ mode: 'serial' });

test('註をつけるとノートが作られ、ハイライトされる', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html?utm_source=test`);
  await selectText(page, 'specific passages');
  const host = page.locator('a08-annotator');
  await expect(host.locator('.adder')).toBeVisible();
  await host.locator('.b-annotate').click();
  await expect(host.locator('.editor')).toBeVisible();
  await expect(host.locator('.editor .quote')).toHaveText('specific passages');
  await host.locator('textarea').fill('ここが要点。 #重要');
  await host.locator('textarea').press('Control+Enter');
  await expect(host.locator('.toast')).toHaveText('保存しました');

  const { text } = await readOnlyNote();
  const note = parseNote(text);
  expect(note.titles).toEqual(['A Test Article on Annotation']);
  // utm_* は除かれ、canonical と DOI も登録される
  expect(note.uris).toEqual([
    `${base}/article.html`,
    'https://example.org/articles/annotation',
    'https://doi.org/10.1234/abc.5678',
  ]);
  expect(note.annotations).toHaveLength(1);
  const a = note.annotations[0];
  expect(a.comment).toBe('ここが要点。 #重要');
  expect(a.source).toBe(`${base}/article.html`);
  expect(a.tags).toEqual(['重要']);
  expect(a.selector.map(s => s.type).sort()).toEqual(['RangeSelector', 'TextPositionSelector', 'TextQuoteSelector']);

  // CSS Custom Highlight API（content script から登録したものがページから見える）
  await expect.poll(() => highlightState(page)).toMatchObject({ 'a08-t0': ['specific passages'] });
  await page.close();
});

test('ハイライトだけ保存でき、再読み込みしても復元される', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(() => highlightState(page)).toMatchObject({ 'a08-t0': ['specific passages'] });
  await selectText(page, 'approximate matching');
  await page.locator('a08-annotator .b-highlight').click();
  await expect.poll(() => highlightState(page)).toMatchObject({ 'a08-default': ['approximate matching'] });

  await page.reload();
  await expect.poll(() => highlightState(page)).toMatchObject({
    'a08-t0': ['specific passages'],
    'a08-default': ['approximate matching'],
  });
  // 余白マーカー
  await expect(page.locator('a08-annotator .marker')).toHaveCount(2);
  await page.close();
});

test('Obsidian 側でタグを書き換えるとハイライトの種類が変わる', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(() => highlightState(page)).toMatchObject({ 'a08-default': ['approximate matching'] });
  const { path, text } = await readOnlyNote();
  // 2 つ目の註にコメント「#定義 #疑問」を足す（外部エディタでの編集）
  const lines = text.trimEnd().split('\n');
  await writeFile(path, `${lines.join('\n')}\n用語の説明 #定義 #疑問\n`);
  await expect
    .poll(() => highlightState(page), { timeout: 5000 })
    .toMatchObject({ 'a08-t1': ['approximate matching'], 'a08-t2': ['approximate matching'] });
  expect((await highlightState(page))['a08-default']).toBeUndefined();
  await page.close();
});

test('対訳表示の訳文は無視され、原文にだけ註がつく', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(async () => Object.keys(await highlightState(page)).length).toBeGreaterThan(0);
  // Immersive Translate のような訳文挿入をまねる
  await page.evaluate(() => {
    for (const p of document.querySelectorAll('article p')) {
      const t = document.createElement('font');
      t.className = 'notranslate immersive-translate-target-wrapper';
      t.setAttribute('data-immersive-translate-translation-element-mark', '1');
      t.innerHTML = `<br><font class="notranslate">【訳】${p.textContent}</font>`;
      p.appendChild(t);
    }
  });
  // 訳文の挿入後もハイライトは原文のまま
  await expect.poll(() => highlightState(page)).toMatchObject({ 'a08-t0': ['specific passages'] });

  // 段落をまたいで選択（間に訳文がある）
  await page.evaluate(() => {
    const p2 = document.getElementById('p2')!.firstChild as Text;
    const p3 = document.getElementById('p3')!.firstChild as Text;
    const r = document.createRange();
    r.setStart(p2, p2.data.indexOf('character position'));
    r.setEnd(p3, 'When the page'.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('a08-annotator .b-annotate').click();
  await page.locator('a08-annotator textarea').fill('段落をまたぐ #引用');
  await page.locator('a08-annotator .b-save').click();
  await expect(page.locator('a08-annotator .toast')).toHaveText('保存しました');

  const note = parseNote((await readOnlyNote()).text);
  const a = note.annotations.at(-1)!;
  const quote = a.selector.find(s => s.type === 'TextQuoteSelector') as { exact: string };
  expect(quote.exact).not.toContain('訳');
  expect(quote.exact.replace(/\s+/g, ' ')).toBe('character position. When the page');
  // ハイライトは訳文を塗らない（テキストノードごとに分割）
  const hl = await highlightState(page);
  expect(hl['a08-t3']).toEqual(['character position.', 'When the page']);

  // 訳文のない状態で開き直しても同じ箇所に付く
  await page.reload();
  await expect.poll(async () => (await highlightState(page))['a08-t3']?.join('|')).toBe('character position.|When the page');
  await page.close();
});

test('ハイライトをクリックするとサイドパネルの該当カードに移動する', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(async () => (await highlightState(page))['a08-t0']).toEqual(['specific passages']);
  const tabId = await tabIdOf(page.url());

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  await expect(panel.locator('#title')).toHaveText('A Test Article on Annotation');
  await expect(panel.locator('.a08-card')).toHaveCount(3);
  await expect(panel.locator('.a08-card').first()).toContainText('specific passages');
  await expect(panel.locator('#view')).toContainText('ここが要点。');

  // ページ側でハイライトをクリック
  await page.bringToFront();
  const box = await page.evaluate(() => {
    const t = document.querySelector('#p1 em')!.firstChild!;
    const r = document.createRange();
    r.selectNodeContents(t);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await expect(panel.locator('.a08-card.flash')).toHaveCount(1);
  await expect(panel.locator('.a08-card.flash')).toContainText('specific passages');

  // カードをクリックするとページがスクロールし、フォーカス表示になる
  await panel.locator('.a08-card', { hasText: 'approximate matching' }).click();
  await expect.poll(async () => (await highlightState(page))['a08-focus']).toEqual(['approximate matching']);

  await panel.screenshot({ path: 'e2e/screenshots/sidepanel-view.png' });
  await page.close();
  await panel.close();
});

test('サイドパネルで編集すると vault のノートに保存される', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(async () => (await highlightState(page))['a08-t0']).toEqual(['specific passages']);
  const tabId = await tabIdOf(page.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  await expect(panel.locator('.a08-card')).toHaveCount(3);

  await panel.locator('#b-mode').click();
  await expect(panel.locator('.cm-editor')).toBeVisible();
  // 最初の註のコメントの末尾に追記
  await panel.locator('.cm-content').click();
  await panel.evaluate(() => {
    const lines = document.querySelectorAll('.cm-line');
    const target = [...lines].find(l => l.textContent?.includes('ここが要点。'))!;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await panel.keyboard.type(' 追記 #疑問');
  await expect(panel.locator('.save-state')).toHaveText('保存済み', { timeout: 5000 });

  const note = parseNote((await readOnlyNote()).text);
  expect(note.annotations[0].comment).toBe('ここが要点。 #重要 追記 #疑問');
  // ページのハイライトにも反映（#重要 と #疑問）
  await expect
    .poll(async () => {
      const h = await highlightState(page);
      return [h['a08-t0']?.includes('specific passages'), h['a08-t2']?.includes('specific passages')];
    })
    .toEqual([true, true]);

  await panel.screenshot({ path: 'e2e/screenshots/sidepanel-edit.png' });
  await page.bringToFront();
  await page.screenshot({ path: 'e2e/screenshots/page-highlights.png' });
  await panel.locator('#b-mode').click();
  await page.close();
  await panel.close();
});

test('Obsidian から開くと既存タブが前面に出て該当箇所へスクロールする', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(async () => (await highlightState(page))['a08-t0']).toEqual(['specific passages']);
  // 下の段落に註をつける
  await selectText(page, 'far below the fold');
  await page.locator('a08-annotator .b-highlight').click();
  await expect(page.locator('a08-annotator .toast')).toHaveText('保存しました');
  const note = parseNote((await readOnlyNote()).text);
  const a = note.annotations.at(-1)!;
  await page.evaluate(() => scrollTo(0, 0));

  // 別のタブを前面にしておく
  const other = await context.newPage();
  await other.goto(`${base}/other.html`);
  const pageCountBefore = context.pages().length;

  dev.server.broadcast('reveal', {
    path: 'annotations/x.md',
    id: a.id,
    uris: note.uris,
    source: a.source,
    url: a.source,
  });
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 5000 }).toBeGreaterThan(800);
  await expect.poll(async () => (await highlightState(page))['a08-focus']).toEqual(['far below the fold']);
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  expect(context.pages().length).toBe(pageCountBefore);

  // タブがない場合は新しく開いてからスクロール
  await page.close();
  const opened = context.waitForEvent('page');
  dev.server.broadcast('reveal', { path: 'annotations/x.md', id: a.id, uris: note.uris, source: a.source, url: a.source });
  const np = await opened;
  await np.waitForLoadState();
  await expect.poll(() => np.evaluate(() => scrollY), { timeout: 8000 }).toBeGreaterThan(800);
  await np.close();
  await other.close();
});

test('別の URI（canonical 経由）で開いた同じ文書でも註が出る', async () => {
  // 同じ canonical を持つ別パスのページ
  await mkdir(join(FIXTURES, 'tmp'), { recursive: true });
  const html = await readFile(join(FIXTURES, 'article.html'), 'utf8');
  await writeFile(join(FIXTURES, 'tmp', 'mirror.html'), html.replace('<p id="p1">', '<p>Mirror notice.</p><p id="p1">'));
  try {
    const page = await context.newPage();
    await page.goto(`${base}/tmp/mirror.html`);
    // 位置情報は使わず引用で探すので、段落が増えていても当たる
    await expect.poll(async () => (await highlightState(page))['a08-t0']).toEqual(['specific passages']);
    await page.close();
  } finally {
    await rm(join(FIXTURES, 'tmp'), { recursive: true, force: true });
  }
});
