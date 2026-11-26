"use client";

import { useMemo, useState, type ReactNode } from "react";
import { MathText } from "./components/MathText";
import type { GeneratedProblem, Pair, Skipped } from "@/lib/types";

const MAX_FILES = 12;
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;
const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function Spinner() {
  return (
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
  );
}

type BadgeTone = "green" | "amber" | "red" | "zinc";

function Badge({
  children,
  tone = "zinc",
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  const tones: Record<BadgeTone, string> = {
    green:
      "border-emerald-500/35 bg-emerald-950/40 text-emerald-200",
    amber:
      "border-amber-500/35 bg-amber-950/40 text-amber-200",
    red: "border-red-500/40 bg-red-950/40 text-red-200",
    zinc: "border-zinc-700 bg-zinc-900 text-zinc-300",
  };
  return (
    <span
      className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function pairStatus(pair: Pair): { text: string; tone: BadgeTone } {
  if (pair.status === "matched") return { text: "解答あり", tone: "green" };
  if (pair.status === "order_matched")
    return { text: "順番で対応", tone: "amber" };
  return { text: "解答なし", tone: "red" };
}

export default function Page() {
  const [files, setFiles] = useState<File[]>([]);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [extractWarnings, setExtractWarnings] = useState<string[]>([]);
  const [problems, setProblems] = useState<GeneratedProblem[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [generateWarnings, setGenerateWarnings] = useState<string[]>([]);
  const [count, setCount] = useState(3);
  const [generatedCount, setGeneratedCount] = useState<number | null>(null);
  const [loading, setLoading] = useState<"extract" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openAnswers, setOpenAnswers] = useState<Record<number, boolean>>({});

  const usablePairs = useMemo(
    () =>
      pairs.filter(
        (pair) => pair.answer && pair.status === "matched"
      ),
    [pairs]
  );
  const orderMatchedCount = pairs.filter(
    (pair) => pair.status === "order_matched"
  ).length;
  const missingCount = pairs.filter(
    (pair) => pair.status === "missing_answer"
  ).length;

  function resetResults() {
    setPairs([]);
    setExtractWarnings([]);
    setProblems([]);
    setSkipped([]);
    setGenerateWarnings([]);
    setGeneratedCount(null);
    setOpenAnswers({});
  }

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    const next = [...files];

    for (const file of incoming) {
      const key = fileKey(file);
      if (next.some((current) => fileKey(current) === key)) continue;
      next.push(file);
    }

    if (next.length > MAX_FILES) {
      setError(`ファイルは最大${MAX_FILES}件までです。`);
      return;
    }
    const total = next.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      setError("ファイルの合計サイズは18MB以下にしてください。");
      return;
    }

    setError(null);
    setFiles(next);
    resetResults();
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
    resetResults();
  }

  async function extract() {
    if (files.length === 0) {
      setError("ファイルを選択してください。");
      return;
    }
    setLoading("extract");
    setError(null);
    resetResults();

    try {
      const form = new FormData();
      for (const file of files) form.append("files", file);

      const response = await fetch("/api/extract", {
        method: "POST",
        body: form,
      });
      const json = (await response.json()) as {
        pairs?: Pair[];
        warnings?: string[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(json.error ?? "抽出に失敗しました。");
      }
      setPairs(json.pairs ?? []);
      setExtractWarnings(json.warnings ?? []);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "抽出に失敗しました。"
      );
    } finally {
      setLoading(null);
    }
  }

  async function generate() {
    if (usablePairs.length === 0) {
      setError("解答が揃った問題ペアがありません。");
      return;
    }
    setLoading("generate");
    setError(null);
    setProblems([]);
    setSkipped([]);
    setGenerateWarnings([]);
    setGeneratedCount(null);
    setOpenAnswers({});

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairs: usablePairs, count }),
      });
      const json = (await response.json()) as {
        problems?: GeneratedProblem[];
        skipped?: Skipped[];
        warnings?: string[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(json.error ?? "類題の生成に失敗しました。");
      }
      setProblems(json.problems ?? []);
      setSkipped(json.skipped ?? []);
      setGenerateWarnings(json.warnings ?? []);
      setGeneratedCount(count);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "類題の生成に失敗しました。"
      );
    } finally {
      setLoading(null);
    }
  }

  function toggleAnswer(index: number) {
    setOpenAnswers((current) => ({
      ...current,
      [index]: !current[index],
    }));
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-10 sm:py-14">
      <header className="mb-8">
        <p className="text-xs font-semibold text-red-400">
          数学参考書の数値替えテスト
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-zinc-50">
          数値替えテスト作成
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400">
          参考書の問題・解答の画像またはPDFをアップロードすると、Geminiが問題と解答を自動でペアリングし、数値を変えた類題を指定問題数だけ生成します。
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="mb-5 rounded-xl border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm leading-6 text-red-200"
        >
          {error}
        </div>
      ) : null}

      <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">
              1. 問題・解答をアップロード
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              問題と解答は別ファイルでもまとめて選択できます。
            </p>
          </div>
          <span className="text-xs text-zinc-500">
            {files.length} / {MAX_FILES}件
          </span>
        </div>

        <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-zinc-900/30 px-6 py-10 text-center transition hover:border-red-500/60 hover:bg-red-950/10">
          <span className="text-sm font-semibold text-zinc-200">
            クリックしてファイルを選択
          </span>
          <span className="mt-1 text-xs text-zinc-500">
            PDF / PNG / JPEG / WebP（最大12件・合計18MB）
          </span>
          <input
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </label>

        {files.length > 0 ? (
          <ul className="mt-4 divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/40">
            {files.map((file, index) => (
              <li
                key={fileKey(file)}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-200">
                    {file.name}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {formatBytes(file.size)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  className="inline-flex h-9 shrink-0 items-center rounded-lg border border-zinc-700 px-3 text-xs font-medium text-zinc-300 transition hover:border-red-500/50 hover:bg-red-950/30 hover:text-red-200"
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={extract}
            disabled={files.length === 0 || loading !== null}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-red-600 px-6 text-base font-bold text-white shadow-lg shadow-red-950/50 transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading === "extract" ? <Spinner /> : null}
            {loading === "extract" ? "抽出中..." : "抽出してペアリング"}
          </button>
          <p className="text-xs leading-5 text-zinc-500">
            APIキーは <code className="text-zinc-300">math-variant-app/.env.local</code> の
            <code className="ml-1 text-zinc-300">GEMINI_API_KEY</code> を使用します。
          </p>
        </div>
      </section>

      {pairs.length > 0 ? (
        <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">
                2. ペアリング確認
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                問題 {pairs.length}件 / 番号一致 {usablePairs.length}件
                {orderMatchedCount > 0
                  ? ` / 順番対応 ${orderMatchedCount}件`
                  : ""}
                {missingCount > 0 ? ` / 解答なし ${missingCount}件` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="green">番号一致 {usablePairs.length}</Badge>
              {orderMatchedCount > 0 ? (
                <Badge tone="amber">順番対応 {orderMatchedCount}</Badge>
              ) : null}
              {missingCount > 0 ? (
                <Badge tone="red">解答なし {missingCount}</Badge>
              ) : null}
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {pairs.map((pair, index) => {
              const status = pairStatus(pair);
              return (
                <article
                  key={`${pair.key}-${index}`}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-zinc-100">
                          {pair.problem.number || pair.key}
                        </h3>
                        {pair.figureOnly ? (
                          <Badge tone="zinc">図形必須</Badge>
                        ) : null}
                      </div>
                      {pair.problem.title ? (
                        <p className="mt-0.5 text-xs text-zinc-500">
                          {pair.problem.title}
                        </p>
                      ) : null}
                      {pair.problem.source_file ? (
                        <p className="mt-1 text-[11px] text-zinc-600">
                          {pair.problem.source_file}
                        </p>
                      ) : null}
                    </div>
                    <Badge tone={status.tone}>{status.text}</Badge>
                  </div>

                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div>
                      <p className="mb-1 text-[11px] font-medium text-zinc-500">
                        問題
                      </p>
                      <div className="max-h-44 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                        <MathText
                          text={pair.problem.body_latex}
                          className="text-sm text-zinc-200"
                        />
                      </div>
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-medium text-zinc-500">
                        解答
                      </p>
                      {pair.answer ? (
                        <div className="max-h-44 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                          <MathText
                            text={pair.answer.body_latex}
                            className="text-sm text-zinc-300"
                          />
                        </div>
                      ) : (
                        <div className="rounded-lg border border-red-500/30 bg-red-950/20 p-3 text-sm text-red-200">
                          解答が見つかりません
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {extractWarnings.length > 0 ? (
            <div className="mt-4 space-y-2">
              {extractWarnings.map((warning, index) => (
                <div
                  key={index}
                  className="rounded-lg border border-amber-500/30 bg-amber-950/25 px-3 py-2 text-xs leading-6 text-amber-100"
                >
                  {warning}
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap items-end gap-4 border-t border-zinc-800 pt-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-400">
                作成する問題数
              </span>
              <input
                type="number"
                min={1}
                max={10}
                value={count}
                onChange={(event) =>
                  setCount(
                    Math.min(10, Math.max(1, Number(event.target.value) || 1))
                  )
                }
                className="h-12 w-24 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-center text-lg font-semibold text-zinc-100 outline-none transition focus:border-red-500"
              />
            </label>
            <button
              type="button"
              onClick={generate}
              disabled={usablePairs.length === 0 || loading !== null}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-red-600 px-6 text-base font-bold text-white shadow-lg shadow-red-950/50 transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading === "generate" ? <Spinner /> : null}
              {loading === "generate" ? "生成中..." : "類題を生成"}
            </button>
            <p className="max-w-xs text-xs leading-5 text-zinc-500">
              番号一致した {usablePairs.length} 問から、数式のみで完結する問題を優先して最大 {count} 問を生成します。順番対応のペアは生成に使用しません。
            </p>
          </div>

          {usablePairs.length === 0 ? (
            <p className="mt-3 text-xs leading-6 text-red-200">
              番号一致した問題ペアがありません。
              {orderMatchedCount > 0
                ? "「順番で対応」のペアは生成対象外です。問題番号が読み取れる画像をアップロードしてください。"
                : "解答ページもアップロードしてください。"}
            </p>
          ) : null}
        </section>
      ) : null}

      {problems.length > 0 ? (
        <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">
                3. 数値替えテスト
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                {problems.length}問 / 指定 {generatedCount ?? count}問
              </p>
            </div>
            <Badge tone="green">{problems.length}問を生成</Badge>
          </div>

          {generateWarnings.length > 0 ? (
            <div className="mt-3 space-y-2">
              {generateWarnings.map((warning, index) => (
                <div
                  key={index}
                  className="rounded-lg border border-amber-500/30 bg-amber-950/25 px-3 py-2 text-xs leading-6 text-amber-100"
                >
                  {warning}
                </div>
              ))}
            </div>
          ) : null}

          <ol className="mt-4 space-y-4">
            {problems.map((problem, index) => (
              <li
                key={index}
                className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-red-400">
                      問題 {index + 1}
                    </p>
                    {problem.title ? (
                      <h3 className="mt-1 text-base font-semibold text-zinc-100">
                        {problem.title}
                      </h3>
                    ) : null}
                  </div>
                  {problem.source_number ? (
                    <Badge tone="zinc">元: {problem.source_number}</Badge>
                  ) : null}
                </div>

                <MathText
                  text={problem.body_latex}
                  className="mt-3 text-[15px] text-zinc-100"
                />

                <button
                  type="button"
                  onClick={() => toggleAnswer(index)}
                  aria-expanded={Boolean(openAnswers[index])}
                  className="mt-4 inline-flex h-10 items-center rounded-lg border border-zinc-700 px-4 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
                >
                  {openAnswers[index]
                    ? "解答・解説を閉じる"
                    : "解答・解説を表示する"}
                </button>

                {openAnswers[index] ? (
                  <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                    <p className="text-[11px] font-medium text-zinc-500">
                      解答
                    </p>
                    <MathText
                      text={problem.answer_latex}
                      className="mt-1 text-[15px] text-zinc-100"
                    />
                    {problem.explanation_latex ? (
                      <>
                        <p className="mt-4 text-[11px] font-medium text-zinc-500">
                          解説
                        </p>
                        <MathText
                          text={problem.explanation_latex}
                          className="mt-1 text-sm text-zinc-300"
                        />
                      </>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>

          {skipped.length > 0 ? (
            <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-950/20 p-4">
              <h3 className="text-sm font-semibold text-amber-200">
                スキップされた問題
              </h3>
              <ul className="mt-2 space-y-1 text-xs leading-6 text-amber-100/80">
                {skipped.map((item, index) => (
                  <li key={index}>
                    {item.source_number || "元問題"}: {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <p className="mt-10 text-center text-xs leading-6 text-zinc-600">
        GEMINI_API_KEY はサーバー側でのみ使用されます。アップロードした画像・PDFはGemini APIへ送信されます。
      </p>
    </main>
  );
}
