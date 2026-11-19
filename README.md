# Obsidiannot（黒曜伝）— Obsidian と Chrome をつなぐローカル註システム

Web ページの一部を選んで註（引用＋コメント）をつけると、Obsidian の vault の `obsidiannot/` に markdown として保存されます。
Chrome のサイドパネルには、閲覧中のページに対応するノートが Obsidian と同じ見た目で表示され、その場で編集もできます。

- データは vault のローカル markdown だけ。検索は Obsidian でそのまま使えます
- 註の位置特定は Hypothesis と同じ方式（XPath → 文字位置 → 引用＋前後文脈の近似一致）
- ハイライトは CSS Custom Highlight API。**ページの DOM を書き換えない**ので翻訳拡張などと干渉しにくい
- 対訳型の翻訳で挿入された訳文は無視し、原文にだけ註をつける（無視する要素は設定で指定）
- コメントの `#タグ` ごとにハイライトの見た目を変えられる（`#重要`、`#定義` など。重ねがけ可）
- **照**（しょう）: 註ブロックにブロック ID を付け、`[[ノート#^id]]` のリンクをクリップボードにコピー。ほかのノートから註を参照できる
- Obsidian の註カードをクリックすると、既存のタブを前面に出して該当箇所へスクロール（なければ新しく開く）

設計の詳細は [docs/design.md](docs/design.md) を参照してください。

## 構成

| パッケージ | 内容 |
|---|---|
| `packages/core` | 註の形式（読み書き）、URL 正規化、タグ、スタイル、プロトコル型、アンカリング |
| `packages/server` | ノート操作（NoteService）と WebSocket サーバー。Obsidian プラグインと開発用サーバーで共用 |
| `packages/obsidian-plugin` | Obsidian プラグイン（サーバーの起動、註カードの描画、Obsidian での描画と CSS を拡張へ提供） |
| `packages/extension` | Chrome 拡張（MV3: background / content script / サイドパネル / 設定画面） |
| `e2e/` | 拡張を読み込んだ Chromium と開発用サーバーでの通しテスト（Playwright） |

## セットアップ

Node.js が入っていない環境では、`.tools/` に置いた Node を使います。

```bash
. .tools/env.sh
```

```bash
npm install
```

```bash
npm run build
```

### 1. Obsidian プラグイン

```bash
npm run install-plugin -- /path/to/your/vault
```

Obsidian の「設定 → コミュニティプラグイン」で **Obsidiannot** を有効にします。
有効にすると `127.0.0.1:27183` で待ち受けます。
プラグイン設定画面の「接続トークン」をコピーしておきます（コマンド「拡張用の接続トークンをコピー」でも可）。

#### 旧版（a08）から移る場合

旧版の `annotations/` のノートを移すスクリプトがあります。Obsidian を終了してから実行してください。
まず何をするかを表示し、問題なければ `--apply` を付けて実行します。

```bash
npm run migrate-from-a08 -- /path/to/your/vault
```

```bash
npm run migrate-from-a08 -- /path/to/your/vault --apply
```

`annotations/` → `obsidiannot/` の改名、` ```annotation ` → ` ```obsidiannot `、旧版が書いた見出し（`# タイトル`）の削除、`_styles.md` のハイライト設定のプラグイン設定への移動、トークンとポートの引き継ぎ、有効なプラグインの切り替えを行います。

### 2. Chrome 拡張

1. `chrome://extensions` を開き、右上の「デベロッパー モード」をオンにする
2. 「パッケージ化されていない拡張機能を読み込む」で `packages/extension/dist` を選ぶ（旧版を読み込んでいた場合はそれを「再読み込み」）
3. 開いた設定画面にトークンを貼り付けて「保存して接続」
4. ローカルの HTML（`file://`）にも使う場合は、拡張の詳細で「ファイルの URL へのアクセスを許可する」をオン

拡張の名前は Chrome の表示言語に従います（日本語なら「黒曜伝」、それ以外は「Obsidiannot」）。

## 使い方

- **註**（吹き出しのアイコン `message-square-quote`）: 本文を選択 → 出てくるボタンでコメントを書いて Ctrl+Enter。右クリックメニューや `Alt+Shift+A` でも可
- **照**（星のアイコン `star`）: 本文を選択 → 押すとハイライトされ、ブロック ID 付きで保存されて `[[ノート#^id]]` がクリップボードに入る。ほかのノートに貼れば註を参照・埋め込み（`![[…]]`）できる
- **既存のハイライトをクリック**: サイドパネルの該当カードへ移動し、照と同じくリンクをコピー（ID がなければ付ける）
  - リンクのコピーは拡張の設定で無効にできます（無効にすると照はただのハイライト）
- **サイドパネル**: ツールバーの拡張アイコンで開く。カードをクリックするとページの該当箇所へスクロール。拡張が入れないページ（`chrome://` や新しいタブ）では、その旨が小さく出ます
- **編集**: サイドパネルの ペンのアイコン（Ctrl+E）で markdown を直接編集。入力が止まると自動保存。本のアイコン で表示に戻る
- **ファイル名の変更**: サイドパネルのファイル名をクリック。Obsidian の機能で改名するので、そのノートへのリンクも更新されます
- **Obsidian から戻る**: 註カードをクリック（またはコマンド「カーソル位置の註をブラウザで開く」）。Live Preview でブロックの中身を直接編集するときは、カード右上の `</>` から
- **タグで見た目を変える**: コメントに `#重要` などを書く。対応はプラグインの設定画面（ハイライトのスタイル）で変更でき、すぐページに反映
- **引用の前後の文脈**: 註カードに出すかはプラグインの設定で選べます（既定は出さない）

## ノートの形

````markdown
---
titles:
  - ページのタイトル
uris:
  - https://example.com/page
  - https://doi.org/10.1234/abc
created: 2026-11-18T22:28:12+09:00
---

```obsidiannot
id: NXzGywg-FOGOdCVC
created: 2026-11-18T22:28:12+09:00
source: https://example.com/page
selector:
  - type: TextQuoteSelector
    exact: specific passages
    prefix: "on lets readers attach notes to "
    suffix: " of a document without modifying"
  - type: TextPositionSelector
    start: 85
    end: 102
  - type: RangeSelector
    startContainer: /article[1]/p[1]/em[1]
    startOffset: 0
    endContainer: /article[1]/p[1]/em[1]
    endOffset: 17
```
^k3x9qa

ここがコメント。 #重要
````

- `titles` と `uris` は複数指定できます。別の URL（ミラー、Wayback Machine、DOI など）で開いても同じノートに対応します
- ブロック直後の `^k3x9qa` は照で付くブロック ID（Obsidian の仕様上、この位置に置き、次に空行を入れます）。なくてもかまいません
- コメントは、ブロック（と ID 行）の直後から「次の obsidiannot ブロック」か「見出し行」の手前までです

## 開発

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

Obsidian なしで拡張を試すときは、開発用サーバーを使います（Obsidian プラグインと同じプロトコル。描画は簡易版）。拡張の設定でトークン `devtoken` を指定してください。

```bash
npm run dev-server -- --vault test-vault --token devtoken
```

## ライセンス表記

アンカリングの一部は [Hypothesis client](https://github.com/hypothesis/client)（BSD-2-Clause）から移植し、アイコンは [Lucide](https://lucide.dev/)（ISC）を使っています。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
