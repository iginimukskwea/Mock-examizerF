import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { PDF_DIR, getExamDetail, setExamPdfPath } from "./db";
import { getKatexCss, renderRich } from "./latex";
import type { ExamItem, SubQuestionSpec, TemplateData } from "./types";
import { normalizeTemplate } from "./template";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findChrome(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Chrome/Edgeが見つかりません。.env.local の CHROME_PATH にブラウザの実行ファイルパスを設定してください。"
  );
}

function findSubQuestion(
  template: TemplateData,
  sectionNo: number,
  questionNo: number
): SubQuestionSpec | null {
  const section = template.sections.find((entry) => entry.no === sectionNo);
  if (!section) return null;
  return section.subQuestions.find((sub) => sub.no === questionNo) ?? null;
}

function answerSpace(sub: SubQuestionSpec | null, points: number): string {
  const format = sub?.format ?? "written";
  if (format === "choice") {
    return `<div class="answer-choice">（　　　　　　　　）</div>`;
  }
  if (format === "fill_blank") {
    return `<div class="answer-fill">［　　　　　　　　　　　　］</div>`;
  }
  const height = Math.min(60, Math.max(18, 16 + points * 1.8));
  return `<div class="answer-lines" style="height:${height}mm"></div>`;
}

interface PaperArgs {
  title: string;
  subject: string;
  template: TemplateData;
  items: ExamItem[];
  kind: "question" | "answer";
  demo?: boolean;
}

function buildStyle(): string {
  return `${getKatexCss()}
@page { size: A4; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Yu Gothic", "YuGothic", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Meiryo", sans-serif;
  color: #111; font-size: 10.2pt; line-height: 1.75;
}
.paper { page-break-after: always; }
.paper:last-child { page-break-after: auto; }
.paper-title { font-size: 17pt; font-weight: 700; text-align: center; letter-spacing: .12em; margin: 0 0 1.5mm; }
.paper-sub { text-align: center; font-size: 8.8pt; color: #444; margin-bottom: 4mm; letter-spacing: .08em; }
.meta {
  display: flex; justify-content: space-between; align-items: center;
  border-top: 1.4pt solid #111; border-bottom: 1.4pt solid #111;
  padding: 1.8mm 0; font-size: 9pt; margin-bottom: 3mm;
}
.meta span { font-weight: 600; }
.name-line { display: flex; justify-content: flex-end; gap: 6mm; font-size: 9pt; margin-bottom: 3mm; }
.name-line .slot { display: inline-flex; align-items: flex-end; gap: 2mm; }
.name-line .line { display: inline-block; border-bottom: 1px solid #333; min-width: 34mm; height: 4mm; }
.instructions { font-size: 8.5pt; color: #444; border: 1px solid #bbb; padding: 2mm 3mm; margin-bottom: 4mm; }
.instructions ol { margin: 1mm 0 0 5mm; padding: 0; }
.preamble { font-size: 9pt; border: 1px solid #bbb; padding: 2mm 3mm; margin-bottom: 4mm; }
.columns { column-count: 2; column-gap: 8mm; }
.columns.cols-1 { column-count: 1; }
.section { margin: 0 0 5mm; }
.section-head {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 1px solid #777; padding-bottom: 1mm; margin-bottom: 2mm;
  font-size: 11pt; font-weight: 700; break-after: avoid;
}
.section-head .points { font-size: 9pt; font-weight: 400; color: #444; }
.induce { font-size: 8.5pt; color: #555; margin: 0 0 1.5mm; }
.q { margin: 0 0 3.2mm; break-inside: avoid; }
.q-label { font-weight: 700; margin-right: 1.5mm; }
.body { text-align: justify; }
.answer-lines {
  border: 1px solid #b5b5b5; border-radius: 1px; margin-top: 1.5mm;
  background-image: repeating-linear-gradient(to bottom, transparent, transparent 7.2mm, #cfcfcf 7.2mm, #cfcfcf 7.4mm);
}
.choices { display: flex; flex-wrap: wrap; gap: 2mm 5mm; margin-top: 1.2mm; font-size: 9.5pt; }
.choice { display: inline-flex; align-items: baseline; gap: 1.5mm; }
.choice-label { font-weight: 700; }
.answer-choice, .answer-fill { margin-top: 1.5mm; font-size: 10pt; letter-spacing: .1em; }
.answer-fill { border-bottom: 1px solid #333; display: inline-block; min-width: 40mm; }
.answer-box { border: 1px solid #999; padding: 2mm 3mm; margin-top: 1.2mm; break-inside: avoid; }
.answer-box .answer-label { font-size: 8pt; color: #666; letter-spacing: .1em; }
.explanation {
  font-size: 9pt; color: #222; margin-top: 2mm; padding-left: 3mm;
  border-left: 2.5pt solid #dc2626;
}
.explanation .explanation-label { font-size: 8pt; color: #666; letter-spacing: .1em; }
.demo-note { margin-top: 6mm; font-size: 8pt; color: #777; text-align: center; }
.section-answer { margin: 0 0 4mm; }
`;
}

function buildHeader(args: PaperArgs, constraints: { minutes: number; score: number }): string {
  const subtitle = args.kind === "question" ? "問題冊子" : "解答・解説冊子";
  const meta =
    args.kind === "question"
      ? `<div class="meta"><span>教科: ${args.subject}</span><span>試験時間: ${constraints.minutes}分</span><span>配点: ${constraints.score}点</span></div>
         <div class="name-line"><span class="slot">受験番号 <span class="line"></span></span><span class="slot">氏名 <span class="line"></span></span></div>`
      : `<div class="meta"><span>教科: ${args.subject}</span><span>解答・解説</span><span>配点: ${constraints.score}点</span></div>`;
  return `<div class="paper-title">${escape(args.title)}</div>
    <div class="paper-sub">${subtitle}</div>
    ${meta}`;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildQuestionPaper(args: PaperArgs): string {
  const template = args.template;
  const constraints = { minutes: template.examMinutes, score: template.totalScore };
  const sections = template.sections
    .map((section) => ({
      spec: section,
      items: args.items.filter((item) => item.section_no === section.no),
    }))
    .filter((entry) => entry.items.length > 0);

  const sectionHtml = sections
    .map(({ spec, items }) => {
      const points = spec.points && template.layout.showPoints ? `<span class="points">${spec.points}点</span>` : "";
      const induction = spec.induction ? `<div class="induce">${renderRich(spec.induction)}</div>` : "";
      const questions = items
        .map((item) => {
          const sub = findSubQuestion(template, item.section_no, item.question_no);
          const itemPoints = sub?.points ?? 0;
          const options = item.options ?? [];
          const choices =
            options.length > 0
              ? `<div class="choices">${options
                  .map(
                    (option, index) =>
                      `<span class="choice"><span class="choice-label">${
                        ["ア", "イ", "ウ", "エ", "オ", "カ", "キ", "ク", "ケ", "コ", "サ", "シ"][
                          index
                        ] ?? String(index + 1)
                      }</span>${renderRich(option)}</span>`
                  )
                  .join("")}</div>`
              : "";
          return `<div class="q">
            <span class="q-label">（${item.question_no}）</span><span class="body">${renderRich(item.body_latex)}</span>
            ${choices}
            ${answerSpace(sub, itemPoints)}
          </div>`;
        })
        .join("");
      return `<div class="section">
        <div class="section-head"><span>第${spec.no}問${spec.title ? ` ${escape(spec.title)}` : ""}</span>${points}</div>
        ${induction}
        ${questions}
      </div>`;
    })
    .join("");

  const demoNote = args.demo
    ? `<div class="demo-note">※ 本冊子はAI未設定のデモモードで生成されたものです。</div>`
    : "";
  const written = template.answerFormatRules.writtenInstructions.trim()
    ? `<li>${escape(template.answerFormatRules.writtenInstructions)}</li>`
    : "";
  const preamble = template.preambleConventions.preambleBlock.trim()
    ? `<div class="preamble">${renderRich(template.preambleConventions.preambleBlock)}</div>`
    : "";

  return `<div class="paper">
    ${buildHeader(args, constraints)}
    <div class="instructions">
      <strong>注意事項</strong>
      <ol>
        <li>解答は指定された解答欄に記入してください。</li>
        <li>解答欄の形式（${escape(template.layout.answerStyle)}）に従ってください。</li>
        <li>試験時間は ${constraints.minutes} 分、総配点は ${constraints.score} 点です。</li>
        ${written}
      </ol>
    </div>
    ${preamble}
    <div class="columns ${template.layout.columns === 1 ? "cols-1" : ""}">
      ${sectionHtml}
    </div>
    ${demoNote}
  </div>`;
}

function buildAnswerPaper(args: PaperArgs): string {
  const template = args.template;
  const constraints = { minutes: template.examMinutes, score: template.totalScore };
  const sections = template.sections
    .map((section) => ({
      spec: section,
      items: args.items.filter((item) => item.section_no === section.no),
    }))
    .filter((entry) => entry.items.length > 0);

  const sectionHtml = sections
    .map(({ spec, items }) => {
      const points = spec.points && template.layout.showPoints ? `<span class="points">${spec.points}点</span>` : "";
      const answers = items
        .map((item) => {
          const explanation = item.explanation_latex.trim()
            ? `<div class="explanation"><span class="explanation-label">解説</span><br/>${renderRich(item.explanation_latex)}</div>`
            : "";
          return `<div class="q">
            <span class="q-label">（${item.question_no}）</span>
            <div class="answer-box"><span class="answer-label">解答</span><br/>${renderRich(item.answer_latex || "（解答未登録）")}</div>
            ${explanation}
          </div>`;
        })
        .join("");
      return `<div class="section-answer">
        <div class="section-head"><span>第${spec.no}問${spec.title ? ` ${escape(spec.title)}` : ""}</span>${points}</div>
        ${answers}
      </div>`;
    })
    .join("");

  return `<div class="paper">
    ${buildHeader(args, constraints)}
    <div class="columns ${template.layout.columns === 1 ? "cols-1" : ""}">
      ${sectionHtml}
    </div>
    ${args.demo ? `<div class="demo-note">※ 本冊子はAI未設定のデモモードで生成されたものです。</div>` : ""}
  </div>`;
}

export function buildPaperHtml(args: PaperArgs): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"/><title>${escape(args.title)}</title>
    <style>${buildStyle()}</style></head><body>
    ${args.kind === "question" ? buildQuestionPaper(args) : buildAnswerPaper(args)}
    </body></html>`;
}

export async function renderPdfBuffer(html: string): Promise<Buffer> {
  const executablePath = findChrome();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMediaType("print");
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", bottom: "18mm", left: "13mm", right: "13mm" },
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#777;text-align:center;font-family:sans-serif;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    return Buffer.from(buffer);
  } finally {
    await browser.close();
  }
}

export async function generateExamPdf(
  examId: number,
  kind: "question" | "answer"
): Promise<{ filename: string; filePath: string }> {
  const detail = getExamDetail(examId);
  if (!detail) throw new Error("模試が見つかりません");

  const template = normalizeTemplate(JSON.parse(detail.exam.template_json));
  let demo = false;
  try {
    const config = JSON.parse(detail.exam.config_json) as { demo?: boolean };
    demo = Boolean(config.demo);
  } catch {
    demo = false;
  }

  const html = buildPaperHtml({
    title: detail.exam.title,
    subject: detail.exam.subject,
    template,
    items: detail.items,
    kind,
    demo,
  });

  const buffer = await renderPdfBuffer(html);
  fs.mkdirSync(PDF_DIR, { recursive: true });
  const filename = `exam-${examId}-${kind}.pdf`;
  const filePath = path.join(PDF_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  setExamPdfPath(examId, kind, filename);
  return { filename, filePath };
}
