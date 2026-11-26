# 数値替えテスト作成アプリ

数学参考書（青チャート等）の問題・解答画像/PDFをGeminiで読み取り、数値を変えた類題を指定問題数だけ生成してテスト形式で表示するシンプルなWebアプリです。

## セットアップ

```powershell
cd math-variant-app
npm install
Copy-Item .env.example .env.local
# .env.local を開き、GEMINI_API_KEY を設定
npm run dev
```

http://localhost:3000 を開きます。

既存の Mock-examizerF と同時に起動する場合は、ポートを分けてください。

```powershell
npm run dev -- -p 3001
```

このPCでは Node/npm が PATH に無い場合があります。その場合は fnm の Node パスを先頭に追加してから実行してください。

## 使い方

1. 問題・解答の画像（PNG/JPEG/WebP）またはPDFをまとめてアップロード
2. 「抽出してペアリング」を押す
3. ペアリング結果を確認（解答なし・順番対応のバッジに注意）
4. 作成する問題数を指定して「類題を生成」
5. テスト形式で表示。各問題の「解答・解説を表示する」で自己採点

## 制限

- アップロードは最大12ファイル、合計18MBまで（Geminiのインライン入力制限に合わせています）
- 図形・グラフが必須の問題は、類題生成時にスキップされます
- APIキーはサーバー側でのみ使用します（ブラウザには送信しません）

## 構成

- `app/page.tsx` — アップロード、ペアリング確認、テスト表示
- `app/components/MathText.tsx` — KaTeXレンダリング
- `app/api/extract/route.ts` — Geminiで問題・解答を構造化抽出
- `app/api/generate/route.ts` — 数値替え類題の生成
- `lib/gemini.ts` — Gemini呼び出しとStructured Outputスキーマ
- `lib/pairing.ts` — 問題番号・pair_keyによるペアリング
