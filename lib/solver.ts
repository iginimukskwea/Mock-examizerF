import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { aiJson, aiMode } from "./ai";
import { normalizeQuestionType, type ExamItem, type Issue, type VerificationStep } from "./types";

const SOLVER_SYSTEM_JS =
  "あなたは数学・理科の問題を検証するためのJavaScriptコードを生成する専門家です。外部モジュールを使わず、決定論的に計算するコードだけを書きます。";
const SOLVER_SYSTEM_PY =
  "あなたは数学・理科の問題をSymPyで検証するPythonコードを生成する専門家です。sympy, math, json, fractions だけを使い、決定論的に計算します。";

const BLOCKED_JS =
  /(require\s*\(|process\b|child_process|import\s*\(|globalThis|Function\s*\(|eval\s*\(|fetch\s*\(|XMLHttpRequest|while\s*\(\s*true)/;
const BLOCKED_PY =
  /(import\s+(os|sys|subprocess|socket|requests|shutil|pathlib|glob)|from\s+(os|sys|subprocess|socket|requests|shutil|pathlib|glob)\s+import|open\s*\(|eval\s*\(|exec\s*\(|__import__)/;

interface SolverItemResult {
  section_no?: unknown;
  question_no?: unknown;
  computed?: unknown;
  expected?: unknown;
  match?: unknown;
  error?: unknown;
}

interface SolverRun {
  ok: boolean;
  parsed?: unknown;
  code: string;
  stderr?: string;
  exitCode?: number | null;
}

interface PythonEnv {
  command: string;
  prefix: string[];
  available: boolean;
  sympy: boolean;
}

export interface StepOutcome {
  step: VerificationStep;
  issues: Issue[];
}

let pythonCache: PythonEnv | null = null;

function detectPython(): PythonEnv {
  if (pythonCache) return pythonCache;
  const candidates: Array<{ command: string; prefix: string[] }> =
    process.platform === "win32"
      ? [
          { command: "python", prefix: [] },
          { command: "py", prefix: ["-3"] },
          { command: "python3", prefix: [] },
        ]
      : [
          { command: "python3", prefix: [] },
          { command: "python", prefix: [] },
        ];

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(
        candidate.command,
        [...candidate.prefix, "-c", "import sympy; print('ok')"],
        { timeout: 5000, windowsHide: true, encoding: "utf8" }
      );
      if (probe.status === 0 && String(probe.stdout).includes("ok")) {
        pythonCache = { ...candidate, available: true, sympy: true };
        return pythonCache;
      }
      const basic = spawnSync(candidate.command, [...candidate.prefix, "--version"], {
        timeout: 3000,
        windowsHide: true,
        encoding: "utf8",
      });
      if (basic.status === 0) {
        pythonCache = { ...candidate, available: true, sympy: false };
        return pythonCache;
      }
    } catch {
      // 次の候補へ
    }
  }
  pythonCache = { command: "", prefix: [], available: false, sympy: false };
  return pythonCache;
}

function locationOf(sectionNo: unknown, questionNo: unknown): string {
  const section = Number(sectionNo);
  const question = Number(questionNo);
  if (!Number.isFinite(section) || !Number.isFinite(question)) return "ソルバー";
  return `第${section}問（${question}）`;
}

function skip(summary: string): StepOutcome {
  return {
    step: { iteration: 0, step: "A", status: "skip", summary, issues: [], detail: {} },
    issues: [],
  };
}

function warn(summary: string, message: string, detail: Record<string, unknown> = {}): StepOutcome {
  const issue: Issue = { type: "solver_unavailable", severity: "warning", message };
  return {
    step: { iteration: 0, step: "A", status: "warn", summary, issues: [issue], detail },
    issues: [],
  };
}

function compact(items: ExamItem[]) {
  return items.map((item) => ({
    section_no: item.section_no,
    question_no: item.question_no,
    body_latex: item.body_latex,
    answer_latex: item.answer_latex,
  }));
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  return JSON.parse(candidate);
}

async function runNodeSolver(targets: ExamItem[], subject: string): Promise<SolverRun> {
  const prompt = `次の模試の問題群を検証するJavaScriptコードを生成してください。

目的: 各問題の模範解答が、問題文から計算した結果と一致するかを決定論的に検証する。
教科: ${subject}

制約:
- Node.jsで単体実行できる同期コードのみ。require / import / process / eval / Function / ネットワーク / ファイルI/Oは禁止。
- 使用してよいのは Math, JSON, 配列, 数値計算のみ。
- 最後に必ず report({ results: [...] }) を1回だけ呼ぶ。
- 各要素は { section_no, question_no, computed, expected, match: boolean, error?: string }。
- 浮動小数の比較は 1e-6 の許容誤差を使う。
- 計算できない場合は error に日本語の理由を入れる。
- コードはフェンスで囲まず、本文のみ返す。

出力JSON:
{"code":"..."}

問題:
${JSON.stringify(compact(targets), null, 2)}`;

  let code = "";
  try {
    const generated = await aiJson<{ code?: unknown }>({
      system: SOLVER_SYSTEM_JS,
      prompt,
      maxTokens: 4096,
    });
    code = typeof generated.code === "string" ? generated.code : "";
  } catch (error) {
    return {
      ok: false,
      code: "",
      stderr: `ソルバー生成エラー: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!code.trim()) return { ok: false, code, stderr: "ソルバーがコードを返しませんでした" };
  if (BLOCKED_JS.test(code)) {
    return { ok: false, code, stderr: "禁止された構文が含まれています" };
  }

  let reported: unknown;
  try {
    const sandbox: Record<string, unknown> = {
      Math,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Set,
      Map,
      RegExp,
      BigInt,
      isNaN,
      isFinite,
      parseFloat,
      parseInt,
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      report: (value: unknown) => {
        reported = value;
      },
    };
    runInNewContext(code, sandbox, { timeout: 4000 });
  } catch (error) {
    return {
      ok: false,
      code,
      stderr: `実行エラー: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, code, parsed: reported };
}

async function runPythonSolver(targets: ExamItem[], subject: string): Promise<SolverRun> {
  const prompt = `次の模試の問題群を検証するPythonコードを生成してください。

目的: 各問題の模範解答が、問題文から計算した結果と一致するかをSymPyで決定論的に検証する。
教科: ${subject}

制約:
- 使用してよいのは sympy, math, json, fractions, decimal のみ。
- os / sys / subprocess / socket / requests / ファイルI/O / eval / exec / __import__ は禁止。
- 最後に必ず print(json.dumps({"results": [...]}, ensure_ascii=False)) を1回だけ実行する。
- 各要素は { section_no, question_no, computed, expected, match: boolean, error?: string }。
- 浮動小数の比較は 1e-9 の許容誤差を使う。
- 計算できない場合は error に日本語の理由を入れる。
- コードはフェンスで囲まず、本文のみ返す。

出力JSON:
{"code":"..."}

問題:
${JSON.stringify(compact(targets), null, 2)}`;

  let code = "";
  try {
    const generated = await aiJson<{ code?: unknown }>({
      system: SOLVER_SYSTEM_PY,
      prompt,
      maxTokens: 4096,
    });
    code = typeof generated.code === "string" ? generated.code : "";
  } catch (error) {
    return {
      ok: false,
      code: "",
      stderr: `Pythonソルバー生成エラー: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!code.trim()) return { ok: false, code, stderr: "Pythonソルバーがコードを返しませんでした" };
  if (BLOCKED_PY.test(code)) {
    return { ok: false, code, stderr: "Pythonコードに禁止された構文が含まれています" };
  }

  const env = detectPython();
  if (!env.available || !env.sympy) {
    return { ok: false, code, stderr: "Python/SymPyが利用できません" };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mef-solver-"));
  const scriptPath = path.join(dir, "solve.py");
  try {
    fs.writeFileSync(scriptPath, code, "utf8");
    const result = spawnSync(env.command, [...env.prefix, scriptPath], {
      timeout: 15000,
      windowsHide: true,
      encoding: "utf8",
      cwd: dir,
    });
    if (result.status !== 0) {
      return {
        ok: false,
        code,
        stderr: String(result.stderr || result.stdout || "").slice(0, 2000),
        exitCode: result.status,
      };
    }
    const parsed = extractJson(String(result.stdout ?? ""));
    return { ok: true, code, parsed };
  } catch (error) {
    return {
      ok: false,
      code,
      stderr: `Python実行エラー: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function buildOutcome(
  raw: unknown,
  engine: string,
  code: string,
  extraDetail: Record<string, unknown>
): StepOutcome | null {
  const parsed = (raw ?? null) as { results?: SolverItemResult[] } | null;
  if (!parsed || !Array.isArray(parsed.results)) return null;

  const issues: Issue[] = [];
  for (const result of parsed.results) {
    const location = locationOf(result.section_no, result.question_no);
    if (typeof result.error === "string" && result.error.trim()) {
      issues.push({
        type: "solver_compute_error",
        severity: "error",
        message: `計算エラー: ${result.error}`,
        location,
      });
      continue;
    }
    if (result.match === false) {
      issues.push({
        type: "solver_mismatch",
        severity: "error",
        message: `計算結果 ${String(result.computed)} が模範解答 ${String(
          result.expected
        )} と一致しません`,
        location,
      });
    }
  }

  const passed = issues.length === 0;
  return {
    step: {
      iteration: 0,
      step: "A",
      status: passed ? "pass" : "fail",
      summary: passed
        ? `${parsed.results.length}問の決定論的計算が模範解答と一致しました（${engine}）`
        : `${issues.length}件の計算不一致・エラーを検出しました（${engine}）`,
      issues,
      detail: { engine, code, results: parsed.results, ...extraDetail },
    },
    issues,
  };
}

export async function solverVerify(subject: string, items: ExamItem[]): Promise<StepOutcome> {
  if (aiMode() === "demo") {
    return skip("AI未設定のため決定論的ソルバー検証をスキップしました");
  }

  const targets = items.filter(
    (item) => normalizeQuestionType(item.question_type) === "calculation"
  );
  if (targets.length === 0) {
    return skip("語句補充・知識問題のみのため決定論的ソルバー検証をスキップしました");
  }

  const python = detectPython();
  const attempts: Array<Record<string, unknown>> = [];

  if (python.sympy) {
    const pythonRun = await runPythonSolver(targets, subject);
    attempts.push({
      engine: "python-sympy",
      ok: pythonRun.ok,
      stderr: pythonRun.stderr,
      exitCode: pythonRun.exitCode,
    });
    if (pythonRun.ok) {
      const outcome = buildOutcome(pythonRun.parsed, "python-sympy", pythonRun.code, {
        attempts,
      });
      if (outcome) return outcome;
      attempts.push({ engine: "python-sympy", ok: false, stderr: "出力形式が不正" });
    }
  } else {
    attempts.push({
      engine: "python-sympy",
      ok: false,
      stderr: python.available
        ? "SymPyが未導入のためNode.jsフォールバックを使用"
        : "Pythonが未導入のためNode.jsフォールバックを使用",
    });
  }

  const nodeRun = await runNodeSolver(targets, subject);
  attempts.push({
    engine: "node",
    ok: nodeRun.ok,
    stderr: nodeRun.stderr,
    exitCode: nodeRun.exitCode,
  });
  if (nodeRun.ok) {
    const outcome = buildOutcome(nodeRun.parsed, "node", nodeRun.code, { attempts });
    if (outcome) return outcome;
  }

  return warn(
    "計算ソルバーを実行できなかったため、決定論的検証を省略しました",
    `ソルバー実行エラー: ${nodeRun.stderr ?? "結果を取得できませんでした"}`,
    { attempts }
  );
}
