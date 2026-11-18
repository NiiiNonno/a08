# 設計メモ

## 目的と方針

- 註のデータは vault のローカル markdown に置く（Hypothesis のサーバーは使わない）。検索・リンク・バックリンクは Obsidian の機能をそのまま使う
- ブラウザ側は Chrome 拡張。閲覧中ページに対応するノートをサイドパネル（Side Panel API）に出し、表示も編集もできる
- 位置特定の仕組みは Hypothesis を踏襲する（実績があり、Hypothesis から書き出したデータとも互換にしやすい）

## 全体の構成

```
Chrome 拡張 (MV3)
  content script ── 選択→selector 生成、アンカリング、CSS Highlight、クリック判定、余白マーカー
  side panel     ── Obsidian が描画した HTML の表示 / CodeMirror 6 での編集（自動保存）
  background     ── WebSocket 接続を 1 本持ち、要求とイベントを中継。reveal 時のタブ探し
        │  ws://127.0.0.1:27183/?token=…（Origin は chrome-extension:// のみ許可）
Obsidian プラグイン
  AnnotationServer（packages/server）── 要求の処理、変更の配信
  NoteService ── URI 索引、ノートの作成・追記・コメント更新・削除・保存（楽観的排他）
  註カード描画（```annotation のコードブロック処理）、スタイル見本（```annotation-styles）
```

通信方式に Local REST API プラグインを使わなかったのは、(1) Obsidian → ブラウザ方向の通知（reveal、外部編集の反映）が必要、(2) 自己署名証明書や API キーの扱いを避けたい、ため。

## 註の形式

- ノート 1 つ = 文書 1 つ。frontmatter の `titles` / `uris` は配列（どちらも複数可）
- 註 1 つ = ` ```annotation ` ブロック（YAML）＋直後のコメント（通常の markdown）
  - コメントを YAML の外に置くことで、wikilink・タグ・バックリンク・検索がそのまま効く
  - コメントの範囲は「次の annotation ブロック」か「見出し行」の手前まで
- selector は W3C Web Annotation / Hypothesis と同じ形（TextQuote / TextPosition / Range、PDF 用に PageSelector も型だけ用意）
- 未知のキーはブロック内に保持して書き戻す（将来の拡張用）
- YAML にバッククォート列が含まれる場合は、フェンスを長くして壊れないようにする

## URI の照合

`normalizeUri`（packages/core/src/url.ts）で正規化してから比較する。

- フラグメント・追跡用パラメータ（utm_* など）・既定ポートを除去、ホストを小文字化
- Wayback Machine はタイムスタンプを無視（同じページの別スナップショットを同一視）
- DOI は `https://doi.org/<小文字の DOI>` に揃える

ページを開くと、content script が URL・`link[rel=canonical]`・`og:url`・`citation_doi`・`citation_arxiv_id` を候補として集め、どれかに一致するノートを探す。
註を追加するとき、ノートに未登録の候補 URI とタイトルは frontmatter に追記する。

## アンカリング

`packages/core/src/anchoring/`。Hypothesis client の `match-quote.ts` と `xpath.ts` を移植し、テキストの走査部分（`text-model.ts`）は作り直した。

- 再特定の順序: RangeSelector（XPath）→ TextPositionSelector → TextQuoteSelector（近似一致）。前の 2 つは得られた文字列が引用と一致したときだけ採用
- 近似一致は `approx-string-match`。Hypothesis は最良候補を常に採用するが、短い引用で無関係な箇所に当たるのを避けるため、スコア 0.5 以上かつ編集距離が引用長の 25% 以下を条件にした
- 註をつけた文書と別の URI で開いた場合は、位置情報を使わず引用だけで探す
- `<br>` は引用用テキストでは空白 1 文字（Hypothesis と同じ）

### 対訳型の翻訳への対応

テキストを組み立てるとき、設定した CSS セレクタに一致する要素（既定は Immersive Translate の訳文ラッパー）を子孫ごと除外する。

- 訳文の表示中に選択しても、selector（位置・引用・前後文脈）は訳文なしの状態と同じになる
- 訳文が後から挿入されても、保存済みの位置情報がそのまま使える
- ハイライトはテキストノードごとの Range に分割して登録するため、範囲の途中に挿入された訳文は塗られない
- 無視する要素がなければ、文字位置は Hypothesis の TextPositionSelector と一致する

## ハイライト

CSS Custom Highlight API（`CSS.highlights` と `::highlight()`）を使い、ページの DOM には手を入れない。
UI（註ボタン、入力欄、余白マーカー、通知）は `<html>` 直下の Shadow DOM に置く（`<body>` の外なので、本文のテキストにも MutationObserver にも混ざらない）。

- タグごとにハイライト名（`a08-t0`、`a08-t1`、…）を分け、該当する全スタイルに Range を登録する。重ねがけできる（背景＋下線など）
- 優先順位は `_styles.md` の記述順（`Highlight.priority`）
- タグのない註は `a08-default`。ホバー中・フォーカス中は `a08-hover` / `a08-focus`
- 使えるプロパティは仕様上 color / background-color / text-decoration 系 / text-shadow のみ。値はサニタイズしてから CSS にする
- クリック判定は `caretPositionFromPoint` と `Range.getClientRects()` で行う（ハイライト自体はイベントを持たない）
- DOM の変化（動的な読み込みなど）は MutationObserver で監視し、壊れた註や未特定の註があれば再アンカリングする
- SPA の URL 変化は 1 秒ごとの確認で検知し、ノートを引き直す

## サイドパネル

- 表示モード: プラグインが `MarkdownRenderer.render` で描画した HTML を DOMPurify で無害化して表示。Obsidian のテーマの CSS 変数も受け取って適用する（ダークモードも Obsidian に追従）
- 編集モード: CodeMirror 6（Obsidian と同じエディタ基盤）。入力が 0.8 秒止まると保存。保存時に版（内容のハッシュ）を送り、Obsidian 側で変更されていれば競合として確認を出す
- 註の行には薄い背景を付ける。ページ側でハイライトをクリックすると、対応する位置にカーソルを移す

## 既知の制限・未実装

- **Obsidian 上での実機確認はまだ**（プラグインはビルドと型検査のみ。プロトコルとノート操作は開発用サーバーと E2E で確認済み）
- PDF への註（拡張に PDF.js ビューアを同梱し、Hypothesis の `anchoring/pdf.ts` を移植する予定。selector の型は用意済み）
- vault 内 md への註（Obsidian 内で左に該当箇所を出す機能）
- サイドパネルでの vault 内画像の表示（`app://` URL は拡張から読めない）
- Hypothesis から書き出した既存の註の取り込み
- iframe 内の本文には未対応（content script は最上位フレームのみ）
- Wayland など、OS 側がウィンドウの前面化を制限する環境では、reveal でタブは切り替わっても Chrome のウィンドウが前に出ないことがある
