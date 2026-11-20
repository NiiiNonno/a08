# 開発者向けの詳細

使い方は [README](../README.md)、設計は [design.md](design.md) を参照してください。

## 構成

| パッケージ | 内容 |
|---|---|
| `packages/core` | 註の形式（読み書き）、URL 正規化、タグ、スタイル、プロトコル型、アンカリング、PDF の文字列 |
| `packages/server` | ノート操作（NoteService）と WebSocket サーバー。Obsidian プラグインと開発用サーバーで共用 |
| `packages/obsidian-plugin` | Obsidian プラグイン（註カードの描画、vault 内のノート・PDF への註、拡張のためのサーバー） |
| `packages/extension` | Chrome 拡張（MV3: background / content script / サイドパネル / 設定画面） |
| `e2e/` | 拡張を読み込んだ Chromium、PDF.js のビューアでの通しテスト（Playwright） |

## 準備

Node.js 22.6 以降が要ります。手元に Node がないときは、`.tools/` に置いた Node を使えます（リポジトリには入っていません）。

```bash
. .tools/env.sh
```

```bash
npm install
```

```bash
npm run build
```

## テスト

```bash
npm test
```

```bash
npm run e2e
```

```bash
npm run typecheck
```

実際の Obsidian の CSS でサイドパネルを確かめるテストは、Obsidian の asar の場所を渡したときだけ動きます（CSS はリポジトリに入れません）。

```bash
OBSIDIAN_ASAR=~/.config/obsidian/obsidian-1.15.1.asar npx playwright test obsidian-css
```

## 開発用サーバー

Obsidian なしで拡張を試すときは、開発用サーバーを使います（Obsidian プラグインと同じプロトコル。描画は簡易版）。拡張の設定でトークン `devtoken` を指定してください。

```bash
npm run dev-server -- --vault test-vault --token devtoken
```

## 旧版（a08）から移る

旧版の `annotations/` のノートを移すスクリプトがあります。Obsidian を終了してから実行してください。
まず何をするかを表示し、問題なければ `--apply` を付けて実行します。

```bash
npm run migrate-from-a08 -- /path/to/your/vault
```

```bash
npm run migrate-from-a08 -- /path/to/your/vault --apply
```

次のことを行います。

- `annotations/` を `obsidiannot/` に改名する
- ` ```annotation ` を ` ```obsidiannot ` に書き換える
- 旧版が書いた見出し（`# タイトル`）を消す
- `_styles.md` のハイライト設定を、プラグインの設定に移す
- トークンとポートを引き継ぐ
- 有効なプラグインを新しいものに切り替える
