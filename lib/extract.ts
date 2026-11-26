import fs from "node:fs";
import path from "node:path";
import {
  aiJson,
  aiMode,
  formatAiError,
  type AiMode,
  type AiFile,
} from "./ai";
import { UPLOAD_DIR } from "./db";
import { extractPdfPagesWithLayout } from "./pdf-layout";
import {
  extractPdfPagesWithOcr,
  ocrEngineLabel,
  ocrImageHighQuality,
  ocrPdfPagesHighQuality,
  type OcrEngine,
} from "./ocr";
import { DEFAULT_TEMPLATE, heuristicTemplate, normalizeTemplate } from "./template";
import {
  normalizeDifficulty,
  normalizeQuestionType,
  type AnswerFormat,
  type ExtractedProblem,
  type SectionSpec,
  type TemplateData,
} from "./types";

export interface FileInput {
  name: string;
  mime: string;
  buffer: Buffer;
  kind: "pdf" | "image" | "text";
}

const MAX_BYTES = 25 * 1024 * 1024;

function guessKind(name: string, mime: string): "pdf" | "image" | "text" {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) return "image";
  return "text";
}

export async function readFileInput(file: File): Promise<FileInput> {
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error("ファイルサイズが上限（25MB）を超えています");
  }
  const name = file.name || "upload";
  const mime = file.type || "";
  const kind = guessKind(name, mime);
  const resolvedMime =
    mime || (kind === "pdf" ? "application/pdf" : kind === "image" ? "image/png" : "text/plain");
  return { name, mime: resolvedMime, buffer, kind };
}

export function saveUpload(file: FileInput): string {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
  const filename = `${Date.now()}-${safe}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer);
  return filename;
}

export async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  // PDFiumは日本語CMapを内蔵しており、pdfjs-distのように文字化けしない。
  const result = await extractPdfPagesWithOcr(buffer, { ocr: false });
  return result.pages;
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const pages = await extractPdfPages(buffer);
  return pages.filter(Boolean).join("\n\n").trim();
}

export type ExtractionEngine =
  | "layout_pdf"
  | "pdfium_text"
  | "mixed"
  | "text"
  | OcrEngine;

export interface TextExtraction {
  text: string;
  pages: string[];
  ocrUsed: boolean;
  ocrPages: number[];
  errors: string[];
  engine: ExtractionEngine;
  engineLabel: string;
  pageEngines: ExtractionEngine[];
  columns: Array<1 | 2>;
  layoutUsed: boolean;
  rawText: string;
}

export interface ExtractionSummary {
  engine: ExtractionEngine;
  engineLabel: string;
  pageEngines: ExtractionEngine[];
  columns: Array<1 | 2>;
  ocrPages: number[];
  layoutUsed: boolean;
}

function extractionSummary(extraction: TextExtraction): ExtractionSummary {
  return {
    engine: extraction.engine,
    engineLabel: extraction.engineLabel,
    pageEngines: extraction.pageEngines,
    columns: extraction.columns,
    ocrPages: extraction.ocrPages,
    layoutUsed: extraction.layoutUsed,
  };
}

function ocrWarnings(extraction: TextExtraction): string[] {
  const list: string[] = [];
  if (extraction.ocrUsed) {
    list.push(
      `スキャン/画像ページの${extraction.ocrPages.length}ページを${extraction.engineLabel}でOCRしました。`
    );
  }
  list.push(...extraction.errors);
  return list;
}

function cleanPageText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\(cid:\d+\)/g, "")
    .replace(/\uFFFD/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * ページ番号・柱・ヘッダー/フッターの繰り返しを決定論的に除去する。
 * AIへ渡す前のノイズ削減が目的。
 */
function cleanExtractedPages(pages: string[]): string[] {
  const normalized = pages.map(cleanPageText);
  const counts = new Map<string, number>();

  for (const page of normalized) {
    const seen = new Set<string>();
    for (const line of page.split("\n").map((value) => value.trim())) {
      if (!line || line.length < 2 || line.length > 50) continue;
      if (/[。、]/.test(line)) continue;
      // 大問・小問見出しや選択肢記号は本文の可能性が高いので残す。
      if (
        /^(第\s*[0-9０-９]+\s*問|問\s*[0-9０-９]+|[ア-ン])$/.test(line)
      ) {
        continue;
      }
      if (!seen.has(line)) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
        seen.add(line);
      }
    }
  }

  const threshold = Math.max(2, Math.ceil(normalized.length * 0.6));
  const furniture = new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count >= threshold)
      .map(([line]) => line)
  );

  return normalized.map((page) =>
    page
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (
          /^\s*[-−—―]?\s*[0-9０-９]{1,4}\s*[-−—―]?\s*$/.test(trimmed)
        ) {
          return false;
        }
        if (furniture.has(trimmed)) return false;
        return true;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function cleanExtractedText(text: string, pages: string[]): string {
  const cleanedPages = cleanExtractedPages(
    pages.length > 0 ? pages : [text]
  );
  return (
    cleanedPages.filter(Boolean).join("\n\n").trim() || cleanPageText(text)
  );
}

async function extractPdfInputText(
  buffer: Buffer,
  options: TextExtractionOptions
): Promise<TextExtraction> {
  const layout = await extractPdfPagesWithLayout(buffer);
  const layoutPages = layout.pages;
  const errors = [...layout.errors];
  let pages: string[] = layoutPages.map((page) => page.text);
  let pageEngines: ExtractionEngine[] = layoutPages.map((page) =>
    page.quality === "good" && page.text.trim() ? "layout_pdf" : "none"
  );
  let columns: Array<1 | 2> = layoutPages.map((page) => page.columns);

  const usableLayout = layoutPages.filter(
    (page) => page.quality === "good" && page.text.trim()
  ).length;
  const garbledPages = layoutPages
    .filter((page) => page.quality !== "good")
    .map((page) => page.pageNumber);

  if (usableLayout === 0 || garbledPages.length > 0) {
    const fallback = await extractPdfPagesWithOcr(buffer, { ocr: false });
    errors.push(...fallback.errors);

    if (layoutPages.length === 0) {
      pages = fallback.pages;
      pageEngines = fallback.pages.map((text) =>
        text.trim() ? "pdfium_text" : "none"
      );
      columns = fallback.pages.map(() => 1);
    } else {
      const targets =
        usableLayout === 0
          ? layoutPages.map((page) => page.pageNumber)
          : garbledPages;
      for (const pageNumber of targets) {
        const text = fallback.pages[pageNumber - 1] ?? "";
        if (text.trim()) {
          pages[pageNumber - 1] = text;
          pageEngines[pageNumber - 1] = "pdfium_text";
          columns[pageNumber - 1] = 1;
        }
      }
    }
  }

  const needsOcr = pages
    .map((text, index) => (text.trim().length < 20 ? index + 1 : 0))
    .filter((pageNumber) => pageNumber > 0);
  const ocrTargets =
    typeof options.ocrMaxPages === "number" && options.ocrMaxPages > 0
      ? needsOcr.filter(
          (pageNumber) => pageNumber <= options.ocrMaxPages!
        )
      : needsOcr;

  const ocrPages: number[] = [];
  let ocrEngine: OcrEngine = "none";

  if (ocrTargets.length > 0) {
    const ocr = await ocrPdfPagesHighQuality(buffer, ocrTargets);
    errors.push(...ocr.warnings);
    for (const pageNumber of ocrTargets) {
      const text = (ocr.pages[pageNumber] ?? "").trim();
      if (!text) continue;
      pages[pageNumber - 1] = text;
      pageEngines[pageNumber - 1] = ocr.engines[pageNumber] ?? "none";
      columns[pageNumber - 1] = 1;
      ocrPages.push(pageNumber);
    }
    if (ocrPages.length > 0) {
      ocrEngine = ocr.engine;
    }
  }

  const hasLayoutPages = pageEngines.some(
    (engine) => engine === "layout_pdf" || engine === "pdfium_text"
  );
  const hasOcrPages = ocrPages.length > 0;
  let engine: ExtractionEngine = "none";
  let engineLabel = "テキスト抽出なし";

  if (hasLayoutPages && hasOcrPages) {
    engine = "mixed";
    engineLabel = `座標PDF抽出 + ${ocrEngineLabel(ocrEngine)}`;
  } else if (hasOcrPages) {
    engine = ocrEngine;
    engineLabel = ocrEngineLabel(ocrEngine);
  } else if (pageEngines.includes("layout_pdf")) {
    engine = "layout_pdf";
    engineLabel = "座標PDF抽出";
  } else if (pageEngines.includes("pdfium_text")) {
    engine = "pdfium_text";
    engineLabel = "PDFテキスト抽出（互換）";
  }

  const text = pages.filter(Boolean).join("\n\n").trim();
  return {
    text,
    pages,
    ocrUsed: hasOcrPages,
    ocrPages,
    errors,
    engine,
    engineLabel,
    pageEngines,
    columns,
    layoutUsed: hasLayoutPages,
    rawText: text,
  };
}

/**
 * PDFは埋め込みテキストを優先し、空ページだけOCRする。
 * 画像はTesseract.jsでOCRしてテキスト化する。
 */
export interface TextExtractionOptions {
  ocrMaxPages?: number;
}

export async function extractInputText(
  input: FileInput,
  options: TextExtractionOptions = {}
): Promise<TextExtraction> {
  if (input.kind === "pdf") {
    return extractPdfInputText(input.buffer, options);
  }
  if (input.kind === "image") {
    const result = await ocrImageHighQuality(input.buffer);
    return {
      text: result.text,
      pages: [result.text],
      ocrUsed: result.engine !== "none",
      ocrPages: result.engine !== "none" ? [1] : [],
      errors: result.warnings,
      engine: result.engine,
      engineLabel: result.engineLabel,
      pageEngines: [result.engine],
      columns: [1],
      layoutUsed: false,
      rawText: result.text,
    };
  }
  const text = input.buffer.toString("utf8");
  return {
    text,
    pages: [text],
    ocrUsed: false,
    ocrPages: [],
    errors: [],
    engine: "text",
    engineLabel: "テキスト入力",
    pageEngines: ["text"],
    columns: [1],
    layoutUsed: false,
    rawText: text,
  };
}

export async function extractAnyText(input: FileInput): Promise<string> {
  return (await extractInputText(input)).text;
}

function toAiFiles(input: FileInput): AiFile[] {
  if (input.kind === "pdf") {
    return [{ kind: "pdf", mime: "application/pdf", data: input.buffer, name: input.name }];
  }
  if (input.kind === "image") {
    return [{ kind: "image", mime: input.mime, data: input.buffer, name: input.name }];
  }
  return [];
}

const CLAMP_NOTE = "\n...(以下省略)";

function clampText(text: string, max = 24000): string {
  if (text.length <= max) return text;
  const budget = Math.max(0, max - CLAMP_NOTE.length);
  return `${text.slice(0, budget)}${CLAMP_NOTE}`;
}

const TEMPLATE_TEXT_LIMIT = 3500;
const PROBLEM_CHUNK_LIMIT = 14000;
const TEMPLATE_CUT_NOTE = "\n...(長大PDFのため要点のみ抽出)";

/**
 * 入力①用: 28ページ等の長大PDFから、表紙・大問見出し・小問番号・配点・解答番号を
 * 優先して拾い、LLMへ渡す文字数を 3,500 文字以内に抑える。
 */
export function condenseTemplateText(text: string, max = TEMPLATE_TEXT_LIMIT): string {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;

  const budget = Math.max(500, max - TEMPLATE_CUT_NOTE.length);
  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/\s+$/g, "").trim())
    .filter(Boolean);
  // 優先度順に選びつつ、最終出力は元の行順に戻す。
  // これにより「第N問 → その小問」の対応をLLMが保ちやすい。
  const selected: Array<{ index: number; line: string }> = [];
  const seen = new Set<string>();
  let total = 0;

  const add = (line: string, index: number, maxLineLength = 300) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > maxLineLength) return;
    const key = trimmed.slice(0, 100);
    if (seen.has(key)) return;
    const cost = trimmed.length + 1;
    if (total + cost > budget) return;
    seen.add(key);
    selected.push({ index, line: trimmed });
    total += cost;
  };

  // 表紙・冒頭（長い本文は入れず、見出しになり得る短い行だけ）
  for (let i = 0; i < Math.min(5, lines.length); i += 1) {
    add(lines[i], i, 120);
  }

  // 全角数字を含む大問・小問・配点・解答番号・時間の行を優先
  const priorities: RegExp[] = [
    /第\s*[0-9０-９一二三四五六七八九十]+\s*問|大問\s*[0-9０-９]+|^[ⅠⅡⅢⅣⅤⅥⅦⅧ]/,
    /[（(]\s*[0-9０-９]+\s*[）)]|^\s*問\s*[0-9０-９]+/,
    /[0-9０-９]+\s*点|配点|満点|解答番号|解答欄|答え/,
    /試験時間|[0-9０-９]+\s*分/,
  ];
  for (const pattern of priorities) {
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i])) add(lines[i], i, 200);
    }
  }

  // 余裕があれば短い行で補完
  for (let i = 0; i < lines.length; i += 1) {
    if (total >= budget - 100) break;
    add(lines[i], i, 80);
  }

  const result = selected
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.line)
    .join("\n")
    .slice(0, budget);
  return `${result}${TEMPLATE_CUT_NOTE}`;
}

interface PageChunk {
  start: number;
  end: number;
  text: string;
}

/**
 * 入力②用: 3〜5ページ単位のチャンクに分割する（既定4ページ、1ページ重複）。
 */
export function buildPageChunks(pages: string[], size = 4, overlap = 1): PageChunk[] {
  const chunks: PageChunk[] = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < pages.length; start += step) {
    const end = Math.min(pages.length, start + size);
    const text = pages
      .slice(start, end)
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (text) chunks.push({ start: start + 1, end, text });
    if (end >= pages.length) break;
  }
  return chunks;
}

function problemSignature(problem: ExtractedProblem): string {
  return problem.body_latex.replace(/\s+/g, "").slice(0, 160);
}

function mergeProblems(groups: ExtractedProblem[]): ExtractedProblem[] {
  const seen = new Set<string>();
  const merged: ExtractedProblem[] = [];
  for (const problem of groups) {
    const signature = problemSignature(problem);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    merged.push(problem);
    if (merged.length >= 120) break;
  }
  return merged;
}

const TEMPLATE_SYSTEM =
  "あなたは日本の大学入試・高校入試の模試問題冊子を構造分析する専門家です。問題の内容そのものではなく、出題形式・レイアウト・構成のみを抽出します。";

const TEMPLATE_PROMPT = `添付の模試問題冊子（PDF/画像）、または抽出済みテキストを分析し、以下のJSONスキーマで出題形式・構造を抽出してください。
参考テキストは長大PDFから要点のみを抽出した場合があります。行の抜けは無視し、見出し・配点・解答番号から全体構造を推定してください。
{
  "data": {
    "schemaVersion": 1,
    "examMinutes": 数値,
    "totalScore": 数値,
    "sections": [
      {
        "no": 1,
        "title": "大問の見出し（例: 小問集合）",
        "points": その大問の配点（不明なら0）,
        "induction": "誘導構成の説明（例: (1)の結果を(2)で利用）",
        "subQuestions": [
          { "no": 1, "format": "written か choice か fill_blank", "points": 配点, "answerSpace": "解答欄の形式", "note": "補足" }
        ]
      }
    ],
    "layout": {
      "columns": 1 か 2,
      "headerFormat": "ヘッダーの形式",
      "showPoints": true か false,
      "answerStyle": "解答欄の形式"
    },
    "difficulty_curve": {
      "overall": "冊子全体の難易度推移（例: 序盤は基礎、第3問で最大、終盤は標準）",
      "hop_step_jump": "小問内の難易度勾配をホップ・ステップ・ジャンプで説明（例: (1)ホップ=公式適用、(2)ステップ=場合分け、(3)ジャンプ=論証）",
      "sections": [
        { "no": 1, "trend": "大問内の難易度推移", "sub_gradient": "小問ごとの難易度勾配" }
      ]
    },
    "scaffolding_type": "numeric_chain か lemma か generalize か independent か mixed",
    "answer_format_rules": {
      "fill_blank_digits": "穴埋めの桁数枠・マス目の制約（例: 2桁、符号1桁+数字2桁）",
      "fraction_rules": "既約分数・帯分数などの簡約ルール",
      "surd_rules": "根号の簡約・有理化のルール",
      "written_instructions": "記述式の定型指示文（例: 途中式も書きなさい）"
    },
    "preamble_conventions": {
      "preamble_block": "理科の有効数字・物理定数などの共通前提ブロック",
      "constants": "使用する物理定数・原子量などの値",
      "significant_figures": "有効数字の扱い",
      "variable_naming": "文字定数の命名傾向（例: 点P、時刻t、質量m）"
    },
    "layout_density": {
      "lead_text": "リード文の長さ・配置",
      "dialogue": "会話文の有無と配置",
      "figures": "図表の配置スタイル",
      "whitespace": "余白バランス・情報密度"
    },
    "extras": { "試験時間": "...", "総配点": "...", "その他の構造情報": "..." }
  },
  "notes": "抽出時に曖昧だった点や注意事項"
}
大問の数・各小問の数・解答形式を正確に数えてください。判断できない値は妥当な推定値にしてください。
difficulty_curve / scaffolding_type / answer_format_rules / preamble_conventions / layout_density は、問題冊子から読み取れる範囲で日本語の文字列として記述し、不明な項目は空文字にしてください。scaffolding_type だけは必ず次のいずれか1つにしてください: numeric_chain, lemma, generalize, independent, mixed。`;

export interface TemplateAnalysis {
  data: TemplateData;
  notes: string;
  mode: AiMode;
  warnings: string[];
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
}

function parseNumeric(value: string): number {
  const normalized = toAsciiDigits(value).replace(/[^\d]/g, "");
  return normalized ? Number(normalized) : 0;
}

/**
 * PDF本文の「第N問」「問N」見出しから、大問・小問構造を決定論的に組み立てる。
 * LLMが大問を1つしか返さない場合の補完に使う。
 */
function parseExamStructure(text: string): TemplateData | null {
  const normalized = text.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const sectionPattern = /^\s*第\s*([0-9０-９]+)\s*問\s*(.*)$/;
  const subPattern = /^\s*問\s*([0-9０-９]+)\s*(.*)$/;

  const headings: Array<{
    no: number;
    index: number;
    points: number;
  }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(sectionPattern);
    if (!match) continue;
    const no = parseNumeric(match[1]);
    if (!no) continue;
    // ページヘッダーで同じ大問番号が再登場する場合は最初の見出しだけ使う。
    if (headings.some((heading) => heading.no === no)) continue;
    // 「第2問」の直後の行に（配点 25）が来るPDFもあるため、数行先まで見る。
    const headingWindow = lines.slice(i, i + 3).join(" ");
    const pointsMatch = headingWindow.match(/配点\s*([0-9０-９]+)/);
    headings.push({
      no,
      index: i,
      points: pointsMatch ? parseNumeric(pointsMatch[1]) : 0,
    });
  }

  if (headings.length === 0) return null;
  headings.sort((a, b) => a.no - b.no);

  const sections: SectionSpec[] = headings.map((heading, index) => {
    const endIndex = headings[index + 1]?.index ?? lines.length;
    const rangeLines = lines.slice(heading.index, endIndex);
    const rangeText = rangeLines.join("\n");
    const subNumbers = new Set<number>();

    for (const line of rangeLines) {
      const subMatch = line.match(subPattern);
      if (!subMatch) continue;
      const subNo = parseNumeric(subMatch[1]);
      if (subNo > 0) subNumbers.add(subNo);
    }

    const orderedSubNumbers = Array.from(subNumbers).sort((a, b) => a - b);
    const format: AnswerFormat = /選べ|選択|マーク/.test(rangeText)
      ? "choice"
      : "written";

    return {
      no: heading.no,
      title: "",
      points: heading.points,
      induction: "",
      subQuestions: (orderedSubNumbers.length > 0 ? orderedSubNumbers : [1]).map(
        (no) => ({
          no,
          format,
          points: 0,
        })
      ),
    };
  });

  const totalPoints = sections.reduce(
    (sum, section) => sum + (section.points ?? 0),
    0
  );
  const minutesMatch = normalized.match(/([0-9０-９]{2,3})\s*分/);
  const examMinutes = minutesMatch ? parseNumeric(minutesMatch[1]) : 60;
  const answerStyle = /選べ|選択|マーク/.test(normalized)
    ? "選択式（マーク）"
    : "記述式（罫線）";

  return normalizeTemplate({
    schemaVersion: 1,
    examMinutes: examMinutes || 60,
    totalScore: totalPoints > 0 ? totalPoints : 100,
    sections,
    layout: {
      columns: 2,
      headerFormat: "模試名 / 教科 / 試験時間 / 総配点",
      showPoints: true,
      answerStyle,
    },
    extras: { deterministic: true },
  });
}

function mergeDetectedTemplate(
  ai: TemplateData,
  detected: TemplateData
): { data: TemplateData; replaced: boolean } {
  if (detected.sections.length === 0) return { data: ai, replaced: false };

  // AIが大問数を正しく拾えている場合はAI結果を優先する。
  if (ai.sections.length >= detected.sections.length) {
    return { data: ai, replaced: false };
  }

  const sections = detected.sections.map((detectedSection) => {
    const aiSection = ai.sections.find(
      (section) => section.no === detectedSection.no
    );
    if (!aiSection) return detectedSection;

    return {
      ...detectedSection,
      title: aiSection.title?.trim() ? aiSection.title : detectedSection.title,
      points:
        aiSection.points && aiSection.points > 0
          ? aiSection.points
          : detectedSection.points,
      subQuestions: detectedSection.subQuestions.map((sub, index) => {
        const aiSub = aiSection.subQuestions[index];
        if (!aiSub) return sub;
        return {
          ...sub,
          format: aiSub.format,
          points: aiSub.points && aiSub.points > 0 ? aiSub.points : sub.points,
          answerSpace: aiSub.answerSpace,
          note: aiSub.note,
        };
      }),
    };
  });

  return {
    data: {
      ...ai,
      sections,
      examMinutes: ai.examMinutes || detected.examMinutes,
      totalScore: ai.totalScore || detected.totalScore,
      layout: {
        columns: ai.layout.columns || detected.layout.columns,
        headerFormat: ai.layout.headerFormat || detected.layout.headerFormat,
        showPoints: ai.layout.showPoints ?? detected.layout.showPoints,
        answerStyle: ai.layout.answerStyle || detected.layout.answerStyle,
      },
    },
    replaced: true,
  };
}

export async function analyzeTemplate(input: FileInput): Promise<TemplateAnalysis> {
  const mode = aiMode();
  const warnings: string[] = [];
  // 傾向抽出のOCRは最初の2ページまでに限定する。
  const extraction = await extractInputText(input, { ocrMaxPages: 2 });
  const extractedText = cleanExtractedText(
    extraction.text,
    extraction.pages
  );
  const hasText = extractedText.trim().length > 0;
  warnings.push(...ocrWarnings(extraction));

  if (mode !== "demo") {
    try {
      const promptText = hasText
        ? condenseTemplateText(extractedText, TEMPLATE_TEXT_LIMIT)
        : "（テキスト抽出なし）";
      // テキストがある場合は画像/PDFパーツを送らず、テキストを3,500文字以内に抑える。
      const files = hasText ? [] : toAiFiles(input);
      const result = await aiJson<{ data: unknown; notes?: string }>({
        system: TEMPLATE_SYSTEM,
        prompt: `${TEMPLATE_PROMPT}\n\n${
          hasText ? "長大PDFから要点を抽出した参考テキスト:" : "参考テキスト:"
        }\n${promptText}`,
        files,
        maxTokens: 8192,
      });
      const aiData = normalizeTemplate(result.data);
      const detected = parseExamStructure(extractedText);
      const merged = detected
        ? mergeDetectedTemplate(aiData, detected)
        : { data: aiData, replaced: false };
      if (merged.replaced && detected) {
        warnings.push(
          `AIが返した大問数（${aiData.sections.length}）がPDFの見出し（${detected.sections.length}）より少ないため、PDFの構造で補完しました。内容を確認してください。`
        );
      }
      return {
        data: merged.data,
        notes: result.notes ?? "",
        mode,
        warnings,
      };
    } catch (error) {
      warnings.push(
        `AI解析に失敗したため簡易解析に切り替えました: ${formatAiError(error)}`
      );
    }
  }

  const aiConfigured = mode !== "demo";

  if (input.kind === "image") {
    warnings.push(
      aiConfigured
        ? "AI解析に失敗したため、画像からは構造を抽出できませんでした。既定テンプレートを読み込みました。手動で調整してください。"
        : "画像からの構造抽出にはAI APIキーの設定が必要です。既定テンプレートを読み込みました。手動で調整してください。"
    );
    return {
      data: normalizeTemplate({ ...DEFAULT_TEMPLATE, extras: { demo: true } }),
      notes: aiConfigured
        ? "AI解析に失敗したため既定テンプレートを返しました。"
        : "AI未設定のため既定テンプレートを返しました。",
      mode,
      warnings,
    };
  }

  if (!extractedText) {
    warnings.push(
      aiConfigured
        ? "AI解析に失敗し、テキストも抽出できませんでした。既定テンプレートを読み込みました。"
        : "テキストを抽出できませんでした。既定テンプレートを読み込みました。"
    );
    return {
      data: normalizeTemplate({ ...DEFAULT_TEMPLATE, extras: { demo: true } }),
      notes: aiConfigured
        ? "AI解析に失敗し、抽出テキストも空でした。"
        : "抽出テキストが空でした。",
      mode,
      warnings,
    };
  }

  const detected = parseExamStructure(extractedText);
  return {
    data: detected ?? heuristicTemplate(extractedText),
    notes: aiConfigured
      ? "AI解析に失敗したため、PDFの見出しから大問・小問構造を推定しました。内容を確認してください。"
      : "AI未設定のため、PDFの見出しから大問・小問構造を推定しました。内容を確認してください。",
    mode,
    warnings,
  };
}

const PROBLEM_SYSTEM =
  "あなたは日本の受験問題をデータベース化する専門家です。計算問題だけでなく、英語・国語・社会・理科の語句補充問題も正確に分類し、問題文・解答・解説を読み取ります。OCRやPDF座標抽出に由来する誤変換・不要な柱・ページ番号・改行の乱れを文脈から修正し、数式はLaTeXに整形してください。";

const PROBLEM_PROMPT = `添付のPDF/画像、または抽出済みテキストから、問題と解答を抽出してください。数式は必ずLaTeX（インラインは $...$、別行は $$...$$）で記述してください。
OCR/PDF抽出テキストの誤変換、ページ番号、柱、ヘッダー/フッター、不要な改行は文脈から修正・除去してください。問題文・選択肢・解答・解説は明確に分離してください。
参考テキストが与えられた場合は、そのテキストに含まれる問題だけを対象にしてください。
以下のJSONのみを返してください。
{
  "problems": [
    {
      "title": "問題の見出し（例: 2次関数の最大値）",
      "question_type": "calculation か word_fill か knowledge",
      "body_latex": "問題文（設問・条件・空所を含む）",
      "answer_latex": "最終解答",
      "target_word": "語句補充の正解語句（word_fill のとき。それ以外は空文字）",
      "options": ["選択肢1", "選択肢2"],
      "explanation_latex": "解説・方針",
      "suggested_field": "分野（例: 2次関数 / 英文法 / 世界史）",
      "suggested_difficulty": 1から5の整数
    }
  ],
  "notes": "抽出上の注意"
}
問題ごとに1要素として分割してください。
- 計算・数式・記述式の解答問題は question_type を calculation にしてください。
- 空所補充・語句選択・知識問題は question_type を word_fill にし、target_word に空所へ入る正解語句を1つ書いてください。
- 選択肢がある場合は options に「ア」「イ」などの記号を除いた本文だけを列挙してください。選択肢がなければ空配列にしてください。
- 解答が見当たらない場合は answer_latex を空文字にしてください。`;

export interface ProblemAnalysis {
  problems: ExtractedProblem[];
  notes: string;
  mode: AiMode;
  warnings: string[];
  extraction: ExtractionSummary;
  rawTextPreview: string;
}

function sanitizeProblems(raw: unknown): ExtractedProblem[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .slice(0, 30)
    .map((entry): ExtractedProblem | null => {
      const row = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const body = typeof row.body_latex === "string" ? row.body_latex : "";
      if (!body.trim()) return null;
      const targetWord =
        typeof row.target_word === "string" ? row.target_word.trim() : "";
      const options = Array.isArray(row.options)
        ? row.options
            .map((option) => (typeof option === "string" ? option.trim() : ""))
            .filter(Boolean)
            .slice(0, 12)
        : [];
      const questionType = normalizeQuestionType(row.question_type);
      return {
        title: typeof row.title === "string" ? row.title : "",
        body_latex: body,
        answer_latex: typeof row.answer_latex === "string" ? row.answer_latex : "",
        explanation_latex:
          typeof row.explanation_latex === "string" ? row.explanation_latex : "",
        suggested_field: typeof row.suggested_field === "string" ? row.suggested_field : "",
        suggested_difficulty: normalizeDifficulty(row.suggested_difficulty, 3),
        question_type: questionType,
        target_word: targetWord,
        options,
      };
    })
    .filter((item): item is ExtractedProblem => item !== null);
}

async function analyzeProblemChunk(
  text: string,
  files: AiFile[],
  label: string,
  textLimit: number
): Promise<ExtractedProblem[]> {
  const reference = text.trim()
    ? `参考テキスト:\n${clampText(text, textLimit)}`
    : "添付のファイルを解析してください。";
  const problemPrompt = PROBLEM_PROMPT;
  const result = await aiJson<{ problems?: unknown; notes?: string }>({
    system: PROBLEM_SYSTEM,
    prompt: `${problemPrompt}\n\n${label}\n${reference}`,
    files,
    maxTokens: 8192,
  });
  return sanitizeProblems(result.problems);
}

function splitDemoProblems(text: string): ExtractedProblem[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return [];
  const answerSplit = normalized.split(/\n(?:解答|解説|解答・解説)[\s\S]*$/);
  const bodySource = answerSplit[0] ?? normalized;
  const answerSource = answerSplit.length > 1 ? normalized.slice(bodySource.length) : "";

  const chunks = bodySource
    .split(/\n(?=\s*(?:第\s*\d+\s*問|問\s*\d+|[（(]\s*\d+\s*[）)]\s))/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 10);

  const source = chunks.length > 0 ? chunks.slice(0, 10) : [bodySource];
  return source.map((chunk, index) => {
    const isWordFill =
      /(?:_{2,}|（\s*）|\(\s*\)|空所|空欄|穴埋め|次の語句|当てはまる)/.test(chunk);
    return {
      title: `抽出問題 ${index + 1}`,
      body_latex: chunk.slice(0, 4000),
      answer_latex: answerSource ? clampText(answerSource, 2000) : "",
      explanation_latex: "",
      suggested_field: "",
      suggested_difficulty: 3,
      question_type: isWordFill ? ("word_fill" as const) : ("calculation" as const),
      target_word: "",
      options: [],
    };
  });
}

export async function analyzeProblems(input: FileInput): Promise<ProblemAnalysis> {
  const mode = aiMode();
  const warnings: string[] = [];

  const extraction = await extractInputText(input);
  const pages = cleanExtractedPages(
    extraction.pages.length > 0 ? extraction.pages : [extraction.text]
  );
  const extractedText = pages.filter(Boolean).join("\n\n").trim();
  const hasText = extractedText.trim().length > 0;
  warnings.push(...ocrWarnings(extraction));
  const problemTextLimit = PROBLEM_CHUNK_LIMIT;
  const extractionInfo = extractionSummary(extraction);
  const rawTextPreview = clampText(extraction.text, 6000);
  const engineNote = extraction.ocrUsed
    ? `${extraction.engineLabel}で読み取った${extraction.ocrPages.length}ページをAIで誤変換修正・LaTeX整形・構造化しました。`
    : extraction.engine === "layout_pdf"
      ? "座標順に抽出したPDFテキストをAIでLaTeX整形・構造化しました。"
      : extraction.engine === "pdfium_text"
        ? "PDF互換テキスト抽出の結果をAIで構造化しました。"
        : "";

  if (mode !== "demo") {
    // PDFにテキストがある場合は4ページ（1ページ重複）単位で分割し、順次解析する。
    if (input.kind === "pdf" && hasText) {
      const chunks = buildPageChunks(pages, 4, 1);
      if (chunks.length === 0) {
        chunks.push({ start: 1, end: Math.max(1, pages.length), text: extractedText });
      }
      const collected: ExtractedProblem[] = [];
      let successChunks = 0;

      for (const [index, chunk] of chunks.entries()) {
        try {
          const problems = await analyzeProblemChunk(
            chunk.text,
            [],
            `このチャンクはPDFのページ ${chunk.start}-${chunk.end}（${index + 1}/${
              chunks.length
            }）です。この範囲に含まれる問題だけを抽出してください。`,
            problemTextLimit
          );
          if (problems.length > 0) {
            collected.push(...problems);
            successChunks += 1;
          } else {
            warnings.push(
              `ページ ${chunk.start}-${chunk.end} から問題を抽出できませんでした。`
            );
          }
        } catch (error) {
          warnings.push(
            `ページ ${chunk.start}-${chunk.end} のAI解析に失敗しました: ${formatAiError(
              error
            )}`
          );
        }
      }

      const problems = mergeProblems(collected);
      if (problems.length === 0) {
        throw new Error(`AIが問題を抽出できませんでした。${warnings.join(" ")}`);
      }
      return {
        problems,
        notes: [
          engineNote,
          `PDFを${chunks.length}チャンク（各4ページ・1ページ重複）に分割し、${successChunks}チャンクから${problems.length}問を統合しました。`,
        ]
          .filter(Boolean)
          .join(" "),
        mode,
        warnings,
        extraction: extractionInfo,
        rawTextPreview,
      };
    }

    // 画像（非ローカル）、テキストのないPDF（非ローカル）、テキスト入力は単発解析。
    try {
      const files = hasText ? [] : toAiFiles(input);
      const problems = await analyzeProblemChunk(
        extractedText,
        files,
        hasText
          ? "以下の抽出済みテキストから問題を抽出してください。"
          : "以下の添付ファイルから問題を抽出してください。",
        problemTextLimit
      );
      if (problems.length === 0) {
        throw new Error("AIが問題を抽出できませんでした");
      }
      return {
        problems,
        notes: engineNote,
        mode,
        warnings,
        extraction: extractionInfo,
        rawTextPreview,
      };
    } catch (error) {
      warnings.push(
        `AI解析に失敗したため簡易解析に切り替えました: ${formatAiError(error)}`
      );
    }
  }

  const aiConfigured = mode !== "demo";

  if (input.kind === "image") {
    throw new Error(
      aiConfigured
        ? `画像からの問題抽出に失敗しました。${warnings.join(" ")}`
        : "画像からの問題抽出にはAI APIキーが必要です。PDFをアップロードするか、.env.local にAPIキーを設定してください。"
    );
  }

  if (!extractedText) {
    throw new Error(
      aiConfigured
        ? `PDFからテキストを抽出できませんでした。AI解析も失敗しています。${warnings.join(" ")}`
        : "PDFからテキストを抽出できませんでした（スキャン画像の場合はAI APIキーが必要です）"
    );
  }

  const problems = splitDemoProblems(extractedText);
  if (problems.length === 0) {
    throw new Error("問題を抽出できませんでした");
  }
  return {
    problems,
    notes: [
      extraction.ocrUsed
        ? `${extraction.engineLabel}でOCRしたテキストを簡易分割しました（AIクリーニング未実行）。`
        : "",
      aiConfigured
        ? "AI解析に失敗したため、文字情報を問題単位に分割しました。問題文・解答・分野を必ず確認して修正してください。"
        : "AI未設定のため、文字情報を問題単位に分割しただけです。問題文・解答・分野を必ず確認して修正してください。",
    ]
      .filter(Boolean)
      .join(" "),
    mode,
    warnings,
    extraction: extractionInfo,
    rawTextPreview,
  };
}
