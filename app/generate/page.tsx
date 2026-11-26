"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { downloadPdf, safeFilename } from "@/app/components/downloadPdf";
import { ComboBox } from "@/app/components/ComboBox";
import {
  DownloadIcon,
  PlayIcon,
  PlusIcon,
} from "@/app/components/icons";
import { useInputHistories } from "@/app/components/useInputHistories";
import {
  GENERATION_MODE_LABELS,
  SUBJECTS,
  type ExamItem,
  type GenerationMode,
  type RunLog,
  type VerificationStatus,
  type VerificationStep,
} from "@/lib/types";

interface FieldOption {
  id: number;
  name: string;
  subject: string | null;
  problem_count: number;
}

interface BookOption {
  name: string;
  problem_count: number;
  cover_image_path: string | null;
  subject: string | null;
}

interface SectionSetting {
  questionCount: number;
  field: string;
}

interface GenerationResult {
  examId: number;
  title: string;
  avgDifficulty: number;
  targetDifficulty: number;
  demo: boolean;
  warnings: string[];
  runs: RunLog[];
  verificationLogs?: VerificationStep[];
  items: ExamItem[];
  sections?: SectionSetting[];
  pdf: { question: string; answer: string };
}

interface GenerationJobConfig {
  subject: string;
  books: string[];
  sections: SectionSetting[];
  targetDifficulty: number;
  mode: GenerationMode;
  title?: string;
}

type GenerationJobStatus = "waiting" | "running" | "done" | "error";

interface GenerationJob {
  id: string;
  config: GenerationJobConfig;
  status: GenerationJobStatus;
  message?: string;
  result?: GenerationResult;
}

interface AlertState {
  kind: "success" | "error" | "info" | "warn";
  text: string;
}

const ORIGIN_LABELS: Record<string, string> = {
  original: "原本",
  numeric_variant: "数違い",
  fusion_chain: "融合連鎖",
};

const STEP_LABELS: Record<string, string> = {
  select: "選定",
  A: "Step A 決定論的ソルバー",
  B: "Step B ドメイン制約",
  C: "Step C 融合バックトラック",
  D: "Step D ブラインド検算",
  finalize: "確定",
};

const STATUS_LABELS: Record<VerificationStatus, string> = {
  pass: "通過",
  fail: "要修正",
  warn: "注意",
  skip: "対象外",
};

const DIFFICULTY_OPTIONS = Array.from({ length: 9 }, (_, index) =>
  (1 + index * 0.5).toFixed(1)
);

const GENERATION_STATUS_LABELS: Record<GenerationJobStatus, string> = {
  waiting: "予約待ち",
  running: "生成中",
  done: "完了",
  error: "エラー",
};

function generationStatusBadgeClass(status: GenerationJobStatus): string {
  if (status === "done") return "badge-green";
  if (status === "error") return "badge-red";
  if (status === "running") return "badge-amber";
  return "";
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => (value ?? "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, "ja"));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function GeneratePage() {
  const { histories, refresh: refreshHistories } = useInputHistories();

  const [books, setBooks] = useState<BookOption[]>([]);
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [subject, setSubject] = useState("");
  const [selectedBooks, setSelectedBooks] = useState<string[]>([]);
  const [sections, setSections] = useState<SectionSetting[]>([
    { questionCount: 3, field: "" },
  ]);
  const [targetText, setTargetText] = useState("3.0");
  const [mode, setMode] = useState<GenerationMode>("numeric_variant");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState<"question" | "answer" | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [resultMode, setResultMode] =
    useState<GenerationMode>("numeric_variant");
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [generationQueue, setGenerationQueue] = useState<GenerationJob[]>([]);
  const generationQueueRef = useRef<GenerationJob[]>([]);
  const generationProcessingRef = useRef(false);

  const refreshOptions = useCallback(async () => {
    const [booksResponse, fieldsResponse] = await Promise.all([
      fetch("/api/books", { cache: "no-store" }),
      fetch("/api/fields", { cache: "no-store" }),
    ]);
    const booksJson = (await booksResponse.json()) as {
      books?: BookOption[];
    };
    const fieldsJson = (await fieldsResponse.json()) as {
      fields?: FieldOption[];
    };
    setBooks(booksJson.books ?? []);
    setFields(fieldsJson.fields ?? []);
  }, []);

  useEffect(() => {
    refreshOptions().catch(() => undefined);
  }, [refreshOptions]);

  const subjectOptions = useMemo(
    () =>
      uniqueStrings([
        ...SUBJECTS,
        ...(histories.subject ?? []),
      ]),
    [histories.subject]
  );
  const fieldOptions = useMemo(
    () =>
      uniqueStrings([
        ...fields.map((field) => field.name),
        ...(histories.field ?? []),
      ]),
    [fields, histories.field]
  );
  const difficultyOptions = useMemo(
    () =>
      uniqueStrings([
        ...DIFFICULTY_OPTIONS,
        ...(histories.difficulty ?? []),
      ]),
    [histories.difficulty]
  );

  const totalQuestions = useMemo(
    () => sections.reduce((sum, section) => sum + section.questionCount, 0),
    [sections]
  );

  const grouped = useMemo(() => {
    if (!result) return [] as Array<[number, ExamItem[]]>;
    const map = new Map<number, ExamItem[]>();
    for (const item of result.items) {
      const list = map.get(item.section_no) ?? [];
      list.push(item);
      map.set(item.section_no, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [result]);

  function setSectionCount(value: number) {
    const next = clamp(value, 1, 6);
    setSections((current) =>
      Array.from({ length: next }, (_, index) =>
        current[index] ?? { questionCount: 3, field: "" }
      )
    );
  }

  function updateSection(index: number, patch: Partial<SectionSetting>) {
    setSections((current) =>
      current.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, ...patch } : section
      )
    );
  }

  function toggleBook(name: string) {
    setSelectedBooks((current) =>
      current.includes(name)
        ? current.filter((book) => book !== name)
        : [...current, name]
    );
  }

  function sectionLabel(sectionNo: number): string {
    const setting = result?.sections?.[sectionNo - 1] ?? sections[sectionNo - 1];
    return setting?.field
      ? `第${sectionNo}問 ${setting.field}`
      : `第${sectionNo}問`;
  }

  function updateGenerationQueue(
    updater: (current: GenerationJob[]) => GenerationJob[]
  ) {
    const next = updater(generationQueueRef.current);
    generationQueueRef.current = next;
    setGenerationQueue(next);
  }

  async function runGenerationJob(
    job: GenerationJob
  ): Promise<GenerationResult> {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: job.config.subject,
        books: job.config.books,
        sections: job.config.sections.map((section) => ({
          questionCount: section.questionCount,
          field: section.field.trim(),
        })),
        targetDifficulty: job.config.targetDifficulty,
        mode: job.config.mode,
        title: job.config.title,
      }),
    });
    const json = (await response.json()) as GenerationResult & {
      error?: string;
    };
    if (!response.ok || !json.items) {
      throw new Error(json.error ?? "生成に失敗しました");
    }
    return json;
  }

  async function processGenerationQueue() {
    if (generationProcessingRef.current) return;
    generationProcessingRef.current = true;
    setBusy(true);

    try {
      while (true) {
        const job = generationQueueRef.current.find(
          (item) => item.status === "waiting"
        );
        if (!job) break;

        updateGenerationQueue((current) =>
          current.map((item) =>
            item.id === job.id
              ? { ...item, status: "running", message: "" }
              : item
          )
        );

        try {
          const json = await runGenerationJob(job);
          updateGenerationQueue((current) =>
            current.map((item) =>
              item.id === job.id
                ? { ...item, status: "done", result: json }
                : item
            )
          );
          setResult(json);
          setResultMode(job.config.mode);
          await refreshHistories();
          const warnings = json.warnings ?? [];
          const stepWarnings = (json.verificationLogs ?? []).some(
            (log) => log.status === "warn" || log.status === "fail"
          );
          setAlert(
            json.demo
              ? {
                  kind: "warn",
                  text: `模試を生成しました（デモモード / 平均難易度 ${json.avgDifficulty}）。`,
                }
              : warnings.length > 0 || stepWarnings
                ? {
                    kind: "warn",
                    text: `模試を生成しましたが、警告または未完了の検算があります（平均難易度 ${json.avgDifficulty}）。下記を確認してください。`,
                  }
                : {
                    kind: "success",
                    text: `模試を生成し検算を完了しました（平均難易度 ${json.avgDifficulty}）。`,
                  }
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "生成に失敗しました";
          updateGenerationQueue((current) =>
            current.map((item) =>
              item.id === job.id
                ? { ...item, status: "error", message }
                : item
            )
          );
          setAlert({ kind: "error", text: message });
        }
      }
    } finally {
      generationProcessingRef.current = false;
      setBusy(false);
      if (
        generationQueueRef.current.some(
          (item) => item.status === "waiting"
        )
      ) {
        void processGenerationQueue();
      }
    }
  }

  function enqueueGeneration() {
    if (!subject.trim()) {
      setAlert({ kind: "error", text: "教科を選択または入力してください。" });
      return;
    }
    const config: GenerationJobConfig = {
      subject: subject.trim(),
      books: [...selectedBooks],
      sections: sections.map((section) => ({
        ...section,
        field: section.field.trim(),
      })),
      targetDifficulty: clamp(Number(targetText) || 3, 1, 5),
      mode,
      title: title.trim() || undefined,
    };
    const job: GenerationJob = {
      id: crypto.randomUUID(),
      config,
      status: "waiting",
    };
    updateGenerationQueue((current) => [...current, job]);
    setAlert({
      kind: "info",
      text: `「${config.subject}」の模試生成を予約しました。上から順に処理します。`,
    });
    void processGenerationQueue();
  }

  async function download(kind: "question" | "answer") {
    if (!result) return;
    setPdfBusy(kind);
    try {
      await downloadPdf(
        result.pdf[kind],
        `${safeFilename(result.title)}-${kind === "question" ? "問題" : "解答解説"}.pdf`
      );
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "PDFの生成に失敗しました",
      });
    } finally {
      setPdfBusy(null);
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="page-title">模試生成（形式指定）</h1>
        <p className="page-desc">
          問題バンクから、教科・参考書・大問数・各小問数・分野・難易度平均を直接指定して模試を生成します。
          数違い・融合・語句補充の改変と検算を経て、問題PDF・解答PDFを出力します。
        </p>
      </div>

      {alert ? <div className={`alert alert-${alert.kind}`}>{alert.text}</div> : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">出題形式の指定</h2>
            <p className="panel-sub">
              大問数を変更すると、下の大問ごとの設定欄が増減します。
            </p>
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label className="label" htmlFor="gen-subject">
              教科<span className="req">*</span>
            </label>
            <ComboBox
              id="gen-subject"
              value={subject}
              onChange={setSubject}
              options={subjectOptions}
              placeholder="例：数学ⅠA"
              required
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="gen-target">
              難易度平均（1.0〜5.0）
            </label>
            <ComboBox
              id="gen-target"
              value={targetText}
              onChange={setTargetText}
              options={difficultyOptions}
              placeholder="3.0"
            />
            <span className="hint">
              1.0=基礎 / 3.0=標準 / 5.0=難関。平均がこの値に近くなるよう選定します。
            </span>
          </div>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <span className="label">生成モード</span>
          <div className="btn-row">
            <button
              type="button"
              className={`chip ${mode === "numeric_variant" ? "selected" : ""}`}
              onClick={() => setMode("numeric_variant")}
            >
              数違い
            </button>
            <button
              type="button"
              className={`chip ${mode === "fusion" ? "selected" : ""}`}
              onClick={() => setMode("fusion")}
            >
              融合
            </button>
          </div>
          <span className="hint">
            {mode === "numeric_variant"
              ? "文章・意図・解法構造を維持して数値を変更します。語句補充は文脈をパラフレーズします。"
              : "選択した分野の要素を組み合わせ、前の小問を次で使う連鎖的な大問に再構成します。"}
          </span>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <span className="label">参照する参考書（複数可）</span>
          {books.length === 0 ? (
            <span className="hint">
              参考書が未登録です。
              <Link href="/problems" style={{ textDecoration: "underline" }}>
                問題データ
              </Link>
              から取り込んでください。
            </span>
          ) : (
            <div className="btn-row">
              {books.map((book) => {
                const selected = selectedBooks.includes(book.name);
                return (
                  <span
                    key={book.name}
                    className={`chip ${selected ? "selected" : ""}`}
                    onClick={() => toggleBook(book.name)}
                  >
                    {book.cover_image_path ? (
                      <img
                        className="chip-cover"
                        src={book.cover_image_path}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <span className="chip-cover chip-cover-placeholder">
                        本
                      </span>
                    )}
                    {book.name}
                    <span style={{ opacity: 0.7 }}>{book.problem_count}</span>
                  </span>
                );
              })}
            </div>
          )}
          <span className="hint">
            {selectedBooks.length === 0
              ? "未選択の場合は、指定した教科の全問題から選定します。"
              : `${selectedBooks.length}冊の参考書を参照します。`}
          </span>
        </div>

        <div className="grid-2" style={{ marginTop: 14 }}>
          <div className="field">
            <label className="label" htmlFor="section-count">
              大問数
            </label>
            <select
              id="section-count"
              className="select"
              value={sections.length}
              onChange={(event) => setSectionCount(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6].map((count) => (
                <option key={count} value={count}>
                  {count}大問
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="gen-title">
              模試タイトル（任意）
            </label>
            <input
              id="gen-title"
              className="input"
              value={title}
              placeholder="未入力の場合は「教科 模試（形式指定）」"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
        </div>

        <div className="stack" style={{ marginTop: 14 }}>
          {sections.map((section, index) => (
            <div className="section-card" key={index}>
              <div className="section-card-head">
                <span className="badge badge-red">第{index + 1}問</span>
                <span className="list-meta">
                  小問 {section.questionCount}問
                </span>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="label">問題数（小問数）</label>
                  <select
                    className="select"
                    value={section.questionCount}
                    onChange={(event) =>
                      updateSection(index, {
                        questionCount: Number(event.target.value),
                      })
                    }
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((count) => (
                      <option key={count} value={count}>
                        {count}問
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="label">分野</label>
                  <ComboBox
                    value={section.field}
                    onChange={(value) => updateSection(index, { field: value })}
                    options={fieldOptions}
                    placeholder="例：2次関数（未指定なら全分野）"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-action"
            onClick={enqueueGeneration}
            disabled={!subject.trim()}
          >
            {busy ? <PlusIcon /> : <PlayIcon />}
            {busy ? "生成を予約する" : "この形式で模試を生成"}
          </button>
          <span className="hint">
            合計 {totalQuestions}問 / 平均難易度 {clamp(Number(targetText) || 3, 1, 5).toFixed(1)}
          </span>
        </div>
        {busy ? (
          <p className="hint" style={{ marginTop: 8 }}>
            現在の生成が終わると、予約した形式を上から順に処理します。画面を閉じずにお待ちください。
          </p>
        ) : null}
      </section>

      {generationQueue.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">
                生成予約キュー（{generationQueue.length}件）
              </h2>
              <p className="panel-sub">
                生成中でも次の形式を予約できます。上から順に処理します。
              </p>
            </div>
            <div className="btn-row">
              {busy ? (
                <span className="badge badge-amber">生成中</span>
              ) : null}
              <button
                className="btn btn-sm btn-ghost"
                onClick={() =>
                  updateGenerationQueue((current) =>
                    current.filter(
                      (job) =>
                        job.status === "waiting" ||
                        job.status === "running"
                    )
                  )
                }
                disabled={
                  !generationQueue.some(
                    (job) => job.status === "done" || job.status === "error"
                  )
                }
              >
                完了・エラーをクリア
              </button>
            </div>
          </div>
          <div className="stack">
            {generationQueue.map((job) => (
              <div className="list-item" key={job.id}>
                <div className="list-item-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="list-title">
                      {job.config.title ||
                        `${job.config.subject} 模試（形式指定）`}
                    </div>
                    <div className="list-meta">
                      {job.config.subject} /{" "}
                      {GENERATION_MODE_LABELS[job.config.mode]} /{" "}
                      {job.config.sections.length}大問 / 難易度{" "}
                      {job.config.targetDifficulty.toFixed(1)}
                      {job.config.books.length > 0
                        ? ` / ${job.config.books.length}冊`
                        : ""}
                    </div>
                  </div>
                  <div className="btn-row">
                    <span
                      className={`badge ${generationStatusBadgeClass(
                        job.status
                      )}`}
                    >
                      {GENERATION_STATUS_LABELS[job.status]}
                    </span>
                    {job.status === "waiting" ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          updateGenerationQueue((current) =>
                            current.filter((item) => item.id !== job.id)
                          )
                        }
                      >
                        予約取消
                      </button>
                    ) : null}
                    {job.status === "done" && job.result ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setResult(job.result!);
                          setResultMode(job.config.mode);
                        }}
                      >
                        結果を表示
                      </button>
                    ) : null}
                  </div>
                </div>
                {job.status === "error" && job.message ? (
                  <div className="list-meta text-danger">{job.message}</div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {result ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">{result.title}</h2>
              <p className="panel-sub">
                {GENERATION_MODE_LABELS[resultMode]}モード / 全
                {result.items.length}問
              </p>
            </div>
            <div className="btn-row">
              {result.demo ? (
                <span className="badge badge-amber">デモ生成</span>
              ) : (
                <span className="badge badge-green">検算済み</span>
              )}
              <button
                className="btn btn-download"
                onClick={() => download("question")}
                disabled={pdfBusy !== null}
              >
                {pdfBusy === "question" ? (
                  <span className="spinner spinner-dark" />
                ) : (
                  <DownloadIcon />
                )}
                {pdfBusy === "question" ? "PDF生成中..." : "問題PDF"}
              </button>
              <button
                className="btn btn-download"
                onClick={() => download("answer")}
                disabled={pdfBusy !== null}
              >
                {pdfBusy === "answer" ? (
                  <span className="spinner spinner-dark" />
                ) : (
                  <DownloadIcon />
                )}
                {pdfBusy === "answer" ? "PDF生成中..." : "解答PDF"}
              </button>
            </div>
          </div>

          <div className="stats">
            <div className="stat">
              <div className="stat-value accent">
                {result.avgDifficulty.toFixed(1)}
              </div>
              <div className="stat-label">実際の平均難易度</div>
            </div>
            <div className="stat">
              <div className="stat-value">{result.targetDifficulty}</div>
              <div className="stat-label">目標難易度</div>
            </div>
            <div className="stat">
              <div className="stat-value">{result.items.length}</div>
              <div className="stat-label">出題数</div>
            </div>
          </div>

          {result.warnings.map((warning, index) => (
            <div className="alert alert-warn" key={index}>
              {warning}
            </div>
          ))}

          <div className="divider" />
          <h3 className="panel-title" style={{ marginBottom: 10 }}>
            検算ログ（Step A〜D）
          </h3>
          {result.verificationLogs && result.verificationLogs.length > 0 ? (
            <div className="pipeline">
              {result.verificationLogs.map((log, index) => {
                const code =
                  typeof log.detail?.code === "string"
                    ? (log.detail.code as string)
                    : null;
                const results =
                  log.detail?.results !== undefined
                    ? JSON.stringify(log.detail.results, null, 2)
                    : null;
                return (
                  <div className="step-card" key={index}>
                    <div className="step-head">
                      <span className="step-label">
                        #{log.iteration} {STEP_LABELS[log.step] ?? log.step}
                      </span>
                      <span className={`step-badge ${log.status}`}>
                        {STATUS_LABELS[log.status] ?? log.status}
                      </span>
                    </div>
                    <div className="step-summary">{log.summary}</div>
                    {log.issues.length > 0 ? (
                      <div style={{ marginTop: 6 }}>
                        {log.issues.map((issue, issueIndex) => (
                          <div
                            className={`issue ${issue.severity}`}
                            key={issueIndex}
                          >
                            {issue.location ? `[${issue.location}] ` : ""}
                            {issue.message}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {code ? (
                      <details className="step-detail">
                        <summary>検証コード / 出力を見る</summary>
                        <pre>
                          {code}
                          {results ? `\n\n// results\n${results}` : ""}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="stack">
              {result.runs.map((run, index) => (
                <div className="verification-run" key={index}>
                  <div className="list-item-head">
                    <span className="list-title">
                      #{run.iteration} [{run.stage}]
                    </span>
                    <span className="badge">{run.issues.length}件の指摘</span>
                  </div>
                  <div className="list-meta">{run.message}</div>
                  {run.issues.map((issue, issueIndex) => (
                    <div className={`issue ${issue.severity}`} key={issueIndex}>
                      {issue.location ? `[${issue.location}] ` : ""}
                      {issue.message}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {result ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">出題内容プレビュー</h2>
              <p className="panel-sub">
                平均難易度 {result.avgDifficulty.toFixed(1)}（目標{" "}
                {result.targetDifficulty}）
              </p>
            </div>
            <Link className="btn btn-sm btn-ghost" href="/history">
              履歴で見る
            </Link>
          </div>

          <div className="stack">
            {grouped.map(([sectionNo, items]) => (
              <div key={sectionNo}>
                <div className="list-title" style={{ marginBottom: 8 }}>
                  {sectionLabel(sectionNo)}
                  <span className="badge" style={{ marginLeft: 8 }}>
                    {items.length}小問
                  </span>
                </div>
                {items.map((item, index) => (
                  <div
                    className="section-card"
                    key={index}
                    style={{ marginTop: 8 }}
                  >
                    <div className="list-item-head">
                      <span className="list-title">
                        （{item.question_no}）
                      </span>
                      <div className="list-meta" style={{ marginTop: 0 }}>
                        <span className="badge">
                          難易度 {item.difficulty}
                        </span>
                        <span className="badge badge-red">
                          {ORIGIN_LABELS[item.origin] ?? item.origin}
                        </span>
                      </div>
                    </div>
                    <div className="item-text mono pre-wrap">
                      {item.body_latex.length > 600
                        ? `${item.body_latex.slice(0, 600)}…`
                        : item.body_latex}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
