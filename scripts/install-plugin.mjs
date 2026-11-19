#!/usr/bin/env node
/**
 * ビルド済みの Obsidian プラグインを vault にコピーする。
 *
 *   npm run build
 *   npm run install-plugin -- /path/to/vault
 *
 * コピー先: <vault>/.obsidian/plugins/obsidiannot/
 * （既存の data.json＝設定とトークンは残る。旧 a08-annotations の設定があればトークンとポートを引き継ぐ）
 */
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const vault = process.argv[2];
if (!vault) {
  console.error('使い方: npm run install-plugin -- /path/to/vault');
  process.exit(1);
}
const root = resolve(vault);
try {
  await stat(join(root, '.obsidian'));
} catch {
  console.error(`${root} に .obsidian がありません。Obsidian の vault のパスを指定してください。`);
  process.exit(1);
}
const src = new URL('../packages/obsidian-plugin/dist/', import.meta.url).pathname;
const plugins = join(root, '.obsidian', 'plugins');
const dest = join(plugins, 'obsidiannot');
await mkdir(dest, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  await cp(join(src, f), join(dest, f));
}
console.log(`コピーしました: ${dest}`);

const readJson = async p => JSON.parse(await readFile(p, 'utf8').catch(() => 'null'));
const old = await readJson(join(plugins, 'a08-annotations', 'data.json'));
if (old && !(await readJson(join(dest, 'data.json')))) {
  await writeFile(join(dest, 'data.json'), JSON.stringify({ token: old.token, port: old.port }, null, 2));
  console.log('旧 a08 Annotations の接続トークンとポートを引き継ぎました（拡張側の再設定は不要です）。');
}
if (old) {
  console.log('旧 a08 Annotations は同じポートを使うので、Obsidian で無効にしてください。');
  console.log('既存の註ノートの移行: npm run migrate-from-a08 -- /path/to/vault');
}
console.log('Obsidian の「設定 → コミュニティプラグイン」で Obsidiannot を有効にしてください。');
