import { aiJson, aiMode } from "./ai";
import type { ExamItem, Issue, VerificationStep } from "./types";

const SYSTEM =
  "あなたは日本の大学入試問題を解く採点官です。与えられた問題文だけを根拠に、条件の過不足を見抜き、曖昧さを指摘します。";

export interface StepOutcome {
  step: VerificationStep;
  issues: Issue[];
}

interface BlindItem {
  section_no?: unknown;
  question_no?: unknown;
  solvable?: unknown;
  solved_answer?: unknown;
  ambiguity?: unknown;
  notes?: unknown;
  alternatives?: unknown;
  unique?: unknown;
}

function loc(sectionNo: unknown, questionNo: unknown): string {
  const section = Number(sectionNo);
  const question = Number(questionNo);
  if (!Number.isFinite(section) || !Number.isFinite(question)) return "ブラインド検算";
  return `第${section}問（${question}）`;
}

function skip(summary: string): StepOutcome {
  return {
    step: { iteration: 0, step: "D", status: "skip", summary, issues: [], detail: {} },
    issues: [],
  };
}

function alternativesOf(item: BlindItem): string[] {
  if (!Array.isArray(item.alternatives)) return [];
  return item.alternatives
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

export async function blindVerify(subject: string, items: ExamItem[]): Promise<StepOutcome> {
  if (aiMode() === "demo") {
    return skip("AI未設定のためブラインド検算をスキップしました");
  }
  if (items.length === 0) {
    return skip("検証対象の問題がありません");
  }

  const statements = items.map((item) => ({
    section_no: item.section_no,
    question_no: item.question_no,
    question_type: item.question_type ?? "calculation",
    body_latex: item.body_latex,
    options: item.options ?? [],
  }));

  let blind: BlindItem[] = [];
  try {
    const result = await aiJson<{ results?: unknown }>({
      system: SYSTEM,
      prompt: `次の問題を、解答を見ずに問題文だけから解いてください。
教科: ${subject}

要件:
- 各小問について、条件だけで一意に解けるかを判定する。
- 解ける場合は最終解答を solved_answer に書く。
- 条件不足・解釈の曖昧さ・矛盾があれば ambiguity に具体的に書く。
- 問題を解かずに推測で埋めない。
- question_type が word_fill（語句補充）の場合:
  - 空所に入る最も自然な語句を solved_answer に書く。
  - 文脈上成立しうる別解があれば alternatives に列挙する。
  - 正解が一意に絞れる場合だけ unique を true にする。

出力JSON:
{"results":[{"section_no":1,"question_no":1,"solvable":true,"solved_answer":"...","ambiguity":"","alternatives":[],"unique":true,"notes":""}]}

問題:
${JSON.stringify(statements, null, 2)}`,
      maxTokens: 8192,
    });
    blind = Array.isArray(result.results) ? (result.results as BlindItem[]) : [];
  } catch (error) {
    const issue: Issue = {
      type: "blind_solver_error",
      severity: "warning",
      message: `ブラインド検算の実行に失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
    return {
      step: {
        iteration: 0,
        step: "D",
        status: "warn",
        summary: "ブラインド検算を完了できませんでした",
        issues: [issue],
        detail: {},
      },
      issues: [],
    };
  }

  if (blind.length === 0) {
    return {
      step: {
        iteration: 0,
        step: "D",
        status: "warn",
        summary: "ブラインド検算の結果が空でした",
        issues: [],
        detail: {},
      },
      issues: [],
    };
  }

  const official = items.map((item) => ({
    section_no: item.section_no,
    question_no: item.question_no,
    question_type: item.question_type ?? "calculation",
    answer_latex: item.answer_latex,
    target_word: item.target_word ?? null,
    body_latex: item.body_latex,
    options: item.options ?? [],
  }));

  let mismatches: Array<Record<string, unknown>> = [];
  let leakage: Array<Record<string, unknown>> = [];
  try {
    const judged = await aiJson<{ mismatches?: unknown; leakage?: unknown }>({
      system: SYSTEM,
      prompt: `ブラインド解答と公式解答を比較し、数学的・科学的に同じ内容かを判定してください。
数値・式変形・単位の違いは許容しますが、値や結論が異なる場合は不一致として報告してください。
語句補充（word_fill）では、同じ大問内の他の小問の正解語句が、問題文・選択肢・解説にそのまま露出していないかも検査してください。
教科: ${subject}

ブラインド解答:
${JSON.stringify(blind, null, 2)}

公式解答:
${JSON.stringify(official, null, 2)}

出力JSON:
{"mismatches":[{"section_no":1,"question_no":1,"reason":"不一致の理由"}],"leakage":[{"section_no":1,"question_no":1,"word":"露出した語句","reason":"どこに露出しているか"}],"summary":"総評"}`,
      maxTokens: 4096,
    });
    mismatches = Array.isArray(judged.mismatches)
      ? (judged.mismatches as Array<Record<string, unknown>>)
      : [];
    leakage = Array.isArray(judged.leakage)
      ? (judged.leakage as Array<Record<string, unknown>>)
      : [];
  } catch (error) {
    const issue: Issue = {
      type: "blind_judge_error",
      severity: "warning",
      message: `ブラインド解答の照合に失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
    return {
      step: {
        iteration: 0,
        step: "D",
        status: "warn",
        summary: "ブラインド解答の照合を完了できませんでした",
        issues: [issue],
        detail: { blind },
      },
      issues: [],
    };
  }

  const issues: Issue[] = [];
  for (const item of blind) {
    const location = loc(item.section_no, item.question_no);
    const isWordFill =
      items.find(
        (entry) =>
          entry.section_no === Number(item.section_no) &&
          entry.question_no === Number(item.question_no)
      )?.question_type === "word_fill";

    if (item.solvable === false) {
      issues.push({
        type: "blind_unsolvable",
        severity: "error",
        message: "問題文だけでは一意に解けません（条件不足の可能性）",
        location,
      });
    }
    const ambiguity = typeof item.ambiguity === "string" ? item.ambiguity.trim() : "";
    if (ambiguity) {
      issues.push({
        type: "blind_ambiguity",
        severity: "warning",
        message: `解釈の曖昧さ: ${ambiguity}`,
        location,
      });
    }

    if (isWordFill) {
      const alternatives = alternativesOf(item);
      if (item.unique === false || alternatives.length > 0) {
        issues.push({
          type: "word_fill_not_unique",
          severity: "error",
          message:
            alternatives.length > 0
              ? `正解が一意ではありません。別解候補: ${alternatives.join(" / ")}`
              : "文脈上、正解が一意に絞れません",
          location,
        });
      }
    }
  }
  for (const mismatch of mismatches) {
    const reason = typeof mismatch.reason === "string" ? mismatch.reason : "";
    if (!reason) continue;
    issues.push({
      type: "blind_mismatch",
      severity: "error",
      message: `ブラインド解答と不一致: ${reason}`,
      location: loc(mismatch.section_no, mismatch.question_no),
    });
  }
  for (const leak of leakage) {
    const reason = typeof leak.reason === "string" ? leak.reason : "";
    const word = typeof leak.word === "string" ? leak.word : "";
    if (!reason && !word) continue;
    issues.push({
      type: "word_fill_context_leak",
      severity: "error",
      message: `正解語句の露出: ${word}${reason ? `（${reason}）` : ""}`,
      location: loc(leak.section_no, leak.question_no),
    });
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  return {
    step: {
      iteration: 0,
      step: "D",
      status: errors.length === 0 ? "pass" : "fail",
      summary:
        errors.length === 0
          ? "ブラインド検算で解答の食い違い・語句の露出は検出されませんでした"
          : `ブラインド検算で${errors.length}件の不一致・条件不足・露出を検出しました`,
      issues,
      detail: { blind, mismatches, leakage },
    },
    issues,
  };
}
