import { aiJson, aiMode, formatAiError } from "./ai";
import { countSubQuestions } from "./template";
import { solverVerify } from "./solver";
import { blindVerify } from "./blind";
import {
  normalizeDifficulty,
  normalizeQuestionType,
  type ExamItem,
  type GenerationMode,
  type Issue,
  type ProblemRow,
  type RunLog,
  type TemplateData,
  type VerificationStep,
} from "./types";
import { dedupeIssues, domainChecks, numericChecks, wordFillChecks } from "./validate";

export interface GenerateOptions {
  problems: ProblemRow[];
  template: TemplateData;
  subject: string;
  targetDifficulty: number;
  mode: GenerationMode;
  fields: Array<{ id: number; name: string }>;
  fieldIds: number[];
  sectionPools?: Array<{ problems: ProblemRow[]; count: number }>;
}

export interface GenerationOutcome {
  items: ExamItem[];
  avgDifficulty: number;
  runs: RunLog[];
  verificationLogs: VerificationStep[];
  warnings: string[];
  demo: boolean;
}

function averageDifficulty(items: Array<{ difficulty: number }>): number {
  if (items.length === 0) return 0;
  const sum = items.reduce((total, item) => total + item.difficulty, 0);
  return Math.round((sum / items.length) * 10) / 10;
}

export function selectProblems(
  problems: ProblemRow[],
  count: number,
  target: number
): ProblemRow[] | null {
  if (problems.length < count) return null;
  if (count === 0) return [];

  const sorted = [...problems].sort((a, b) => {
    const delta = Math.abs(a.difficulty - target) - Math.abs(b.difficulty - target);
    return delta !== 0 ? delta : a.id - b.id;
  });

  const chosen = sorted.slice(0, count);
  let pool = sorted.slice(count);
  const mean = (list: ProblemRow[]) =>
    list.reduce((total, problem) => total + problem.difficulty, 0) / list.length;

  for (let iteration = 0; iteration < 400; iteration += 1) {
    const current = mean(chosen);
    if (Math.abs(current - target) <= 0.999) break;

    let best: { index: number; candidate: ProblemRow; avg: number } | null = null;
    for (let index = 0; index < chosen.length; index += 1) {
      for (const candidate of pool) {
        const trial =
          current + (candidate.difficulty - chosen[index].difficulty) / chosen.length;
        if (Math.abs(trial - target) < Math.abs(current - target) - 1e-9) {
          if (!best || Math.abs(trial - target) < Math.abs(best.avg - target)) {
            best = { index, candidate, avg: trial };
          }
        }
      }
    }
    if (!best) break;
    const removed = chosen[best.index];
    chosen[best.index] = best.candidate;
    pool = pool.filter((problem) => problem.id !== best!.candidate.id);
    pool.push(removed);
  }

  return chosen;
}

function parseOptions(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((option): option is string => typeof option === "string")
      : [];
  } catch {
    return [];
  }
}

function layoutItems(problems: ProblemRow[], template: TemplateData): ExamItem[] {
  const items: ExamItem[] = [];
  let cursor = 0;

  outer: for (const section of template.sections) {
    for (const sub of section.subQuestions) {
      if (cursor >= problems.length) break outer;
      const problem = problems[cursor];
      cursor += 1;
      items.push({
        section_no: section.no,
        question_no: sub.no,
        difficulty: problem.difficulty,
        body_latex: problem.body_latex,
        answer_latex: problem.answer_latex,
        explanation_latex: problem.explanation_latex,
        origin: "original",
        problem_id: problem.id,
        question_type: normalizeQuestionType(problem.question_type),
        target_word: problem.target_word,
        options: parseOptions(problem.options_json),
      });
    }
  }

  return items;
}

function layoutSectionItems(
  sectionProblems: ProblemRow[][],
  template: TemplateData
): ExamItem[] {
  const items: ExamItem[] = [];
  template.sections.forEach((section, sectionIndex) => {
    const chosen = sectionProblems[sectionIndex] ?? [];
    section.subQuestions.forEach((sub, questionIndex) => {
      const problem = chosen[questionIndex];
      if (!problem) return;
      items.push({
        section_no: section.no,
        question_no: sub.no,
        difficulty: problem.difficulty,
        body_latex: problem.body_latex,
        answer_latex: problem.answer_latex,
        explanation_latex: problem.explanation_latex,
        origin: "original",
        problem_id: problem.id,
        question_type: normalizeQuestionType(problem.question_type),
        target_word: problem.target_word,
        options: parseOptions(problem.options_json),
      });
    });
  });
  return items;
}

function compactItems(items: ExamItem[]) {
  return items.map((item) => ({
    section_no: item.section_no,
    question_no: item.question_no,
    problem_id: item.problem_id,
    difficulty: item.difficulty,
    question_type: item.question_type ?? "calculation",
    target_word: item.target_word ?? "",
    options: item.options ?? [],
    body_latex: item.body_latex,
    answer_latex: item.answer_latex,
    explanation_latex: item.explanation_latex,
  }));
}

function itemLocation(item: ExamItem): string {
  return `第${item.section_no}問（${item.question_no}）`;
}

const GENERATION_SYSTEM =
  "あなたは日本の模試作成の専門家です。問題の数学的・科学的な整合性を最優先し、高校生が実際に解ける模試問題を作成します。";

function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) return "";
  return `\n前回の検算で以下の矛盾・不備が検出されました。必ずすべて修正してください:\n${issues
    .map((issue) => `- [${issue.location ?? "全体"}] ${issue.message}`)
    .join("\n")}`;
}

function templateTendency(options: GenerateOptions): Record<string, unknown> {
  return {
    difficulty_curve: options.template.difficultyCurve,
    scaffolding_type: options.template.scaffoldingType,
    answer_format_rules: options.template.answerFormatRules,
    preamble_conventions: options.template.preambleConventions,
    layout_density: options.template.layoutDensity,
  };
}

async function transformWithAI(
  options: GenerateOptions,
  baseItems: ExamItem[],
  feedback: Issue[]
): Promise<ExamItem[] | null> {
  const structure = options.template.sections.map((section) => ({
    section_no: section.no,
    title: section.title,
    points: section.points,
    subQuestions: section.subQuestions.map((sub) => ({
      question_no: sub.no,
      format: sub.format,
      points: sub.points,
    })),
  }));

  const hasWordFill = baseItems.some(
    (item) => normalizeQuestionType(item.question_type) === "word_fill"
  );
  const wordFillInstruction = hasWordFill
    ? `\n【語句補充の扱い】question_type=word_fill の問題では、正解語句(target_word)を維持したまま、リード文の具体例・切り口・英文構造を書き換えて新しい文脈の空所問題にしてください。選択式の場合は、空所と同じ品詞・時代区分・カテゴリーの紛らわしい誤答選択肢を再構成してください。正解語句を問題文・選択肢・解説にそのまま露出させないでください。`
    : "";

  const modeInstruction =
    options.mode === "numeric_variant"
      ? `【数違いモード】各問題の文章表現・出題意図・解法の構造はそのまま維持し、数値設定だけを変更してください。変更後の数値で必ず解答を計算し直し、条件を満たす解が存在することを確認してください。`
      : `【融合モード】指定分野（${options.fields.map((field) => field.name).join("、") || "指定なし"}）の問題群から相性の良い要素を組み合わせ、大問を再構築してください。各小問は「前の小問の答えを次の小問の条件として利用する」連鎖構成にし、数値も連鎖が成立するように再調整してください。`;

  const prompt = `模試を生成してください。

教科: ${options.subject}
目標難易度(1-5の平均): ${options.targetDifficulty}
出題モード: ${options.mode}
${modeInstruction}${wordFillInstruction}

問題冊子の傾向（難易度推移・誘導型・解答形式・前提・密度を必ず反映）:
${JSON.stringify(templateTendency(options), null, 2)}

テンプレート構造（この大問・小問の番号と数を厳守）:
${JSON.stringify(structure, null, 2)}

元になる問題（section_no/question_no/problem_id を維持したまま、各項目を変換）:
${JSON.stringify(compactItems(baseItems), null, 2)}

要件:
- 元の問題数・大問番号・小問番号・problem_id を変更しない
- 数式はLaTeX（$...$ / $$...$$）で記述する
- 全問題の難易度の平均が ${options.targetDifficulty} から±1.0以内になるよう difficulty を1〜5で設定する
- 解答(answer_latex)と解説(explanation_latex)は変換後の問題に対応させる
- 物理量・個数・確率などの数値は現実的かつ整合的にする
- scaffolding_type が numeric_chain の場合は前問の答えを次問で使い、lemma は補題を明示し、generalize は具体例から一般化し、independent は各小問を独立させる
- answer_format_rules の桁数・既約分数・根号簡約・記述指示を厳守する
- preamble_conventions の定数・有効数字・文字命名を用いる
- question_type を維持し、word_fill では target_word と options を更新する
- word_fill の正解語句を、同じ大問の他の問題文・選択肢・解説に露出させない
- 融合モードでは meta に {"uses_previous": true/false, "chain_note": "..."} を含める
${formatIssues(feedback)}

出力JSON:
{"items":[{"section_no":1,"question_no":1,"problem_id":12,"difficulty":3,"question_type":"calculation","target_word":"","options":[],"body_latex":"...","answer_latex":"...","explanation_latex":"...","meta":{}}],"notes":"..."}`;

  const result = await aiJson<{ items?: unknown[]; notes?: string }>({
    system: GENERATION_SYSTEM,
    prompt,
    maxTokens: 8192,
  });

  const rows = Array.isArray(result.items) ? result.items : [];
  if (rows.length === 0) return null;

  const aligned: ExamItem[] = [];
  for (let index = 0; index < baseItems.length; index += 1) {
    const base = baseItems[index];
    const raw = rows[index];
    if (!raw || typeof raw !== "object") {
      aligned.push(base);
      continue;
    }
    const row = raw as Record<string, unknown>;
    const questionType = normalizeQuestionType(row.question_type ?? base.question_type);
    const body =
      typeof row.body_latex === "string" && row.body_latex.trim()
        ? row.body_latex
        : base.body_latex;
    let answer = typeof row.answer_latex === "string" ? row.answer_latex : base.answer_latex;
    const explanation =
      typeof row.explanation_latex === "string"
        ? row.explanation_latex
        : base.explanation_latex;

    const rowTarget = typeof row.target_word === "string" ? row.target_word.trim() : "";
    const baseTarget = (base.target_word ?? "").trim();
    const targetWord =
      questionType === "word_fill"
        ? options.mode === "numeric_variant"
          ? baseTarget || rowTarget
          : rowTarget || baseTarget
        : null;

    const rowOptions = Array.isArray(row.options)
      ? row.options
          .map((option) => (typeof option === "string" ? option.trim() : ""))
          .filter(Boolean)
          .slice(0, 12)
      : [];
    const mergedOptions = rowOptions.length > 0 ? rowOptions : base.options ?? [];
    if (questionType === "word_fill" && targetWord && !answer.trim()) {
      answer = targetWord;
    }

    aligned.push({
      section_no: base.section_no,
      question_no: base.question_no,
      difficulty: normalizeDifficulty(row.difficulty, base.difficulty),
      body_latex: body,
      answer_latex: answer,
      explanation_latex: explanation,
      origin: options.mode === "fusion" ? "fusion_chain" : "numeric_variant",
      problem_id: base.problem_id,
      question_type: questionType,
      target_word: targetWord,
      options: mergedOptions,
      meta:
        row.meta && typeof row.meta === "object"
          ? (row.meta as Record<string, unknown>)
          : base.meta,
    });
  }
  return aligned;
}

function stepB(iteration: number, items: ExamItem[], template: TemplateData) {
  const issues = dedupeIssues([
    ...numericChecks(items),
    ...domainChecks(items, template),
    ...wordFillChecks(items),
  ]);
  const errors = issues.filter((issue) => issue.severity === "error");
  const step: VerificationStep = {
    iteration,
    step: "B",
    status: errors.length === 0 ? "pass" : "fail",
    summary:
      errors.length === 0
        ? "定義域・個数・確率・桁数などのドメイン制約を通過しました"
        : `${errors.length}件のドメイン制約違反を検出しました`,
    issues,
    detail: { checks: issues.length },
  };
  return { step, issues, errors };
}

function fusionBacktrackIssues(items: ExamItem[], upstream: Issue[]): Issue[] {
  const issues: Issue[] = [];
  const broken = new Set(
    upstream.filter((issue) => issue.severity === "error").map((issue) => issue.location)
  );

  for (let index = 1; index < items.length; index += 1) {
    const item = items[index];
    const previous = items[index - 1];
    if (item.section_no !== previous.section_no) continue;

    const meta = item.meta ?? {};
    const explicit = meta.uses_previous;
    const chained = explicit === true || (explicit !== false && item.question_no > 1);
    if (!chained) continue;

    const previousLocation = itemLocation(previous);
    const previousBroken =
      !previous.answer_latex.trim() || broken.has(previousLocation);
    if (previousBroken) {
      issues.push({
        type: "fusion_rollback",
        severity: "error",
        message: `小問（${item.question_no}）は小問（${previous.question_no}）の確定解に依存していますが、前段の解が未確定または破綻しています。小問（${previous.question_no}）の数値設定まで巻き戻して再生成してください。`,
        location: itemLocation(item),
      });
    }
  }
  return issues;
}

function logStep(
  logs: VerificationStep[],
  iteration: number,
  outcome: { step: VerificationStep }
): VerificationStep {
  const step: VerificationStep = { ...outcome.step, iteration };
  logs.push(step);
  return step;
}

function skipStep(iteration: number, step: string, summary: string): VerificationStep {
  return { iteration, step, status: "skip", summary, issues: [], detail: {} };
}

export async function generateExam(options: GenerateOptions): Promise<GenerationOutcome> {
  const required = countSubQuestions(options.template);
  let selected: ProblemRow[];
  let items: ExamItem[];

  if (options.sectionPools && options.sectionPools.length > 0) {
    const perSection: ProblemRow[][] = [];
    const usedProblemIds = new Set<number>();
    for (let index = 0; index < options.sectionPools.length; index += 1) {
      const pool = options.sectionPools[index];
      const available = pool.problems.filter(
        (problem) => !usedProblemIds.has(problem.id)
      );
      const chosen = selectProblems(
        available,
        pool.count,
        options.targetDifficulty
      );
      if (!chosen) {
        throw new Error(
          `第${index + 1}問は${pool.count}問必要ですが、未使用で条件に合う問題は${available.length}問です。問題データを追加するか、分野・参考書の条件を変更してください。`
        );
      }
      chosen.forEach((problem) => usedProblemIds.add(problem.id));
      perSection.push(chosen);
    }
    selected = perSection.flat();
    items = layoutSectionItems(perSection, options.template);
  } else {
    const scoped =
      options.mode === "fusion" && options.fieldIds.length > 0
        ? options.problems.filter(
            (problem) =>
              problem.field_id !== null && options.fieldIds.includes(problem.field_id)
          )
        : options.problems;

    const chosen = selectProblems(scoped, required, options.targetDifficulty);
    if (!chosen) {
      throw new Error(
        `問題数が不足しています。テンプレートは${required}問必要ですが、条件に合う問題は${scoped.length}問です。入力②で問題を追加してください。`
      );
    }
    selected = chosen;
    items = layoutItems(selected, options.template);
  }

  const runs: RunLog[] = [];
  const verificationLogs: VerificationStep[] = [];
  const warnings: string[] = [];

  const baseNumeric = dedupeIssues([
    ...numericChecks(items),
    ...domainChecks(items, options.template),
    ...wordFillChecks(items),
  ]);

  runs.push({
    iteration: 0,
    stage: "選定",
    message: `${required}問を選定しました（元の平均難易度 ${averageDifficulty(items).toFixed(1)}）`,
    issues: [],
  });
  verificationLogs.push({
    iteration: 0,
    step: "select",
    status: "pass",
    summary: `${required}問を選定（平均難易度 ${averageDifficulty(items).toFixed(1)}）`,
    issues: [],
    detail: {
      problemIds: selected.map((problem) => problem.id),
      baseChecks: baseNumeric.length,
    },
  });

  const baseErrors = baseNumeric.filter((issue) => issue.severity === "error");
  if (baseErrors.length > 0) {
    warnings.push(
      `元問題に${baseErrors.length}件の数値的な疑義があります（生成時に修正を試みます）。`
    );
  }

  if (aiMode() === "demo") {
    verificationLogs.push(skipStep(1, "A", "AI未設定のため決定論的ソルバー検証をスキップしました"));
    const b = stepB(1, items, options.template);
    verificationLogs.push(b.step);
    verificationLogs.push(skipStep(1, "C", "AI未設定のため融合バックトラックをスキップしました"));
    verificationLogs.push(skipStep(1, "D", "AI未設定のためブラインド検算をスキップしました"));
    verificationLogs.push({
      iteration: 1,
      step: "finalize",
      status: "warn",
      summary: "デモモードのため選定した問題をそのまま配置しました",
      issues: b.issues,
      detail: {},
    });

    runs.push({
      iteration: 1,
      stage: "数値検算",
      message: "AI未設定のため数値・ドメイン制約チェックのみ実行しました",
      issues: b.issues,
    });
    warnings.push(
      "AI未設定のデモモードです。数違い変換・融合再構成・決定論的ソルバー・ブラインド検算は行わず、選定した問題をそのままテンプレートに配置しています。.env.local にAPIキーを設定すると本来の生成・検算が有効になります。"
    );
    return {
      items,
      avgDifficulty: averageDifficulty(items),
      runs,
      verificationLogs,
      warnings,
      demo: true,
    };
  }

  let feedback: Issue[] = [];
  let best = items;
  let settled = false;
  let aiFailure: string | null = null;

  for (let iteration = 1; iteration <= 3; iteration += 1) {
    let transformed: ExamItem[] | null = null;
    try {
      transformed = await transformWithAI(options, items, feedback);
    } catch (error) {
      aiFailure = formatAiError(error);
      warnings.push(`AI生成に失敗しました: ${aiFailure}`);
      break;
    }
    if (!transformed) {
      aiFailure = "AIが有効な問題を返しませんでした（JSON形式または内容を確認してください）";
      warnings.push(`AI生成に失敗しました: ${aiFailure}`);
      break;
    }

    items = transformed;
    best = items;
    runs.push({
      iteration,
      stage: "生成",
      message:
        options.mode === "fusion"
          ? "融合モードで大問を再構成しました"
          : "数値設定を変更した問題を生成しました",
      issues: [],
    });

    const solver = await solverVerify(options.subject, items);
    const solverStep = logStep(verificationLogs, iteration, solver);

    const b = stepB(iteration, items, options.template);
    verificationLogs.push(b.step);

    let cIssues: Issue[] = [];
    if (options.mode === "fusion") {
      cIssues = fusionBacktrackIssues(items, [...solver.issues, ...b.issues]);
      verificationLogs.push({
        iteration,
        step: "C",
        status: cIssues.length === 0 ? "pass" : "fail",
        summary:
          cIssues.length === 0
            ? "融合連鎖の依存関係は成立しています"
            : `${cIssues.length}件の連鎖破綻を検出しました（前段へ巻き戻し）`,
        issues: cIssues,
        detail: {},
      });
    } else {
      verificationLogs.push(
        skipStep(iteration, "C", "数違いモードのため融合バックトラックは対象外です")
      );
    }

    const blocking = dedupeIssues([...solver.issues, ...b.errors, ...cIssues]);
    if (blocking.length > 0) {
      feedback = blocking;
      runs.push({
        iteration,
        stage: "検算",
        message: `Step A/B/C で${blocking.length}件の矛盾を検出し、再生成します`,
        issues: blocking,
      });
      continue;
    }

    const blind = await blindVerify(options.subject, items);
    logStep(verificationLogs, iteration, blind);
    const blindErrors = blind.issues.filter((issue) => issue.severity === "error");
    if (blindErrors.length > 0) {
      feedback = blindErrors;
      runs.push({
        iteration,
        stage: "検算",
        message: `Step D で${blindErrors.length}件の不一致を検出し、再生成します`,
        issues: blind.issues,
      });
      continue;
    }

    verificationLogs.push({
      iteration,
      step: "finalize",
      status: "pass",
      summary: `4段階検証を通過（平均難易度 ${averageDifficulty(items).toFixed(1)}）`,
      issues: blind.issues,
      detail: { solverStatus: solverStep.status },
    });
    runs.push({
      iteration,
      stage: "確定",
      message: `検算を通過（平均難易度 ${averageDifficulty(items).toFixed(1)}）`,
      issues: blind.issues,
    });
    settled = true;
    break;
  }

  if (!settled) {
    if (aiFailure) {
      warnings.push(
        `AI呼び出しに失敗したため、選定した元問題をそのまま保存しました。原因: ${aiFailure}`
      );
      runs.push({
        iteration: 3,
        stage: "打ち切り",
        message: "AI呼び出しに失敗しました",
        issues: feedback,
      });
      verificationLogs.push({
        iteration: 3,
        step: "finalize",
        status: "fail",
        summary: `AI呼び出しに失敗しました: ${aiFailure}`,
        issues: feedback,
        detail: {},
      });
    } else {
      warnings.push(
        "3回の再調整後も矛盾が残っています。最新案を保存しましたが、内容を必ず確認してください。"
      );
      runs.push({
        iteration: 3,
        stage: "打ち切り",
        message: "再生成の上限に達しました",
        issues: feedback,
      });
      verificationLogs.push({
        iteration: 3,
        step: "finalize",
        status: "fail",
        summary: "再生成の上限に達しました",
        issues: feedback,
        detail: {},
      });
    }
  }

  const avg = averageDifficulty(best);
  if (Math.abs(avg - options.targetDifficulty) > 1.0) {
    warnings.push(
      `最終的な平均難易度 ${avg} が目標 ${options.targetDifficulty} から±1.0を外れています。問題バンクの難易度構成を確認してください。`
    );
  }

  return { items: best, avgDifficulty: avg, runs, verificationLogs, warnings, demo: false };
}
