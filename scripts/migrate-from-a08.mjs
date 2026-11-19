#!/usr/bin/env node
/**
 * 旧 a08（annotations/、```annotation、_styles.md）の註ノートを Obsidiannot の形に移す。
 * Obsidian を終了してから実行してください（設定ファイルを書き換えるため）。
 *
 *   npm run migrate-from-a08 -- /path/to/vault           # 何をするかを表示するだけ
 *   npm run migrate-from-a08 -- /path/to/vault --apply   # 実行する
 *
 * 1. annotations/ を obsidiannot/ に改名（obsidiannot/ が既にあれば中断）
 * 2. ノート中の ```annotation を ```obsidiannot に変える
 * 3. 旧版が frontmatter の直後に書いた「# タイトル」の行を消す（titles の先頭と同じときだけ）
 * 4. _styles.md のハイライト設定をプラグインの設定に移し、_styles.md を消す
 * 5. 有効なプラグインを a08-annotations から obsidiannot に切り替え、トークンとポートを引き継ぐ
 */
import { readFile, readdir, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const vaultArg = args.find(a => !a.startsWith('--'));
if (!vaultArg) {
  console.error('使い方: npm run migrate-from-a08 -- /path/to/vault [--apply]');
  process.exit(1);
}
const root = resolve(vaultArg);
const exists = p => stat(p).then(() => true, () => false);
const readJson = async p => JSON.parse(await readFile(p, 'utf8').catch(() => 'null'));
const say = msg => console.log(`${apply ? '' : '[予定] '}${msg}`);

const oldDir = join(root, 'annotations');
const newDir = join(root, 'obsidiannot');
if (!(await exists(oldDir))) {
  console.error(`${oldDir} がありません。`);
  process.exit(1);
}
if (await exists(newDir)) {
  console.error(`${newDir} が既にあります。中身を確認して、手で統合してください。`);
  process.exit(1);
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// 4. スタイル設定
let stylesYaml = null;
const stylesPath = join(oldDir, '_styles.md');
if (await exists(stylesPath)) {
  const md = await readFile(stylesPath, 'utf8');
  const m = md.match(/^ {0,3}(`{3,}|~{3,})\s*annotation-styles\s*\n([\s\S]*?)\n {0,3}\1\s*$/m);
  if (m) {
    stylesYaml = `${m[2]}\n`;
    say('_styles.md のハイライト設定をプラグインの設定に移します');
  }
  say('_styles.md を消します');
  if (apply) await rm(stylesPath);
}

// 2, 3. ノートの書き換え
let changed = 0;
for (const file of await walk(oldDir)) {
  if (file === stylesPath) continue;
  const text = await readFile(file, 'utf8');
  let out = text.replace(/^( {0,3}(?:`{3,}|~{3,}))annotation[ \t]*$/gm, '$1obsidiannot');
  const fm = out.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    let title = null;
    try {
      const data = parseYaml(fm[1]);
      title = Array.isArray(data?.titles) ? data.titles[0] : data?.titles;
    } catch {
      /* ignore */
    }
    if (title) {
      const head = `---\n${fm[1]}\n---\n`;
      const rest = out.slice(head.length);
      const h1 = `\n# ${title}\n`;
      if (rest.startsWith(h1)) out = head + rest.slice(h1.length);
      else if (rest.startsWith(`# ${title}\n`)) out = head + rest.slice(`# ${title}\n`.length);
    }
  }
  if (out !== text) {
    changed++;
    if (apply) await writeFile(file, out);
  }
}
say(`ノート ${changed} 件の註ブロック名・見出しを書き換えます`);

// 1. フォルダの改名
say(`annotations/ を obsidiannot/ に改名します`);
if (apply) await rename(oldDir, newDir);

// 5. プラグインの設定
const obs = join(root, '.obsidian');
const plugins = join(obs, 'plugins');
const oldData = await readJson(join(plugins, 'a08-annotations', 'data.json'));
const newDataPath = join(plugins, 'obsidiannot', 'data.json');
const newData = (await readJson(newDataPath)) ?? {};
const merged = { ...newData };
if (oldData?.token && !newData.token) merged.token = oldData.token;
if (oldData?.port && !newData.port) merged.port = oldData.port;
if (oldData?.folder && oldData.folder !== 'annotations') {
  console.log(`注意: 旧版のフォルダ設定は ${oldData.folder} でした。このスクリプトは annotations/ だけを移します。`);
}
if (stylesYaml) merged.stylesYaml = stylesYaml;
if (JSON.stringify(merged) !== JSON.stringify(newData)) {
  say('Obsidiannot プラグインの設定（トークン・ポート・ハイライト設定）を書きます');
  if (apply) {
    await mkdir(join(plugins, 'obsidiannot'), { recursive: true });
    await writeFile(newDataPath, JSON.stringify(merged, null, 2));
  }
}
const cpPath = join(obs, 'community-plugins.json');
const enabled = await readJson(cpPath);
if (Array.isArray(enabled) && enabled.includes('a08-annotations')) {
  const next = [...new Set(enabled.map(id => (id === 'a08-annotations' ? 'obsidiannot' : id)))];
  say('有効なプラグインを a08-annotations から obsidiannot に切り替えます');
  if (apply) await writeFile(cpPath, JSON.stringify(next, null, 2));
}

if (!apply) console.log('\n問題なければ --apply を付けて実行してください（Obsidian は終了しておく）。');
else console.log('\n完了しました。.obsidian/plugins/a08-annotations/ は不要なので消してかまいません。');
