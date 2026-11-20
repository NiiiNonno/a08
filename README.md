# 黒曜伝 (Obsidiannot)

文章の気になったところに付けた**註**（引用＋コメント）を、Obsidian の vault にまとめて置いておくための道具です。

自分のノートにも、vault に入れた PDF にも、ブラウザで読んでいる Web ページにも、同じ形で註を付けられます。註はすべて普通の markdown のノートになるので、Obsidian の検索・リンク・タグがそのまま使えます。

- **ひとところに集まる**: どこに付けた註も vault の `obsidiannot/` フォルダに、対象ごとに 1 つのノートとして入ります
- **リンクできる**: 註はブロックへのリンク（`[[ノート#^id]]`）で、ほかのノートから参照・埋め込みできます
- **元の文書を書き換えない**: 註は別のノートに置き、ハイライトは上に重ねて描くだけです
- **手元だけで完結**: データは vault の中だけにあり、外部のサービスは使いません

## できること

| 註を付ける対象 | 使うもの |
|---|---|
| vault 内のノート（markdown） | Obsidian だけ |
| vault 内の PDF（文字の入ったもの） | Obsidian だけ |
| Web ページ | Obsidian ＋ Chrome 拡張（Chrome を使っている人向けの追加機能） |

### 註と照

- **註**（吹き出しのアイコン）: 選んだ範囲にコメントを付けます
- **照**（星のアイコン）: 選んだ範囲をハイライトし、その註へのリンク `[[ノート#^id]]` をクリップボードにコピーします。書いているノートに貼れば、引用元をすぐ参照できます

既にあるハイライトをクリックしても、同じリンクがコピーされます（設定で切れます）。

### タグで色分け

コメントに `#重要`・`#定義`・`#疑問`・`#引用` などと書くと、ハイライトの色や下線が変わります。タグと見た目の対応は、プラグインの設定で自由に変えられます。

## インストール

今のところ、ソースからビルドして入れます（Node.js 22.6 以降が必要です）。

```bash
git clone https://github.com/NiiiNonno/a08.git
```

```bash
cd a08 && npm install && npm run build
```

### Obsidian プラグイン

```bash
npm run install-plugin -- /path/to/your/vault
```

Obsidian の「設定 → コミュニティプラグイン」で **Obsidiannot** を有効にします。デスクトップ版の Obsidian で動きます。

### Chrome 拡張（Web ページにも註を付けたい場合）

1. `chrome://extensions` を開き、右上の「デベロッパー モード」をオンにする
2. 「パッケージ化されていない拡張機能を読み込む」で `packages/extension/dist` を選ぶ
3. Obsidian のプラグインの設定画面で「接続トークン」をコピーし、開いた拡張の設定画面に貼って「保存して接続」
4. ローカルの HTML（`file://`）にも使う場合は、拡張の詳細で「ファイルの URL へのアクセスを許可する」をオン

拡張は、同じパソコンで動いている Obsidian とだけ通信します（`127.0.0.1:27183`、トークンで認証）。Obsidian が起動していないと保存できません。

## 使い方

### Obsidian で（ノート・PDF）

1. ノートまたは PDF の文字を選ぶと、註・照のボタンが出ます（右クリックメニューやコマンドでも可）
2. 註を付けると、右のサイドバーにその文書の註ノートが開き、コメントを書けます
3. サイドバーは開いている文書に合わせて切り替わります。リボンの吹き出しアイコンでも開けます
4. ハイライトを押すとサイドバーの該当カードへ、カードを押すと本文の該当箇所へ移ります

本文を書き換えても、註の位置は追従します。見失った註はサイドバーの上に件数が出るので、正しい範囲を選んでカードの「選択範囲に再配置」で付け直せます。

PDF の註のカードにあるリンクのアイコンで、PDF の該当箇所へのリンク（`[[論文.pdf#page=3&selection=…]]`）もコピーできます。

### Chrome で（Web ページ）

1. ページの文字を選ぶと、註・照のボタンが出ます（右クリックメニュー、`Alt+Shift+A` でも可）
2. ツールバーの拡張のアイコンでサイドパネルを開くと、そのページの註ノートが Obsidian と同じ見た目で表示され、その場で編集もできます
3. Obsidian で註のカードを押すと、ブラウザでそのページの該当箇所が開きます

同じ記事を別の URL（ミラー、DOI など）で開いても、同じ註ノートに対応します。対訳型の翻訳拡張で挿入された訳文は無視し、原文にだけ註を付けます。

## ノートの形

註は ```` ```obsidiannot ```` のブロック（引用と位置の記録）と、そのすぐ後のコメントでできています。

````markdown
---
titles:
  - ページのタイトル
uris:
  - https://example.com/page
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
```
^k3x9qa

ここがコメント。 #重要
````

- 位置の記録は Web 註釈の標準（W3C Web Annotation の selector）に沿っています
- vault 内のノート・PDF への註ノートは「対象の名前 - local」という名前になり、`uris:` に `"[[対象]]"` と書かれます
- コメントは普通に編集してかまいません。ブロックの中は自動で書かれるので、触らないでください

## 今の制限

- Chrome 拡張はストアに出しておらず、デベロッパー モードで読み込みます
- Chrome の内蔵 PDF ビューアで開いた PDF には付けられません（vault に入れて Obsidian で開いてください）
- スキャンした画像だけの PDF には付けられません
- 画面の文言は日本語だけです

開発やテストについては [docs/development.md](docs/development.md)、設計は [docs/design.md](docs/design.md) を参照してください。

## ライセンス表記

位置の特定の一部は [Hypothesis client](https://github.com/hypothesis/client)（BSD-2-Clause）から移植し、アイコンは [Lucide](https://lucide.dev/)（ISC）を使っています。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
