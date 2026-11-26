import { GoogleGenAI, Type } from "@google/genai";
import type {
  ExtractedItem,
  GeneratedProblem,
  Pair,
  Skipped,
} from "./types";

const DEFAULT_MODEL = "gemini-2.5-flash";

export interface UploadFile {
  name: string;
  mimeType: string;
  data: Buffer;
}

const EXTRACT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING, enum: ["problem", "answer"] },
          pair_key: { type: Type.STRING },
          number: { type: Type.STRING },
          title: { type: Type.STRING },
          body_latex: { type: Type.STRING },
          figure_only: { type: Type.BOOLEAN },
          source_file: { type: Type.STRING },
        },
        required: [
          "kind",
          "pair_key",
          "number",
          "title",
          "body_latex",
          "figure_only",
          "source_file",
        ],
      },
    },
  },
  required: ["items"],
};

const GENERATE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    problems: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          source_number: { type: Type.STRING },
          body_latex: { type: Type.STRING },
          answer_latex: { type: Type.STRING },
          explanation_latex: { type: Type.STRING },
        },
        required: [
          "title",
          "source_number",
          "body_latex",
          "answer_latex",
          "explanation_latex",
        ],
      },
    },
    skipped: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          source_number: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ["source_number", "reason"],
      },
    },
  },
  required: ["problems", "skipped"],
};

function modelName(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseJson<T>(raw: string): T {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const candidates: string[] = [trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }
  throw new Error("Geminiの応答をJSONとして解析できませんでした。");
}

function sanitizeItems(raw: unknown): ExtractedItem[] {
  const source = raw as { items?: unknown } | null;
  const list = Array.isArray(source?.items) ? source.items : [];
  const items: ExtractedItem[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const kind =
      row.kind === "answer"
        ? "answer"
        : row.kind === "problem"
          ? "problem"
          : null;
    const body = cleanText(row.body_latex);
    if (!kind || !body) continue;

    const number = cleanText(row.number);
    const title = cleanText(row.title);
    const pairKey = cleanText(row.pair_key) || number || title;

    items.push({
      kind,
      pair_key: pairKey,
      number,
      title,
      body_latex: body,
      figure_only: Boolean(row.figure_only),
      source_file: cleanText(row.source_file),
    });
    if (items.length >= 200) break;
  }

  return items;
}

function sanitizeGenerated(raw: unknown): GeneratedProblem[] {
  const source = raw as { problems?: unknown } | null;
  const list = Array.isArray(source?.problems) ? source.problems : [];
  const problems: GeneratedProblem[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const body = cleanText(row.body_latex);
    const answer = cleanText(row.answer_latex);
    if (!body || !answer) continue;
    problems.push({
      title: cleanText(row.title),
      source_number: cleanText(row.source_number),
      body_latex: body,
      answer_latex: answer,
      explanation_latex: cleanText(row.explanation_latex),
    });
  }

  return problems;
}

function sanitizeSkipped(raw: unknown): Skipped[] {
  const source = raw as { skipped?: unknown } | null;
  const list = Array.isArray(source?.skipped) ? source.skipped : [];
  const skipped: Skipped[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const reason = cleanText(row.reason);
    if (!reason) continue;
    skipped.push({
      source_number: cleanText(row.source_number),
      reason,
    });
  }

  return skipped;
}

const EXTRACT_PROMPT = `あなたは数学参考書（青チャート等）の問題・解答ページを構造化する専門家です。
アップロードされた全ファイル（画像/PDF）を読み、問題と解答を1問ずつ抽出してください。

出力ルール:
- kind: 問題なら "problem"、解答・解説なら "answer"。
- pair_key: 同じ問題と解答に同じキーを付ける。問題番号を正規化したもの（例: 基本例題15 → "15"、例題3 → "3"、問2 → "2"）。
- number: 参考書の問題番号・見出し（例: 基本例題15）。
- title: 短い見出し（例: 2次関数の最大値）。不明なら空文字。
- body_latex: 問題文または解答本文。数式は必ずLaTeX（インライン $...$、別行 $$...$$）で記述する。
- figure_only: 図形・グラフが必須で、数式だけでは解けない問題なら true。それ以外は false。
- source_file: 元のファイル名。
- 同じページに問題と解答が両方ある場合は、それぞれ別要素として出力する。
- 問題と解答が別ファイルでも pair_key で対応付ける。
- 解答が見当たらない問題も問題として出力する（解答要素は作らない）。
- 抽出した順序はファイル順・ページ順を保つ。`;

function generatePrompt(sourceText: string, count: number): string {
  return `以下の参考書の問題と解答を参考に、数値を変えた類題を最大${count}問作成してください。

重要条件:
- 元の解答の論理構造・解法手順を保つ。
- 単純なランダム数値ではなく、最終的な答えが綺麗な整数、または分母が2〜5程度の簡単な分数になるよう、係数・定数を逆算して設定する。
- 図形・グラフが必須で数式だけでは解けない問題はスキップし、数式のみで完結する問題を優先する。
- 各問題に問題文(body_latex)、解答(answer_latex)、解説(explanation_latex: 途中式・方針)を付ける。
- source_number には元の問題番号を入れる。
- 数式は必ずLaTeX（インライン $...$、別行 $$...$$）で記述する。
- 問題数は最大${count}問。作成できない場合は skipped に理由を書く。
- 同じ問題の単純な焼き直しばかりにせず、係数や設定を少し変えて類題にする。

参考データ:
${sourceText}`;
}

export async function extractItems(
  files: UploadFile[],
  apiKey: string
): Promise<ExtractedItem[]> {
  if (files.length === 0) throw new Error("ファイルがありません。");

  const ai = new GoogleGenAI({ apiKey });
  const parts: Array<Record<string, unknown>> = [{ text: EXTRACT_PROMPT }];
  for (const file of files) {
    parts.push({ text: `--- file: ${file.name} ---` });
    parts.push({
      inlineData: {
        mimeType: file.mimeType,
        data: file.data.toString("base64"),
      },
    });
  }

  const response = await ai.models.generateContent({
    model: modelName(),
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      responseSchema: EXTRACT_SCHEMA,
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
  });

  const raw = response.text;
  if (!raw) throw new Error("Geminiから空の応答が返りました。");

  const parsed = parseJson<{ items?: unknown }>(raw);
  const items = sanitizeItems(parsed);
  if (items.length === 0) {
    throw new Error(
      "問題・解答を抽出できませんでした。画像が鮮明か、問題と解答が含まれているか確認してください。"
    );
  }
  return items;
}

export async function generateProblems(
  pairs: Pair[],
  count: number,
  apiKey: string
): Promise<{
  problems: GeneratedProblem[];
  skipped: Skipped[];
  warnings: string[];
}> {
  const viable = pairs
    .filter(
      (pair) =>
        pair.answer && pair.status === "matched" && !pair.figureOnly
    )
    .slice(0, Math.min(12, Math.max(count * 2, 6)));

  if (viable.length === 0) {
    throw new Error(
      "数式のみで完結する問題と解答のペアがありません。図形が必須でない問題をアップロードしてください。"
    );
  }

  const sourceText = viable
    .map((pair, index) => {
      const number = pair.problem.number || pair.key;
      const title = pair.problem.title ? ` / ${pair.problem.title}` : "";
      return `--- 元問題 ${index + 1}: ${number}${title} ---
問題: ${pair.problem.body_latex}
解答: ${pair.answer?.body_latex ?? ""}`;
    })
    .join("\n\n");

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: modelName(),
    contents: [
      {
        role: "user",
        parts: [{ text: generatePrompt(sourceText, count) }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: GENERATE_SCHEMA,
      temperature: 0.45,
      maxOutputTokens: 8192,
    },
  });

  const raw = response.text;
  if (!raw) throw new Error("Geminiから空の応答が返りました。");

  const parsed = parseJson<{ problems?: unknown; skipped?: unknown }>(raw);
  const problems = sanitizeGenerated(parsed).slice(0, count);
  const skipped = sanitizeSkipped(parsed);

  if (problems.length === 0) {
    throw new Error(
      "類題を生成できませんでした。問題と解答の内容を確認してください。"
    );
  }

  const warnings: string[] = [];
  if (problems.length < count) {
    warnings.push(
      `指定${count}問に対して${problems.length}問のみ生成されました。図形必須の問題はスキップされています。`
    );
  }

  return { problems, skipped, warnings };
}
