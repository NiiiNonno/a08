# 設計メモ — Obsidiannot（黒曜伝）

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
  註カード描画（```obsidiannot のコードブロック処理）、Obsidian の CSS 一式の提供、照のリンク生成
```

通信方式に Local REST API プラグインを使わなかったのは、(1) Obsidian → ブラウザ方向の通知（reveal、外部編集の反映）が必要、(2) 自己署名証明書や API キーの扱いを避けたい、ため。

## 註の形式

- ノート 1 つ = 文書 1 つ。frontmatter の `titles` / `uris` は配列（どちらも複数可）
- 註 1 つ = ` ```obsidiannot ` ブロック（YAML）＋（ブロック ID 行）＋直後のコメント（通常の markdown）
  - コメントを YAML の外に置くことで、wikilink・タグ・バックリンク・検索がそのまま効く
  - コメントの範囲は「次の obsidiannot ブロック」か「見出し行」の手前まで
- ノートの先頭にタイトルの見出しは書かない（タイトルは frontmatter の `titles` だけ）
- ノートの frontmatter に作成日時は書かない（ファイルの作成日時と重なるため）。註ごとの `created` は残す
- selector は W3C Web Annotation / Hypothesis と同じ形（TextQuote / TextPosition / Range、PDF 用に PageSelector も型だけ用意）
- 未知のキーはブロック内に保持して書き戻す（将来の拡張用）
- YAML にバッククォート列が含まれる場合は、フェンスを長くして壊れないようにする

## 照（ブロック ID とリンク）

註を別のノートから参照するために、註ブロックを直接コピーするのではなく、Obsidian のブロック参照を使う。

```
```obsidiannot
…
```
^k3x9qa

コメント
```

- ID は閉じフェンスの次の行に `^xxxx` だけを書き、その次は空行（Obsidian がブロック ID と認識する形）。英小文字と数字 6 文字で、ノート内で重複しないように作る
- ID は照に限らず、新しく作る註すべてに付ける。照はその ID へのリンクをコピーする。ID のない古い註は、照のときに ID を付ける（既にあればそのまま）
- カード（ブロックと ID 行）とコメントの間は常に一行空ける
- リンクはプラグインが `app.fileManager.generateMarkdownLink` で作る（ユーザーのリンク形式の設定＝wikilink / markdown・最短パスなどに従う）
- クリップボードへはまず `navigator.clipboard`、使えないページ（http など）では拡張の offscreen document で書く
- リンクのコピーはプラグインの設定で無効にできる（無効なら照はただのハイライト）。ブラウザ・vault 内のノート・PDF に共通の 1 つの設定で、拡張には `hello` の `options` と `optionsChanged` イベントで伝える

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
- 設定は Obsidian プラグインの設定画面（YAML。data.json に保存）。vault にファイルとしては置かない
- 使えるプロパティは仕様上 color / background-color / text-decoration 系 / text-shadow のみ。値はサニタイズしてから CSS にする
- クリック判定は `caretPositionFromPoint` と `Range.getClientRects()` で行う（ハイライト自体はイベントを持たない）
- 余白マーカーは画面上の位置（`position: fixed`）に、見えている註の分だけ出し、スクロールのたびに描き直す。スクロールは捕捉段階で受けるので、本文が内側の要素でスクロールするページ（Obsidian Publish など）でも追従する
- 該当箇所へのスクロールは、範囲に最も近いスクロールする要素（`overflow: auto/scroll` ではみ出しているもの）を動かす。なければウィンドウ
- DOM の変化（動的な読み込みなど）は MutationObserver で監視し、壊れた註や未特定の註があれば再アンカリングする
- SPA の URL 変化は 1 秒ごとの確認で検知し、ノートを引き直す

## サイドパネル

- サイドパネルはウィンドウに 1 つ（`sidePanel.setOptions` をタブ別には使わない）。タブ別に設定すると Chrome がタブごとに別のパネルを作り、裏に回ったパネルが止まって表示が古くなるため。拡張が入れないタブ（`chrome://`、新しいタブなど）では、パネルに控えめな一文だけを出す
- 閲覧中のタブの読み込みは、呼ぶたびに番号を振って最後のものだけを使う。読み込み途中のページは数秒待ち、ページ側の準備ができた通知でも読み直す。同じノート・同じ版なら描き直さない
- 前回の Obsidian のテーマの色を覚えておき、パネルを開いた最初の描画から使う（白く光らないように）
- 拡張内のメッセージで、接続状態の「問い合わせ」（`status`）と「変化の通知」（`statusChanged`）は別の名前にする。同じ名前だと、ページ側からの問い合わせをパネルが通知と取り違えて状態が壊れる
- 拡張の読み込み前から開いていたタブなど、content script がいないタブでは、パネルが `scripting.executeScript` で入れ直す（二重に入った場合は古いほうを片付ける）
- 表示モード: プラグインが `MarkdownRenderer.render` で描画した HTML を DOMPurify で無害化して、Shadow DOM の中に表示する
  - Obsidian の画面に読み込まれた CSS 一式（本体・テーマ・スニペット・各プラグイン）を受け取り、`body`/`html` のセレクタを Shadow DOM 内の要素に書き換えて適用する。コールアウトやテーマの見た目も Obsidian と同じになる
  - Obsidian の body の class（`theme-dark` など）も写す。CSS が変わると（`css-change`）版が変わり、パネルが取り直す
  - vault 内の画像（`app://`）は拡張から読めないので、プラグインが vault 相対パスを `data-obsidiannot-resource` に入れ、パネルが `getResource` で受け取って blob: URL にする
  - 註カードのクリックは、パネルではページ内の該当箇所へのスクロールになる（Obsidian ではブラウザで開く）
- ボタンはアイコン（Lucide。Obsidian と同じアイコン集）。編集は `pen-line`、表示に戻るのは `book-open`
- ファイル名をクリックすると改名できる（プラグインは `fileManager.renameFile` を使うので、リンクも設定どおり更新される）
- 註のないページでは、そのページの URI を持つ空のノートを作れる（作るとそのまま編集モード）。ノートの削除は `fileManager.trashFile`（ユーザーの削除設定に従う）
- 「Obsidian で開く」のボタンは Obsidian の公式ロゴ（obsidian.md から取得して同梱）
- プラグインは、サイドパネル用の描画を画面外に置いた要素で行う（画面に付いていない要素では、コールアウトのアイコンなど一部が描かれないため）。それでも空のコールアウトのアイコンは、種類ごとの `--callout-icon` から入れる
- 編集モード: CodeMirror 6（Obsidian と同じエディタ基盤）。入力が 0.8 秒止まると保存。保存時に版（内容のハッシュ）を送り、Obsidian 側で変更されていれば競合として確認を出す
- 註の行には薄い背景を付ける。ページ側でハイライトをクリックすると、対応する位置にカーソルを移す

## vault 内のノートへの註

Web と違って、対象が常に編集される。SideComments（同様のプラグイン）を参考にしたが、位置の計算方法は取らなかった（書式をまたぐ選択の見落としと、全文書へのあいまい検索による固まりがあったため）。

- **保存**: 註ノートは註フォルダに置き、`uris:` に `"[[対象]]"`（プロパティ内のリンクは改名時に Obsidian が書き換える）。selector は元のマークダウンでの `TextQuoteSelector`（前後 32 文字）と `TextPositionSelector`
- **編集中の追跡**（`local/editor.ts`）: 註の範囲を CodeMirror の StateField で持ち、変更のたびに `mapPos` で差分だけずらす（範囲の端への入力は含めない）。範囲か前後 32 文字に触れた編集があった註にだけ dirty を付け、打鍵が 1.5 秒止まったら dirty のものだけ確かめる
- **位置探し**（`core/anchor.ts`）: 軽い順に、手がかりの位置 → 同じ引用文で文脈が最も合う箇所 → 前後の文脈の両方が同じ段落にあればその間（`changed`。新しい引用文にし、元の文を `original:` に一度だけ残す）→ 片方の文脈から元の文字数分（`tentative`）→ 近い文字列（`tentative`。Sellers のアルゴリズムで、手がかりの周辺だけ・計算量に上限）→ `orphan`。エディタで追跡していた範囲が残っていれば、文字も前後も大きく変わっても `tentative` でそこに出す。`orphan` の註は打鍵が止まるたびに探し直し、引用文と文脈で確かに見つかれば（`ok`・`changed`）戻す（誤って消した文を戻したとき用。似ているだけの位置には戻さない）
- **再配置・確定**: 表示はすぐに直し、註ノートへの書き込みを待たない（記録が前と同じだと註ノートが変わらず、読み込み直しが起きないため）
- **書き戻し**: `ok`・`changed` で引用文か文脈が変わった註だけ、3 秒後に註ノートへ書き戻す（位置だけずれたものは、ほかの変更と一緒のときだけ）。推定・見つからないものは書かない。註ノートを編集中なら後にする
- **閲覧表示**（`core/align.ts`）: 描画のかたまりごとに `getSectionInfo` で元の行範囲を得て、元のマークダウンと描かれた文字を Myers の差分で文字単位に対応させる（書式をまたぐ選択にも対応）。ハイライトは CSS Custom Highlight API（DOM を書き換えない）。選択範囲も同じ対応表で元の位置に直す
- **サイドバー**（`local/panel.ts`）: 註ノートを右のサイドバーで普通の markdown タブとして開き、開いているノートに追従する（固定して、中のリンクで別のノートに移らないようにする）。推定・見つからない註の件数を上に出す
- **再配置**: 本文で選んだ範囲を覚えておき、カードの「選択範囲に再配置」でその範囲を記録する。推定の註は「ここで確定」で今の位置を記録する

## vault 内の PDF への註

Obsidian の PDF ビューア（PDF.js が元）に手を入れる。ノートへの註の仕組み（註ノート・サイドバー・カード・推定と再配置）をそのまま使い、対象のファイルを `.pdf` に広げた。PDF++（MIT）のやり方を参考にしたが、コードには依存しない。

- **文字列**（`core/pdf-text.ts`）: ページごとに `getTextContent({ includeMarkedContent: true, disableNormalization: true })` の項目をつなぎ（`hasEOL` の後に改行）、ページの間を空行で区切って PDF 全体の文字列にする。正規化しないのは、ビューアの文字の層と同じ文字列にするため。ファイルの更新日時ごとに取り出した結果を覚えておく
- **記録**: TextQuoteSelector・TextPositionSelector（PDF 全体の文字列で）と PageSelector（`index` は 0 から、`label` はページの表示名）。Hypothesis が PDF で記録するのと同じ組み合わせ。位置探しはノートと同じ `anchorQuote`。位置の記録がなければページの先頭を手がかりにする。PDF は書き換わらないので、編集の追跡と書き戻しはない
- **触る内部**: `view.viewer.child.pdfViewer` の `eventBus`（`pagesloaded`・`textlayerrendered`）と `pdfViewer`（`pdfDocument`・`getPageView`・`scrollPageIntoView`）、ページの文字の層の要素（`textDivs`。取れなければ文字の層の span から拾う）だけ。Obsidian の内部の関数は書き換えない
- **文字の層との対応**: 文字の層の要素の文字（行末の `<br>` は改行）をつないだ文字列を、ページの文字列と突き合わせる。同じなら素通し、違えば `align` で対応づける。文字の層の番号（`data-idx`）の数え方が版で変わっても影響を受けない
- **描画**: ページの上に層を置き、ハイライトの範囲の矩形（同じ行はまとめる）を、層に対する割合で置く（PDF++ と同じ方式。拡大縮小に追従し、ページが描き直されたら `textlayerrendered` で描き直す）。色はハイライトのスタイル設定のクラス、乗算（ダークテーマでは screen）で重ねる。層は文字の層より下で、選択の邪魔をしない。クリックは座標で判定する
- **PDF へのリンク**: `#page=N&selection=開始の番号,位置,終わりの番号,位置`（Obsidian 標準）。番号は文字の層の `data-idx`（Obsidian 1.8.0 だけ 1 から数える。PDF++ と同じ扱い）。ページの文字の層が描かれていないときや番号がないときは `#page=N` だけ
- **テスト**: 文字列の作り方と位置探しは、作った PDF を pdfjs-dist で読む単体テスト。描画・選択・クリック・リンクは、PDF.js の標準のビューアの上で `local/pdf.ts` を動かす E2E（`e2e/pdf.spec.ts`）。Obsidian に組み込んだ形は実機で確かめる

## 既知の制限・未実装

- サイドパネルの見た目は Obsidian の CSS をそのまま使うが、完全には同じにならないものがある
  - フォント（@font-face は Shadow DOM 内で効かず、app:// の URL も読めない）。Obsidian 既定の Inter などは OS にあるフォントで代わる
  - JavaScript で動く描画（Dataview のクエリ、Excalidraw など）や、描画後に時間をかけて変わるもの
  - 画像以外の埋め込み（PDF・音声・動画）
- 拡張の UI の文言は日本語のみ（拡張の名前・説明だけ Chrome の表示言語に従う）。ボタンはアイコンにして、言語に依存しにくくしている
- Chrome で開いた PDF への註（vault 内の PDF は Obsidian の PDF ビューアで対応済み）
- PDF の右クリックメニューへの項目（Obsidian の内部の関数を書き換える必要があるため見送り。選択時のボタンとコマンドで代わりにする）
- スキャンした PDF（文字の層がない）への註
- vault 内のノートへの註は、ポップアウトしたウィンドウでは閲覧表示のハイライトが出ない（ハイライトの登録がメインのウィンドウのみ）
- Hypothesis から書き出した既存の註の取り込み
- iframe 内の本文には未対応（content script は最上位フレームのみ）
- Wayland など、OS 側がウィンドウの前面化を制限する環境では、reveal でタブは切り替わっても Chrome のウィンドウが前に出ないことがある
