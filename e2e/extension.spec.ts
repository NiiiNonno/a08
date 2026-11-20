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
  return (await readdir(join(vault, 'obsidiannot'))).filter(f => f.endsWith('.md') && !f.startsWith('_'));
}

async function readOnlyNote() {
  const files = await noteFiles();
  expect(files).toHaveLength(1);
  const path = join(vault, 'obsidiannot', files[0]);
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
      // ?delay=ms で応答を遅らせる（読み込み中のタブの確認用）
      const delay = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('delay') ?? 0);
      if (delay) await new Promise(r => setTimeout(r, delay));
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
  dev = await startDevServer({
    vault,
    port: WS_PORT,
    token: TOKEN,
    quiet: true,
    // Obsidian の CSS の代わり（サイドパネルが取り込むことを確かめる）
    appearance: {
      version: 'v1',
      // プラグインの styles.css と、Obsidian のテーマ変数の一部
      css:
        (await readFile('packages/obsidian-plugin/styles.css', 'utf8')) +
        '\n.obsidiannot-body.theme-test { --background-secondary: #f3f4f6; --background-modifier-hover: #eceef1;' +
        ' --text-normal: #222; --text-muted: #666; --text-faint: #999; --tag-color: #2f6fde; --obsidiannot-test: 1; }' +
        // Obsidian の画面全体のレイアウト用の指定（プラグインが html/body を書き換えた後の形）。サイドパネルでは無効にする
        '\n.obsidiannot-root, .obsidiannot-body { height: 100%; overflow: hidden; position: fixed; inset: 0; }' +
        '\n.obsidiannot-body { display: flex; background: #fff; }' +
        '\n.markdown-preview-view { height: 100%; overflow-y: auto; position: absolute; }' +
        '\n.markdown-preview-sizer { min-height: 900px; }',
      bodyClass: 'theme-test',
      // Obsidian ではアクセントカラーが body のインライン style にある
      bodyStyle: '--obsidiannot-inline-test: 7;',
    },
  });

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
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
});

async function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

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
  const host = page.locator('obsidiannot-ui');
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

  // 見出しにタイトルは書かない
  expect(text).not.toMatch(/^# /m);

  // CSS Custom Highlight API（content script から登録したものがページから見える）
  await expect.poll(() => highlightState(page)).toMatchObject({ 'obsidiannot-t0': ['specific passages'] });
  await page.close();
});

test('照: ハイライトとブロック ID が保存され、リンクがコピーされる', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(() => highlightState(page)).toMatchObject({ 'obsidiannot-t0': ['specific passages'] });
  await selectText(page, 'approximate matching');
  await expect(page.locator('obsidiannot-ui .adder')).toBeVisible();
  const ab = (await page.locator('obsidiannot-ui .adder').boundingBox())!;
  await page.screenshot({ path: 'e2e/screenshots/adder.png', clip: { x: ab.x - 260, y: ab.y - 80, width: 420, height: ab.height + 100 } });
  await page.locator('obsidiannot-ui .b-shou').click();
  await expect.poll(() => highlightState(page)).toMatchObject({ 'obsidiannot-default': ['approximate matching'] });

  const { path, text } = await readOnlyNote();
  const a = parseNote(text).annotations[1];
  expect(a.blockId).toMatch(/^[a-z0-9]{6}$/);
  expect(text).toContain(`\n^${a.blockId}\n`);
  const name = path.split('/').pop()!.replace(/\.md$/, '');
  await expect(page.locator('obsidiannot-ui .toast')).toContainText('リンクをコピーしました');
  await expect.poll(() => clipboard(page)).toBe(`[[${name}#^${a.blockId}]]`);

  await page.reload();
  await expect.poll(() => highlightState(page)).toMatchObject({
    'obsidiannot-t0': ['specific passages'],
    'obsidiannot-default': ['approximate matching'],
  });
  // 余白マーカー
  await expect(page.locator('obsidiannot-ui .marker')).toHaveCount(2);

  // 既存の註のハイライトをクリックすると、その ID へのリンクがコピーされる（ID は作ったときから付いている）
  const firstId = parseNote(text).annotations[0].blockId;
  expect(firstId).toMatch(/^[a-z0-9]{6}$/);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  const box = await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector('#p1 em')!.firstChild!);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  const first = parseNote((await readOnlyNote()).text).annotations[0];
  expect(first.blockId).toBe(firstId);
  expect(first.comment).toBe('ここが要点。 #重要');
  await expect.poll(() => clipboard(page)).toBe(`[[${name}#^${first.blockId}]]`);
  await page.close();
});

test('Obsidian 側でタグを書き換えるとハイライトの種類が変わる', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(() => highlightState(page)).toMatchObject({ 'obsidiannot-default': ['approximate matching'] });
  const { path, text } = await readOnlyNote();
  // 2 つ目の註にコメント「#定義 #疑問」を足す（外部エディタでの編集）
  const lines = text.trimEnd().split('\n');
  // 最後の註は照（^id の行がある）なので、空行を挟んでコメントを書く
  await writeFile(path, `${lines.join('\n')}\n\n用語の説明 #定義 #疑問\n`);
  await expect
    .poll(() => highlightState(page), { timeout: 5000 })
    .toMatchObject({ 'obsidiannot-t1': ['approximate matching'], 'obsidiannot-t2': ['approximate matching'] });
  expect((await highlightState(page))['obsidiannot-default']).toBeUndefined();
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
  await expect.poll(() => highlightState(page)).toMatchObject({ 'obsidiannot-t0': ['specific passages'] });

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
  await page.locator('obsidiannot-ui .b-annotate').click();
  await page.locator('obsidiannot-ui textarea').fill('段落をまたぐ #引用');
  await page.locator('obsidiannot-ui .b-save').click();
  await expect(page.locator('obsidiannot-ui .toast')).toHaveText('保存しました');

  const note = parseNote((await readOnlyNote()).text);
  const a = note.annotations.at(-1)!;
  const quote = a.selector.find(s => s.type === 'TextQuoteSelector') as { exact: string };
  expect(quote.exact).not.toContain('訳');
  expect(quote.exact.replace(/\s+/g, ' ')).toBe('character position. When the page');
  // ハイライトは訳文を塗らない（テキストノードごとに分割）
  const hl = await highlightState(page);
  expect(hl['obsidiannot-t3']).toEqual(['character position.', 'When the page']);

  // 訳文のない状態で開き直しても同じ箇所に付く
  await page.reload();
  await expect.poll(async () => (await highlightState(page))['obsidiannot-t3']?.join('|')).toBe('character position.|When the page');
  await page.close();
});

test('ハイライトをクリックするとサイドパネルの該当カードに移動する', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(async () => (await highlightState(page))['obsidiannot-t0']).toEqual(['specific passages']);
  const tabId = await tabIdOf(page.url());

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  await expect(panel.locator('#title')).toHaveText('A Test Article on Annotation');
  await expect(panel.locator('.obsidiannot-card')).toHaveCount(3);
  await expect(panel.locator('.obsidiannot-card').first()).toContainText('specific passages');
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
  await expect(panel.locator('.obsidiannot-card.flash')).toHaveCount(1);
  await expect(panel.locator('.obsidiannot-card.flash')).toContainText('specific passages');

  // カードをクリックするとページがスクロールし、フォーカス表示になる
  await panel.locator('.obsidiannot-card', { hasText: 'approximate matching' }).click();
  await expect.poll(async () => (await highlightState(page))['obsidiannot-focus']).toEqual(['approximate matching']);

  await panel.screenshot({ path: 'e2e/screenshots/sidepanel-view.png' });
  await page.close();
  await panel.close();
});

test('サイドパネルで編集すると vault のノートに保存される', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(async () => (await highlightState(page))['obsidiannot-t0']).toEqual(['specific passages']);
  const tabId = await tabIdOf(page.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  await expect(panel.locator('.obsidiannot-card')).toHaveCount(3);

  await panel.locator('#b-mode').click();
  await expect(panel.locator('.cm-editor')).toBeVisible();
  // 編集中は閲覧表示を隠し、エディタはパネルの上端から始まる
  await expect(panel.locator('#view')).toBeHidden();
  expect((await panel.locator('.cm-editor').boundingBox())!.y).toBeLessThan(120);
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
      return [h['obsidiannot-t0']?.includes('specific passages'), h['obsidiannot-t2']?.includes('specific passages')];
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
  await expect.poll(async () => (await highlightState(page))['obsidiannot-t0']).toEqual(['specific passages']);
  // 下の段落に註をつける
  await selectText(page, 'far below the fold');
  await page.locator('obsidiannot-ui .b-shou').click();
  await expect(page.locator('obsidiannot-ui .toast')).toContainText('リンクをコピーしました');
  const note = parseNote((await readOnlyNote()).text);
  const a = note.annotations.at(-1)!;
  await page.evaluate(() => scrollTo(0, 0));

  // 別のタブを前面にしておく
  const other = await context.newPage();
  await other.goto(`${base}/other.html`);
  const pageCountBefore = context.pages().length;

  dev.server.broadcast('reveal', {
    path: 'obsidiannot/x.md',
    id: a.id,
    uris: note.uris,
    source: a.source,
    url: a.source,
  });
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 5000 }).toBeGreaterThan(800);
  await expect.poll(async () => (await highlightState(page))['obsidiannot-focus']).toEqual(['far below the fold']);
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  expect(context.pages().length).toBe(pageCountBefore);

  // タブがない場合は新しく開いてからスクロール
  await page.close();
  const opened = context.waitForEvent('page');
  dev.server.broadcast('reveal', { path: 'obsidiannot/x.md', id: a.id, uris: note.uris, source: a.source, url: a.source });
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
    await expect.poll(async () => (await highlightState(page))['obsidiannot-t0']).toEqual(['specific passages']);
    await page.close();
  } finally {
    await rm(join(FIXTURES, 'tmp'), { recursive: true, force: true });
  }
});

test('サイドパネル: Obsidian の CSS・vault 内の画像・アイコン・ファイル名の変更', async () => {
  const { path, text } = await readOnlyNote();
  await mkdir(join(vault, 'img'), { recursive: true });
  // 1x1 の PNG
  await writeFile(
    join(vault, 'img/dot.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  );
  await writeFile(path, `${text.trimEnd()}\n\n![](img/dot.png)\n`);

  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(async () => (await highlightState(page))['obsidiannot-t0']).toEqual(['specific passages']);
  const tabId = await tabIdOf(page.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  await expect(panel.locator('.obsidiannot-card')).toHaveCount(4);

  // Obsidian の CSS（テスト用）が Shadow DOM 内に適用される
  await expect
    .poll(() => panel.locator('.obsidiannot-card').first().evaluate(el => getComputedStyle(el).getPropertyValue('--obsidiannot-test')))
    .toBe('1');
  expect(await panel.locator('.obsidiannot-card').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(243, 244, 246)');
  expect(await panel.locator('.obsidiannot-card').first().evaluate(el => getComputedStyle(el).getPropertyValue('--obsidiannot-inline-test'))).toBe('7');
  // 本文が見えていて、ヘッダーのボタンも隠れない
  await expect(panel.locator('.obsidiannot-card').first()).toBeVisible();
  expect((await panel.locator('#content').boundingBox())!.height).toBeGreaterThan(50);
  await expect(panel.locator('#b-obsidian')).toBeEnabled();
  expect(await panel.evaluate(() => {
    const b = document.getElementById('b-obsidian')!.getBoundingClientRect();
    return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('#b-obsidian') != null;
  })).toBe(true);
  // vault 内の画像は blob: URL で表示される
  await expect.poll(() => panel.locator('img[data-obsidiannot-resource]').getAttribute('src')).toMatch(/^blob:/);
  expect(await panel.locator('img[data-obsidiannot-resource]').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
  // ボタンはアイコン（表示中は pen-line）
  await expect(panel.locator('#b-mode svg.lucide-pen-line')).toHaveCount(1);
  await panel.locator('#b-mode').click();
  await expect(panel.locator('#b-mode svg.lucide-book-open')).toHaveCount(1);
  await panel.locator('#b-mode').click();
  await expect(panel.locator('#b-mode svg.lucide-pen-line')).toHaveCount(1);

  // ファイル名の変更
  await panel.locator('#sub .filename').click();
  await panel.locator('#sub input.rename').fill('改名したノート');
  await panel.locator('#sub input.rename').press('Enter');
  await expect(panel.locator('#sub .filename')).toContainText('改名したノート');
  expect(await noteFiles()).toEqual(['改名したノート.md']);
  // ページ側も新しいパスのノートを使い続ける
  await selectText(page, 'far below the fold');
  await page.locator('obsidiannot-ui .b-annotate').click();
  await page.locator('obsidiannot-ui textarea').fill('改名後');
  await page.locator('obsidiannot-ui .b-save').click();
  await expect(page.locator('obsidiannot-ui .toast')).toHaveText('保存しました');
  expect(await noteFiles()).toEqual(['改名したノート.md']);
  await page.close();
  await panel.close();
});

test('content script を入れ直しても二重に動かない', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`);
  await expect.poll(async () => (await highlightState(page))['obsidiannot-t0']).toEqual(['specific passages']);
  const tabId = await tabIdOf(page.url());
  // 拡張の再読み込み後などにサイドパネルが行う注入と同じ
  expect(await sw.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] }).then(() => true), tabId)).toBe(true);
  await expect.poll(async () => (await highlightState(page))['obsidiannot-t0']).toEqual(['specific passages']);
  await expect(page.locator('obsidiannot-ui')).toHaveCount(1);
  await selectText(page, 'requires scrolling');
  await expect(page.locator('obsidiannot-ui .adder')).toBeVisible();
  await page.close();
});

test('サイドパネルはタブ別に設定しない（1 つのパネルを使い回す）', async () => {
  const page = await context.newPage();
  await page.goto('data:text/html,<p>unsupported</p>');
  await page.goto(`${base}/other.html`);
  const id = await tabIdOf(`${base}/other.html`);
  // タブ別の設定があると Chrome がタブごとに別のパネルを作り、裏のパネルが止まる
  expect(await sw.evaluate(t => chrome.sidePanel.getOptions({ tabId: t }), id)).not.toHaveProperty('enabled', false);
  expect(await sw.evaluate(t => chrome.sidePanel.getOptions({ tabId: t }), id)).not.toHaveProperty('tabId');
  expect(await sw.evaluate(() => chrome.sidePanel.getOptions({}))).toMatchObject({ enabled: true, path: 'sidepanel.html' });
  await page.close();
});

test('タブを切り替えると、サイドパネルがそのタブのノートに追従する', async () => {
  const a = await context.newPage();
  await a.goto(`${base}/article.html`);
  await expect.poll(async () => (await highlightState(a))['obsidiannot-t0']).toEqual(['specific passages']);
  const b = await context.newPage();
  await b.goto(`${base}/other.html`);
  const winId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].windowId);
  const aId = await tabIdOf(a.url());
  const bId = await tabIdOf(b.url());

  // パネルを別ウィンドウで開き、元のウィンドウのアクティブなタブを追わせる
  const opened = context.waitForEvent('page');
  await sw.evaluate(
    ({ ext, w }) => chrome.windows.create({ url: `chrome-extension://${ext}/sidepanel.html?window=${w}`, focused: false }),
    { ext: extId, w: winId },
  );
  const panel = await opened;
  const activate = (id: number) => sw.evaluate(t => chrome.tabs.update(t, { active: true }).then(() => undefined), id);

  for (let i = 0; i < 3; i++) {
    await activate(aId);
    await expect(panel.locator('.obsidiannot-card').first()).toBeVisible();
    await activate(bId);
    await expect(panel.locator('.empty')).toContainText('このページの註はまだありません');
  }
  // 素早く切り替えても、最後のタブの表示になる
  await activate(aId);
  await activate(bId);
  await activate(aId);
  await expect(panel.locator('.obsidiannot-card').first()).toBeVisible();
  await expect(panel.locator('#banner')).toBeHidden();

  // 拡張が入れないページでは控えめな表示、戻ると註が出る
  await b.goto('data:text/html,<p>unsupported</p>');
  await activate(bId);
  await expect(panel.locator('.empty.quiet')).toContainText('このページでは註をつけられません');
  await activate(aId);
  await expect(panel.locator('.obsidiannot-card').first()).toBeVisible();
  // 同じタブでサイトを移ると追従する
  await b.goto(`${base}/other.html`);
  await activate(bId);
  await expect(panel.locator('.empty')).toContainText('このページの註はまだありません');
  await b.goto(`${base}/article.html`);
  await expect(panel.locator('.obsidiannot-card').first()).toBeVisible();
  // ページ側で註をつけると、パネルにもすぐ出る
  const before = await panel.locator('.obsidiannot-card').count();
  await b.bringToFront();
  await b.evaluate(() => {
    const t = document.querySelector('#p4')!.firstChild as Text;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, 14);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await b.locator('obsidiannot-ui .b-shou').click();
  await expect(panel.locator('.obsidiannot-card')).toHaveCount(before + 1);
  await b.goto(`${base}/other.html`);
  await expect(panel.locator('.empty')).toContainText('このページの註はまだありません');

  // 読み込みに時間がかかるページ: 「使えません」ではなく読み込み中と出て、読み込み後に註が出る
  await b.goto(`${base}/article.html?delay=1500`, { waitUntil: 'commit' }).catch(() => undefined);
  await activate(bId);
  await expect(panel.locator('#view')).not.toContainText('接続できません');
  await expect(panel.locator('.obsidiannot-card').first()).toBeVisible({ timeout: 8000 });
  await panel.close();
  await a.close();
  await b.close();
});

test('本文が内側の要素でスクロールするページでも、余白マーカーが追従し、該当箇所へスクロールできる', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/scroller.html`);
  await expect(page.locator('obsidiannot-ui')).toHaveCount(0);
  for (const t of ['inner marker phrase', 'deep paragraph']) {
    if (t === 'deep paragraph') await page.evaluate(() => document.getElementById('s2')!.scrollIntoView());
    await selectText(page, t);
    await page.locator('obsidiannot-ui .b-shou').click();
    await expect(page.locator('obsidiannot-ui .toast')).toContainText('リンクをコピーしました');
  }
  const markerTops = () =>
    page.evaluate(() =>
      [...document.querySelector('obsidiannot-ui')!.shadowRoot!.querySelectorAll<HTMLElement>('.marker')].map(m => Math.round(parseFloat(m.style.top))),
    );
  const rectTop = (id: string) => page.evaluate(i => Math.round(document.getElementById(i)!.getBoundingClientRect().top), id);

  // 下の段落が見えている: そのマーカーだけが、段落の位置に出る
  await expect.poll(async () => (await markerTops()).length).toBe(1);
  expect(Math.abs((await markerTops())[0] - (await rectTop('s2')))).toBeLessThan(30);

  // 内側の要素を上までスクロールすると、マーカーも追従する
  await page.evaluate(() => (document.getElementById('scroller')!.scrollTop = 0));
  await expect.poll(async () => (await markerTops()).length).toBe(1);
  await expect.poll(async () => Math.abs((await markerTops())[0] - (await rectTop('s1')))).toBeLessThan(30);

  // Obsidian から開く（サイドパネルのカードのクリックも同じ）: 内側の要素がスクロールする
  const note = parseNote(await readFile(join(vault, 'obsidiannot', 'Scroller Page.md'), 'utf8'));
  const deep = note.annotations.find(a => a.selector.some(s => s.type === 'TextQuoteSelector' && s.exact === 'deep paragraph'))!;
  dev.server.broadcast('reveal', { path: 'obsidiannot/Scroller Page.md', id: deep.id, uris: note.uris, source: deep.source, url: deep.source });
  await expect.poll(() => page.evaluate(() => document.getElementById('scroller')!.scrollTop), { timeout: 5000 }).toBeGreaterThan(1000);
  await expect.poll(async () => {
    const t = await rectTop('s2');
    return t > 0 && t < 800;
  }).toBe(true);
  await page.close();
});

test('サイドパネルから空のノートを作って編集し、削除できる。長い URL は短く表示する', async () => {
  const long = `${base}/other.html?q=${'very-long-query-'.repeat(30)}`;
  const page = await context.newPage();
  await page.goto(long);
  const tabId = await tabIdOf(page.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  await expect(panel.locator('.empty')).toContainText('このページの註はまだありません');
  // URL は短く（全体はツールチップ）
  const shown = (await panel.locator('#sub .url').textContent())!;
  expect([...shown].length).toBeLessThanOrEqual(80);
  expect(shown.endsWith('…')).toBe(true);
  expect(await panel.locator('#sub .url').getAttribute('title')).toBe(page.url());
  // Obsidian の公式ロゴ
  await expect(panel.locator('#b-obsidian img[src="obsidian-logo.svg"]')).toHaveCount(1);
  expect(await panel.locator('#b-obsidian img').evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  const before = new Set(await noteFiles());
  await panel.locator('.empty button.create').click();
  // そのまま編集モードに入る
  await expect(panel.locator('.cm-editor')).toBeVisible();
  await expect(panel.locator('#b-mode svg.lucide-book-open')).toHaveCount(1);
  const created = (await noteFiles()).filter(f => !before.has(f));
  expect(created).toEqual(['Another page.md']);
  const text = await readFile(join(vault, 'obsidiannot', 'Another page.md'), 'utf8');
  const parsed = parseNote(text);
  expect(parsed.titles).toEqual(['Another page']);
  expect(parsed.uris).toContain(page.url().replace(/#.*$/, ''));
  expect(text).not.toContain('created');
  // ページ側もこのノートを使う（ここで照をつけると同じノートに入る）
  await panel.locator('.cm-content').click();
  await panel.keyboard.press('Control+End');
  await panel.keyboard.type('\nメモ');
  await expect(panel.locator('.save-state')).toHaveText('保存済み', { timeout: 5000 });

  // 削除（確認ダイアログを受け入れる）
  panel.once('dialog', d => void d.accept());
  await panel.locator('#b-delete').click();
  await expect(panel.locator('.empty')).toContainText('このページの註はまだありません');
  expect(await noteFiles()).not.toContain('Another page.md');
  const { readdir } = await import('node:fs/promises');
  expect((await readdir(join(vault, '.trash'))).some(f => f.endsWith('Another page.md'))).toBe(true);
  await page.close();
  await panel.close();
});
