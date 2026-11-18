# a08 — Obsidian と Chrome をつなぐローカル註システム

Web ページの一部を選んで註（引用＋コメント）をつけると、Obsidian の vault の `annotations/` に markdown として保存されます。
Chrome のサイドパネルには、閲覧中のページに対応するノートが Obsidian の描画で表示され、その場で編集もできます。

- データは vault のローカル markdown だけ。検索は Obsidian でそのまま使えます
- 註の位置特定は Hypothesis と同じ方式（XPath → 文字位置 → 引用＋前後文脈の近似一致）
- ハイライトは CSS Custom Highlight API。**ページの DOM を書き換えない**ので翻訳拡張などと干渉しにくい
- 対訳型の翻訳で挿入された訳文は無視し、原文にだけ註をつける（無視する要素は設定で指定）
- コメントの `#タグ` ごとにハイライトの見た目を変えられる（`#重要`、`#定義` など。重ねがけ可）
- Obsidian の註カードから「ブラウザで開く」と、既存のタブを前面に出して該当箇所へスクロール（なければ新しく開く）

設計の詳細は [docs/design.md](docs/design.md) を参照してください。

## 構成

| パッケージ | 内容 |
|---|---|
| `packages/core` | 註の形式（読み書き）、URL 正規化、タグ、スタイル、プロトコル型、アンカリング |
| `packages/server` | ノート操作（NoteService）と WebSocket サーバー。Obsidian プラグインと開発用サーバーで共用 |
| `packages/obsidian-plugin` | Obsidian プラグイン（サーバーの起動、註カードの描画、Obsidian での描画を拡張へ提供） |
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

Obsidian の「設定 → コミュニティプラグイン」で **a08 Annotations** を有効にします。
有効にすると `127.0.0.1:27183` で待ち受け、`annotations/_styles.md`（ハイライト設定）が作られます。
プラグイン設定画面の「接続トークン」をコピーしておきます（コマンド「拡張用の接続トークンをコピー」でも可）。

### 2. Chrome 拡張

1. `chrome://extensions` を開き、右上の「デベロッパー モード」をオンにする
2. 「パッケージ化されていない拡張機能を読み込む」で `packages/extension/dist` を選ぶ
3. 開いた設定画面にトークンを貼り付けて「保存して接続」
4. ローカルの HTML（`file://`）にも使う場合は、拡張の詳細で「ファイルの URL へのアクセスを許可する」をオン

## 使い方

- **註をつける**: 本文を選択 → 出てくる「✎ 註」でコメントを書いて Ctrl+Enter。「▍ ハイライト」はコメントなしで保存。右クリックメニューや `Alt+Shift+A` でも可
- **サイドパネル**: ツールバーの拡張アイコンで開く。ハイライトをクリックすると対応する註カードへ移動、カードをクリックするとページの該当箇所へスクロール
- **編集**: サイドパネルの「編集」（Ctrl+E）で markdown を直接編集。入力が止まると自動保存。Obsidian 側でも同時に変更された場合は確認を出します
- **Obsidian から戻る**: 註カードの「ブラウザで開く」（またはコマンド「カーソル位置の註をブラウザで開く」）
- **タグで見た目を変える**: コメントに `#重要` などを書く。対応は `annotations/_styles.md` で変更でき、保存するとすぐページに反映

## ノートの形

```markdown
---
titles:
  - ページのタイトル
uris:
  - https://example.com/page
  - https://doi.org/10.1234/abc
created: 2026-11-18T22:28:12+09:00
---

# ページのタイトル

```annotation
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
ここがコメント。 #重要
```

- `titles` と `uris` は複数指定できます。別の URL（ミラー、Wayback Machine、DOI など）で開いても同じノートに対応します
- コメントは、ブロックの直後から「次の annotation ブロック」か「見出し行」の手前までです

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

Obsidian なしで拡張を試すときは、開発用サーバーを使います（Obsidian プラグインと同じプロトコル）。拡張の設定でトークン `devtoken` を指定してください。

```bash
npm run dev-server -- --vault test-vault --token devtoken
```

## ライセンス表記

アンカリングの一部は [Hypothesis client](https://github.com/hypothesis/client)（BSD-2-Clause）から移植しています。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
