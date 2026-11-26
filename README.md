# Mock examizerF

模試の「問題バンク化（参考書別） → 出題形式の指定 → 模試生成（数違い／融合／語句補充）→ 自動検算 → A4 PDF出力 → 履歴管理」をローカルPCだけで完結させる Web アプリです。

## 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| フレームワーク | Next.js 15（App Router / TypeScript） |
| スタイリング | Tailwind CSS v4 + 独自ダークテーマ（背景 `#09090b` / アクセント `#dc2626`） |
| データベース | SQLite（`better-sqlite3`、`data/mock-examizer.db` に永続化） |
| AI | OpenAI互換API（OpenAI / vLLM / LM Studio など）／Anthropic Claude（任意） |
| 数式 | KaTeX（PDF内にフォントをbase64同梱しオフライン描画） |
| PDF | Puppeteer-core + インストール済み Chrome/Edge で A4 組版 |

APIキー未設定時は **デモモード** で起動します。抽出は文字情報からの簡易解析、生成は選定した問題をそのまま指定形式に配置し、数値制約チェックのみ実行します（画面上にデモ表示）。AIキーを設定すると数違い変換・融合再構成・AI検算ループが有効になります。

## セットアップ

```powershell
cd C:\Users\arrec\Mock-examizerF
npm install --include=dev   # NODE_ENV=production が設定されている環境では --include=dev が必要
copy .env.example .env.local
npm run dev
```

http://localhost:3000 を開きます。

`NODE_ENV=production` がシェルに設定されている場合は、開発時のみ次のように上書きしてください。

```powershell
$env:NODE_ENV = "development"
npm run dev
```

本番ビルド：

```powershell
npm run build
npm run start
```

### AI設定（`.env.local`）

OpenAI互換サーバーを優先します。`OPENAI_API_KEY` が設定されていれば、`ANTHROPIC_API_KEY` より優先されます。

```dotenv
OPENAI_API_KEY=sk-...
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_TIMEOUT_MS=300000
```

- **OpenAI**: 上記のまま。`AI_MODEL` を利用するモデルに変更。
- **vLLM**: `AI_BASE_URL=http://<server>:8000/v1`、`AI_MODEL=<served-model>`。
- **LM Studio**: `AI_BASE_URL=http://localhost:1234/v1`、`AI_MODEL=<model-id>`。APIキー不要のサーバーでも `OPENAI_API_KEY=local` のように **非空** にしてください（空だとデモモードになります）。
- **モデル自動検出**: `AI_MODEL` を空にすると、起動後の最初のAI呼び出しで `/v1/models` を取得し、先頭のモデルIDを自動使用します（5分キャッシュ）。
- **Anthropicのみ使う場合**: `OPENAI_API_KEY` を空にし、`ANTHROPIC_API_KEY` とClaudeの `AI_MODEL` を設定。

画像が利用可能な場合は `image_url` で送信します。PDFは座標抽出／OCRのテキストを優先し、テキストがある場合はテキストのみを送ります。JSON出力は `response_format: {"type":"json_object"}` を送信し、非対応サーバーでは自動的に外して1回再試行します。

PDF生成には Chrome または Edge が必要です。自動検出しますが、見つからない場合は `CHROME_PATH` に実行ファイルのパスを設定してください。

`.env.local` は `.gitignore` 済みです。APIキーをコミットしないでください。

### 高精度OCR（任意）

Python と以下のいずれかが入っている場合、ローカルOCRとして自動検出して優先します。既存のPython環境との競合を避けるため、プロジェクト専用venvを推奨します。

```powershell
py -3.12 -m venv .venv-ocr
.\.venv-ocr\Scripts\python.exe -m pip install rapidocr_onnxruntime
# または
# .\.venv-ocr\Scripts\python.exe -m pip install pix2text
# .\.venv-ocr\Scripts\python.exe -m pip install paddleocr
```

`.env.local` にPython実行ファイルを指定します。

```dotenv
PYTHON_OCR_PYTHON=C:/Users/<user>/.../Mock-examizerF/.venv-ocr/Scripts/python.exe
```

未導入の場合はエラーにせず、`tesseract.js`（jpn+eng）へ自動フォールバックします。その際は Canvas でグレースケール化・コントラスト強調・最大2倍アップスケールの前処理を行います。取り込み画面のバッジで、現在利用可能なエンジンと実際に使われたエンジンを確認できます。

## 画面と使い方

1. **問題データ（参考書別）**
   - 参考書名（出典）を入力し、問題・解答のPDF／画像をアップロード。
   - **解析中でも次のPDF／画像を予約キューに追加できます**。予約は上から順に処理され、完了した問題は下書きに追記されます。
   - 抽出後、各問題に教科・難易度・分野を設定して保存（教科・分野・参考書名・難易度は必須）。
   - 問題バンクは **参考書名ごとのカード** にまとまり、件数・教科・分野バッジを表示。展開して個別の閲覧・編集・削除、参考書ごとの一括削除が可能。
   - **表紙画像**: 各参考書カードと取り込みフォームから JPG / PNG / WebP を設定・変更・削除できます。3:4の縦長サムネイルで表示され、未設定時は参考書名入りのプレースホルダーになります。模試生成画面の参考書選択にも小さな表紙サムネイルが表示されます。
   - 表紙は `public/uploads/covers/` に保存し、`reference_books` テーブルにパス・教科・更新日時を記録します。参考書ごとの一括削除時は表紙ファイルも削除します。
   - **取り込みの3段階ハイブリッド認識**:
     1. デジタルPDFは `pdfjs-dist` で文字アイテムの X / Y 座標を取得し、行・段組みを再構成して読み順を補正（座標PDF抽出）。
     2. スキャンPDF・写真は Python の pix2text / rapidocr_onnxruntime / paddleocr を優先。未導入・失敗時は前処理付き Tesseract.js にフォールバック。
     3. 抽出テキストをOpenAI互換LLMでOCR誤変換修正・LaTeX整形・問題文/選択肢/解答/解説の構造化。保存前の確認フォームで手動修正できます。
   - 取り込み画面には「座標PDF抽出 / Python高精度OCR / 前処理付きTesseract」のエンジン状態バッジと、AIクリーニング前の生テキスト確認（折りたたみ）を表示します。
   - 一度入力した教科・分野・参考書名・難易度は `input_histories` に自動保存され、次回からコンボボックスの候補として選択できます。

2. **模試生成（形式指定）**
   - **生成中でも次の形式を予約キューに追加できます**。現在の生成が終わると、予約した形式を上から順に処理します。完了した生成結果はキューから呼び出せます。
   - 教科（候補から選択／新規入力）、参照する参考書（複数可）、大問数（1〜6）、各大問の小問数と分野、難易度平均（1.0〜5.0）を指定。
   - 生成モードは「数違い」「融合」から選択。語句補充問題は文脈パラフレーズと一意性チェックの対象。
   - 選定した問題を指定形式に配置し、Step A〜D（決定論的ソルバー／ドメイン制約／融合バックトラック／ブラインド検算）を実行。矛盾があれば自動再生成。
   - 平均難易度・検算ログを表示し、「問題PDF」「解答PDF」を個別にダウンロード。

3. **出力履歴**
   生成した模試を教科タブで絞り込み、問題PDF／解答PDFを再ダウンロード。詳細では検算指摘と出題内容を確認できます。

4. **データ管理**
   問題データ（参考書含む）・分野・出力履歴・アップロードをカテゴリ単位で一括初期化。個別削除は各一覧から確認モーダル付きで実行できます。

## ディレクトリ構成

```
app/
  api/                 books / books/cover / covers / histories / problems / fields /
                       extract / extract/engines / generate / exams / status
  problems/            問題データ（参考書別・表紙設定・3段階取り込み）
  generate/            模試生成（形式指定）
  history/             出力履歴
  settings/            データ管理
  templates/           旧入力①（/generate へリダイレクト）
  components/          ヘッダー、BookCover、ComboBox、確認モーダル、PDFダウンロード
lib/
  db.ts                SQLite接続・スキーマ・クエリ・入力履歴・reference_books
  types.ts             型・教科/難易度/解答形式の定義
  template.ts          生成用テンプレートの正規化（旧傾向データ互換）
  extract.ts           3段階抽出の統合・クリーニング・AI解析
  pdf-layout.ts        pdfjs-distによる座標付きPDFテキスト抽出・段組み再構成
  ocr.ts               Python OCR・前処理付きTesseract・PDFページ画像化
  python-ocr.ts        Python / pix2text / rapidocr / paddleocr の検出と実行
  covers.ts            表紙画像の保存・削除・URL解決
  ai.ts                Anthropic / OpenAI互換 / デモの抽象化
  generate.ts          選定・数違い・融合・検算ループ
  validate.ts          数値制約チェック（負数・確率・定義域など）
  latex.ts             KaTeXレンダリング（CSS/フォント同梱）
  pdf.ts               A4組版・Puppeteer PDF生成
scripts/
  python_ocr.py        Python OCRブリッジ（JSON入出力）
public/uploads/covers/ 表紙画像の保存先（gitignore）
data/                  SQLite・アップロード・生成PDF（gitignore）
```

## DBスキーマ概要

- `problems`：教科・難易度・分野・参考書名・LaTeX本文/解答/解説
- `reference_books`：参考書名（UNIQUE）・表紙画像パス・教科・更新日時
- `input_histories`：教科・分野・参考書名・難易度・大問数・問題数などの入力履歴
- `fields`：分野マスタ（自由入力した分野を蓄積）
- `exams`：生成条件・平均難易度・モード・検算結果・PDFパス（形式指定生成では `template_id` は NULL）
- `exam_items`：確定した大問/小問（由来：original / numeric_variant / fusion_chain）
- `generation_runs`：検算ループ各試行のログとissues
- `verification_logs`：Step A〜Dの検算ログ詳細
- `exam_templates` / `exam_template_versions`：旧入力①の互換データ（UIは廃止、APIのみ残存）

`TemplateData` は生成時にサーバー側で組み立てる出題形式JSONです。

## Git / 公開について

このプロジェクトは GitHub の `iginimukskwea/Mock-examizerF` で公開しています。

```powershell
git remote add origin https://github.com/iginimukskwea/Mock-examizerF.git
git push -u origin main
```

`.env.local`、`data/`、`public/uploads/covers/`、`.venv-ocr/`、`.commandcode/` などのローカル専用データは `.gitignore` で除外しています。APIキーや生成済みPDFはコミットしないでください。
