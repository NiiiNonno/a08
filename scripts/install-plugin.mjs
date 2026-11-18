#!/usr/bin/env node
/**
 * ビルド済みの Obsidian プラグインを vault にコピーする。
 *
 *   npm run build
 *   npm run install-plugin -- /path/to/vault
 *
 * コピー先: <vault>/.obsidian/plugins/a08-annotations/
 * （既存の data.json＝設定とトークンは残る）
 */
import { cp, mkdir, stat } from 'node:fs/promises';
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
const dest = join(root, '.obsidian', 'plugins', 'a08-annotations');
await mkdir(dest, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  await cp(join(src, f), join(dest, f));
}
console.log(`コピーしました: ${dest}`);
console.log('Obsidian の「設定 → コミュニティプラグイン」で a08 Annotations を有効にしてください。');
