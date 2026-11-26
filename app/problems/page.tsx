"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { BookCover } from "@/app/components/BookCover";
import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { ComboBox } from "@/app/components/ComboBox";
import {
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  SaveIcon,
  TrashIcon,
} from "@/app/components/icons";
import { useInputHistories } from "@/app/components/useInputHistories";
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  SUBJECTS,
  normalizeQuestionType,
  type ProblemRow,
  type QuestionType,
} from "@/lib/types";

interface DraftProblem {
  key: string;
  title: string;
  subject: string;
  book: string;
  difficulty: number;
  field: string;
  questionType: QuestionType;
  targetWord: string;
  optionsText: string;
  body_latex: string;
  answer_latex: string;
  explanation_latex: string;
  sourceFilename: string | null;
}

type AnalysisStatus = "waiting" | "analyzing" | "done" | "error";

interface AnalysisJob {
  id: string;
  file: File;
  book: string;
  subject: string;
  status: AnalysisStatus;
  message?: string;
  questionCount?: number;
  extraction?: ExtractionInfo | null;
  warnings?: string[];
  sourceFilename?: string | null;
}

interface EditDraft {
  id: number;
  book: string;
  subject: string;
  difficulty: number;
  field: string;
  questionType: QuestionType;
  targetWord: string;
  optionsText: string;
  title: string;
  body_latex: string;
  answer_latex: string;
  explanation_latex: string;
}

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
  updated_at?: string | null;
}

interface BookGroup {
  name: string;
  cover: string | null;
  problems: ProblemRow[];
  subjects: string[];
  fields: string[];
}

interface EngineStatus {
  pdfLayout: boolean;
  tesseract: boolean;
  python: {
    available: boolean;
    engines: string[];
    version: string | null;
    error: string | null;
  };
}

interface ExtractionInfo {
  engine: string;
  engineLabel: string;
  pageEngines: string[];
  columns: Array<1 | 2>;
  ocrPages: number[];
  layoutUsed: boolean;
}

interface AlertState {
  kind: "success" | "error" | "info" | "warn";
  text: string;
}

type DeleteTarget =
  | { kind: "problem"; id: number; name: string }
  | { kind: "book"; book: string; ids: number[]; count: number }
  | { kind: "fieldCleanup"; count: number };

function newDraft(subject = "", book = ""): DraftProblem {
  return {
    key: crypto.randomUUID(),
    title: "",
    subject,
    book,
    difficulty: 3,
    field: "",
    questionType: "calculation",
    targetWord: "",
    optionsText: "",
    body_latex: "",
    answer_latex: "",
    explanation_latex: "",
    sourceFilename: null,
  };
}

function parseOptionsJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function problemName(problem: ProblemRow): string {
  return (
    problem.title ||
    problem.body_latex.slice(0, 45) ||
    `問題 #${problem.id}`
  );
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => (value ?? "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, "ja"));
}

const ANALYSIS_STATUS_LABELS: Record<AnalysisStatus, string> = {
  waiting: "予約待ち",
  analyzing: "解析中",
  done: "完了",
  error: "エラー",
};

function analysisStatusBadgeClass(status: AnalysisStatus): string {
  if (status === "done") return "badge-green";
  if (status === "error") return "badge-red";
  if (status === "analyzing") return "badge-amber";
  return "";
}

export default function ProblemsPage() {
  const { histories, refresh: refreshHistories } = useInputHistories();

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [books, setBooks] = useState<BookOption[]>([]);
  const [bank, setBank] = useState<ProblemRow[]>([]);
  const [drafts, setDrafts] = useState<DraftProblem[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [sourceFilename, setSourceFilename] = useState<string | null>(null);
  const [bookName, setBookName] = useState("");
  const [defaultSubject, setDefaultSubject] = useState("");
  const [notes, setNotes] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [bankSubject, setBankSubject] = useState("");
  const [collapsedBooks, setCollapsedBooks] = useState<Record<string, boolean>>(
    {}
  );
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [coverBusy, setCoverBusy] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [extractionInfo, setExtractionInfo] =
    useState<ExtractionInfo | null>(null);
  const [rawTextPreview, setRawTextPreview] = useState("");
  const [analysisQueue, setAnalysisQueue] = useState<AnalysisJob[]>([]);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const analysisQueueRef = useRef<AnalysisJob[]>([]);
  const analysisProcessingRef = useRef(false);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverTargetRef = useRef<{ book: string; subject: string } | null>(
    null
  );

  const refreshAll = useCallback(async () => {
    const [fieldsResponse, booksResponse, bankResponse] = await Promise.all([
      fetch("/api/fields", { cache: "no-store" }),
      fetch("/api/books", { cache: "no-store" }),
      fetch("/api/problems", { cache: "no-store" }),
    ]);

    const fieldsJson = (await fieldsResponse.json()) as {
      fields?: FieldOption[];
    };
    const booksJson = (await booksResponse.json()) as {
      books?: BookOption[];
    };
    const bankJson = (await bankResponse.json()) as {
      problems?: ProblemRow[];
      error?: string;
    };
    if (!bankResponse.ok) {
      throw new Error(bankJson.error ?? "問題一覧の取得に失敗しました");
    }

    setFields(fieldsJson.fields ?? []);
    setBooks(booksJson.books ?? []);
    setBank(bankJson.problems ?? []);
    await refreshHistories();
  }, [refreshHistories]);

  useEffect(() => {
    refreshAll().catch((error: Error) =>
      setAlert({ kind: "error", text: error.message })
    );
  }, [refreshAll]);

  useEffect(() => {
    fetch("/api/extract/engines", { cache: "no-store" })
      .then((response) => response.json())
      .then((json: EngineStatus) => setEngineStatus(json))
      .catch(() => undefined);
  }, []);

  const subjectOptions = useMemo(
    () =>
      uniqueStrings([
        ...SUBJECTS,
        ...(histories.subject ?? []),
        ...bank.map((problem) => problem.subject),
      ]),
    [bank, histories.subject]
  );
  const fieldOptions = useMemo(
    () =>
      uniqueStrings([
        ...fields.map((field) => field.name),
        ...(histories.field ?? []),
      ]),
    [fields, histories.field]
  );
  const bookOptions = useMemo(
    () =>
      uniqueStrings([
        ...books.map((book) => book.name),
        ...(histories.book ?? []),
      ]),
    [books, histories.book]
  );

  const orphanFields = useMemo(
    () => fields.filter((field) => field.problem_count === 0),
    [fields]
  );

  const bankSubjects = useMemo(
    () =>
      uniqueStrings([
        ...bank.map((problem) => problem.subject),
        ...books.map((book) => book.subject),
      ]),
    [bank, books]
  );

  const filteredBank = useMemo(
    () =>
      bankSubject
        ? bank.filter((problem) => problem.subject === bankSubject)
        : bank,
    [bank, bankSubject]
  );

  const bookGroups = useMemo<BookGroup[]>(() => {
    const problemMap = new Map<string, ProblemRow[]>();
    for (const problem of filteredBank) {
      const key = problem.book_name?.trim() || "未分類";
      const list = problemMap.get(key) ?? [];
      list.push(problem);
      problemMap.set(key, list);
    }

    const names = new Set<string>([
      ...books.map((book) => book.name),
      ...problemMap.keys(),
    ]);

    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, "ja"))
      .map((name) => {
        const meta =
          books.find((book) => book.name === name) ?? null;
        const problems = problemMap.get(name) ?? [];
        const subjects = uniqueStrings([
          meta?.subject,
          ...problems.map((problem) => problem.subject),
        ]);
        if (
          bankSubject &&
          !subjects.includes(bankSubject) &&
          problems.length === 0
        ) {
          return null;
        }
        return {
          name,
          cover: meta?.cover_image_path ?? null,
          problems,
          subjects,
          fields: uniqueStrings(
            problems.map((problem) => problem.field_name)
          ),
        };
      })
      .filter((group): group is BookGroup => group !== null);
  }, [bankSubject, books, filteredBank]);

  const currentBook = useMemo(() => {
    const target = bookName.trim().toLocaleLowerCase();
    if (!target) return null;
    return (
      books.find(
        (book) => book.name.toLocaleLowerCase() === target
      ) ?? null
    );
  }, [bookName, books]);

  function pickCover(book: string, subject = "") {
    const target = book.trim();
    if (!target) {
      setAlert({
        kind: "error",
        text: "表紙を設定する参考書名を入力してください。",
      });
      return;
    }
    coverTargetRef.current = { book: target, subject };
    coverInputRef.current?.click();
  }

  async function uploadCover(
    book: string,
    file: File,
    subject = ""
  ) {
    const target = book.trim();
    if (!target) {
      setAlert({
        kind: "error",
        text: "参考書名を入力してから表紙を設定してください。",
      });
      return;
    }
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type)
    ) {
      setAlert({
        kind: "error",
        text: "表紙画像は JPG / PNG / WebP を選択してください。",
      });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setAlert({
        kind: "error",
        text: "表紙画像は8MB以下にしてください。",
      });
      return;
    }

    setCoverBusy(target);
    setAlert(null);
    try {
      const form = new FormData();
      form.append("bookName", target);
      form.append("subject", subject);
      form.append("file", file);
      const response = await fetch("/api/books/cover", {
        method: "POST",
        body: form,
      });
      const json = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(json.error ?? "表紙画像の保存に失敗しました");
      }
      await refreshAll();
      setAlert({
        kind: "success",
        text: `「${target}」の表紙画像を保存しました。`,
      });
    } catch (error) {
      setAlert({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "表紙画像の保存に失敗しました",
      });
    } finally {
      setCoverBusy(null);
    }
  }

  async function deleteCover(book: string) {
    const target = book.trim();
    if (!target) return;
    setCoverBusy(target);
    setAlert(null);
    try {
      const response = await fetch(
        `/api/books/cover?bookName=${encodeURIComponent(target)}`,
        { method: "DELETE" }
      );
      const json = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(json.error ?? "表紙画像の削除に失敗しました");
      }
      await refreshAll();
      setAlert({
        kind: "success",
        text: `「${target}」の表紙画像を削除しました。`,
      });
    } catch (error) {
      setAlert({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "表紙画像の削除に失敗しました",
      });
    } finally {
      setCoverBusy(null);
    }
  }

  function handleCoverFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const target = coverTargetRef.current;
    event.target.value = "";
    coverTargetRef.current = null;
    if (file && target) {
      void uploadCover(target.book, file, target.subject);
    }
  }

  function updateAnalysisQueue(
    updater: (current: AnalysisJob[]) => AnalysisJob[]
  ) {
    const next = updater(analysisQueueRef.current);
    analysisQueueRef.current = next;
    setAnalysisQueue(next);
  }

  async function runAnalysisJob(job: AnalysisJob) {
    const form = new FormData();
    form.append("file", job.file);
    const response = await fetch("/api/extract/problems", {
      method: "POST",
      body: form,
    });
    const json = (await response.json()) as {
      problems?: Array<{
        title?: string;
        body_latex?: string;
        answer_latex?: string;
        explanation_latex?: string;
        suggested_field?: string;
        suggested_difficulty?: number;
        question_type?: QuestionType;
        target_word?: string;
        options?: string[];
      }>;
      notes?: string;
      warnings?: string[];
      source_filename?: string;
      extraction?: ExtractionInfo;
      rawTextPreview?: string;
      error?: string;
    };
    if (!response.ok || !json.problems) {
      throw new Error(json.error ?? "解析に失敗しました");
    }

    const drafts: DraftProblem[] = json.problems.map((item) => ({
      key: crypto.randomUUID(),
      title: item.title ?? "",
      subject: job.subject,
      book: job.book,
      difficulty: item.suggested_difficulty ?? 3,
      field: item.suggested_field ?? "",
      questionType: normalizeQuestionType(item.question_type),
      targetWord: item.target_word ?? "",
      optionsText: Array.isArray(item.options) ? item.options.join(" / ") : "",
      body_latex: item.body_latex ?? "",
      answer_latex: item.answer_latex ?? "",
      explanation_latex: item.explanation_latex ?? "",
      sourceFilename: json.source_filename ?? null,
    }));

    return {
      drafts,
      notes: json.notes ?? "",
      warnings: json.warnings ?? [],
      sourceFilename: json.source_filename ?? null,
      extraction: json.extraction ?? null,
      rawTextPreview: json.rawTextPreview ?? "",
    };
  }

  async function processAnalysisQueue() {
    if (analysisProcessingRef.current) return;
    analysisProcessingRef.current = true;
    setAnalysisRunning(true);

    try {
      while (true) {
        const job = analysisQueueRef.current.find(
          (item) => item.status === "waiting"
        );
        if (!job) break;

        updateAnalysisQueue((current) =>
          current.map((item) =>
            item.id === job.id
              ? { ...item, status: "analyzing", message: "" }
              : item
          )
        );

        try {
          const result = await runAnalysisJob(job);
          updateAnalysisQueue((current) =>
            current.map((item) =>
              item.id === job.id
                ? {
                    ...item,
                    status: "done",
                    questionCount: result.drafts.length,
                    extraction: result.extraction,
                    warnings: result.warnings,
                    sourceFilename: result.sourceFilename,
                  }
                : item
            )
          );
          setDrafts((current) => [...current, ...result.drafts]);
          setNotes(result.notes);
          setWarnings(result.warnings);
          setExtractionInfo(result.extraction);
          setRawTextPreview(result.rawTextPreview);
          setSourceFilename(result.sourceFilename);
          setAlert(
            result.warnings.length > 0
              ? {
                  kind: "warn",
                  text: `${job.file.name}: ${result.drafts.length}件を抽出しましたが警告があります。`,
                }
              : {
                  kind: "success",
                  text: `${job.file.name}: ${result.drafts.length}件の問題を抽出しました。`,
                }
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "解析に失敗しました";
          updateAnalysisQueue((current) =>
            current.map((item) =>
              item.id === job.id
                ? { ...item, status: "error", message }
                : item
            )
          );
          setAlert({ kind: "error", text: `${job.file.name}: ${message}` });
        }
      }
    } finally {
      analysisProcessingRef.current = false;
      setAnalysisRunning(false);
      if (
        analysisQueueRef.current.some((item) => item.status === "waiting")
      ) {
        void processAnalysisQueue();
      }
    }
  }

  function enqueueAnalysis() {
    if (!file) {
      setAlert({ kind: "error", text: "PDFまたは画像を選択してください。" });
      return;
    }
    const book = bookName.trim();
    if (!book) {
      setAlert({ kind: "error", text: "参考書名を入力してください。" });
      return;
    }
    const job: AnalysisJob = {
      id: crypto.randomUUID(),
      file,
      book,
      subject: defaultSubject.trim(),
      status: "waiting",
    };
    updateAnalysisQueue((current) => [...current, job]);
    setFile(null);
    setAlert({
      kind: "info",
      text: `「${job.file.name}」の解析を予約しました。上から順に処理します。`,
    });
    void processAnalysisQueue();
  }

  function patchDraft(key: string, patch: Partial<DraftProblem>) {
    setDrafts((current) =>
      current.map((draft) =>
        draft.key === key ? { ...draft, ...patch } : draft
      )
    );
  }

  async function saveAll() {
    if (drafts.length === 0) return;
    const savedKeys = new Set(drafts.map((draft) => draft.key));
    const problems: string[] = [];
    drafts.forEach((draft, index) => {
      if (!draft.book.trim()) problems.push(`問題${index + 1}: 参考書名が未入力です`);
      if (!draft.subject.trim()) problems.push(`問題${index + 1}: 教科が未選択です`);
      if (!draft.field.trim()) problems.push(`問題${index + 1}: 分野が未入力です`);
      if (!draft.body_latex.trim()) problems.push(`問題${index + 1}: 問題文が空です`);
    });
    if (problems.length > 0) {
      setAlert({ kind: "error", text: problems.join("\n") });
      return;
    }

    setBusy("save");
    setAlert(null);
    try {
      const response = await fetch("/api/problems", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_filename: sourceFilename,
          problems: drafts.map((draft) => ({
            subject: draft.subject.trim(),
            difficulty: draft.difficulty,
            fieldName: draft.field.trim(),
            bookName: draft.book.trim(),
            source_filename: draft.sourceFilename,
            title: draft.title,
            questionType: draft.questionType,
            targetWord:
              draft.targetWord.trim() ||
              (draft.questionType === "word_fill"
                ? draft.answer_latex.trim()
                : ""),
            options: draft.optionsText
              .split(/[\n,、/]+/)
              .map((option) => option.trim())
              .filter(Boolean),
            body_latex: draft.body_latex,
            answer_latex: draft.answer_latex,
            explanation_latex: draft.explanation_latex,
          })),
        }),
      });
      const json = (await response.json()) as {
        inserted?: ProblemRow[];
        errors?: string[];
        error?: string;
      };
      if (!response.ok) throw new Error(json.error ?? "保存に失敗しました");
      await refreshAll();
      if (json.errors && json.errors.length > 0) {
        setAlert({ kind: "error", text: json.errors.join("\n") });
      } else {
        setAlert({
          kind: "success",
          text: `${json.inserted?.length ?? drafts.length}件の問題を保存しました。`,
        });
        setDrafts((current) =>
          current.filter((draft) => !savedKeys.has(draft.key))
        );
        if (
          !analysisRunning &&
          !analysisQueueRef.current.some(
            (job) =>
              job.status === "waiting" || job.status === "analyzing"
          )
        ) {
          setNotes("");
          setWarnings([]);
          setExtractionInfo(null);
          setRawTextPreview("");
        }
        setFile(null);
        setSourceFilename(null);
      }
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "保存に失敗しました",
      });
    } finally {
      setBusy(null);
    }
  }

  function startEdit(problem: ProblemRow) {
    setEditing({
      id: problem.id,
      book: problem.book_name ?? "",
      subject: problem.subject,
      difficulty: problem.difficulty,
      field: problem.field_name ?? "",
      questionType: normalizeQuestionType(problem.question_type),
      targetWord: problem.target_word ?? "",
      optionsText: parseOptionsJson(problem.options_json).join(" / "),
      title: problem.title ?? "",
      body_latex: problem.body_latex,
      answer_latex: problem.answer_latex,
      explanation_latex: problem.explanation_latex,
    });
    setAlert(null);
  }

  function patchEdit(patch: Partial<EditDraft>) {
    setEditing((current) => (current ? { ...current, ...patch } : current));
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editing.book.trim() || !editing.subject.trim() || !editing.field.trim()) {
      setAlert({
        kind: "error",
        text: "参考書名・教科・分野は必須です。",
      });
      return;
    }
    if (!editing.body_latex.trim()) {
      setAlert({ kind: "error", text: "問題文は必須です。" });
      return;
    }

    setBusy(`edit-${editing.id}`);
    setAlert(null);
    try {
      const response = await fetch(`/api/problems/${editing.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: editing.subject.trim(),
          difficulty: editing.difficulty,
          fieldName: editing.field.trim(),
          bookName: editing.book.trim(),
          title: editing.title,
          body_latex: editing.body_latex,
          answer_latex: editing.answer_latex,
          explanation_latex: editing.explanation_latex,
          questionType: editing.questionType,
          targetWord: editing.targetWord.trim() || null,
          options: editing.optionsText
            .split(/[\n,、/]+/)
            .map((option) => option.trim())
            .filter(Boolean),
        }),
      });
      const json = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(json.error ?? "更新に失敗しました");
      await refreshAll();
      setEditing(null);
      setAlert({ kind: "success", text: "問題を更新しました。" });
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "更新に失敗しました",
      });
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy("delete");
    try {
      let response: Response;
      if (deleteTarget.kind === "problem") {
        response = await fetch(`/api/problems/${deleteTarget.id}`, {
          method: "DELETE",
        });
      } else if (deleteTarget.kind === "book") {
        if (deleteTarget.book === "未分類") {
          response = await fetch("/api/problems/bulk-delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: deleteTarget.ids }),
          });
        } else {
          response = await fetch(
            `/api/books?bookName=${encodeURIComponent(
              deleteTarget.book
            )}`,
            { method: "DELETE" }
          );
        }
      } else {
        response = await fetch("/api/fields/cleanup", { method: "POST" });
      }

      const json = (await response.json()) as {
        error?: string;
        deleted?: number;
        deletedProblems?: number;
        removedCover?: boolean;
        count?: number;
      };
      if (!response.ok) throw new Error(json.error ?? "削除に失敗しました");

      await refreshAll();
      if (deleteTarget.kind === "problem") {
        if (editing?.id === deleteTarget.id) setEditing(null);
        setAlert({ kind: "success", text: "問題を削除しました。" });
      } else if (deleteTarget.kind === "book") {
        setEditing(null);
        const deletedCount =
          json.deleted ?? json.deletedProblems ?? deleteTarget.count;
        setAlert({
          kind: "success",
          text:
            deleteTarget.book === "未分類"
              ? `未分類の${deletedCount}問を削除しました。`
              : `「${deleteTarget.book}」の${deletedCount}問と表紙画像を削除しました。`,
        });
      } else {
        setAlert({
          kind: "success",
          text:
            (json.count ?? 0) > 0
              ? `未使用の分野を${json.count}件整理しました。`
              : "未使用の分野はありませんでした。",
        });
      }
      setDeleteTarget(null);
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "削除に失敗しました",
      });
    } finally {
      setBusy(null);
    }
  }

  const dialogTitle =
    deleteTarget?.kind === "problem"
      ? "問題を削除"
      : deleteTarget?.kind === "book"
        ? "参考書ごと削除"
        : "未使用の分野を整理";
  const dialogTarget =
    deleteTarget?.kind === "problem"
      ? deleteTarget.name
      : deleteTarget?.kind === "book"
        ? `${deleteTarget.book}（${deleteTarget.count}問）`
        : `${deleteTarget?.kind === "fieldCleanup" ? deleteTarget.count : 0}件の未使用分野`;
  const dialogDescription =
    deleteTarget?.kind === "book"
      ? "この参考書フォルダ・表紙画像・紐づく問題をまとめて削除します。出力履歴の模試は削除されず、問題参照だけが解除されます。"
      : deleteTarget?.kind === "problem"
        ? "この問題を削除します。出力履歴の模試は削除されず、問題参照だけが解除されます。"
        : "問題が紐づいていない分野タグだけを削除します。既存の問題と出力履歴には影響しません。";

  return (
    <main className="page">
      <input
        ref={coverInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: "none" }}
        onChange={handleCoverFileChange}
      />

      <div className="page-head">
        <h1 className="page-title">問題データ（参考書別）</h1>
        <p className="page-desc">
          参考書の問題・解答PDFや画像を取り込み、参考書名・教科・分野・難易度を紐づけて管理します。
          <strong>参考書名</strong>ごとにまとめて表示され、個別編集・参考書ごとの一括削除ができます。
        </p>
      </div>

      {alert ? <div className={`alert alert-${alert.kind}`}>{alert.text}</div> : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">問題ファイルの取り込み</h2>
            <p className="panel-sub">
              参考書名は必須です。問題文・解答・解説を抽出し、LaTeXで保存します。
            </p>
            <div className="engine-status-row">
              <span className="badge badge-green">座標PDF抽出</span>
              {engineStatus ? (
                engineStatus.python.available ? (
                  <span
                    className="badge badge-green"
                    title={engineStatus.python.version ?? undefined}
                  >
                    Python高精度OCR:{" "}
                    {engineStatus.python.engines.join(" / ")}
                  </span>
                ) : (
                  <span
                    className="badge badge-amber"
                    title={engineStatus.python.error ?? undefined}
                  >
                    Python OCR未導入 → Tesseractへ自動フォールバック
                  </span>
                )
              ) : (
                <span className="badge">OCRエンジン確認中...</span>
              )}
              <span className="badge badge-green">
                前処理付きTesseract.js
              </span>
            </div>
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label className="label" htmlFor="book-name">
              参考書名（出典）<span className="req">*</span>
            </label>
            <ComboBox
              id="book-name"
              value={bookName}
              onChange={setBookName}
              options={bookOptions}
              placeholder="例：青チャート 数学ⅠA"
              required
            />
            <span className="hint">
              登録済みの参考書名は候補から選択できます。新しい参考書名も入力できます。
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="default-subject">
              解析後に付与する既定の教科（任意）
            </label>
            <ComboBox
              id="default-subject"
              value={defaultSubject}
              onChange={setDefaultSubject}
              options={subjectOptions}
              placeholder="例：数学ⅠA"
            />
          </div>
        </div>

        <div className="cover-form-row" style={{ marginTop: 14 }}>
          <div
            className={`book-cover-drop ${
              coverBusy === bookName.trim() ? "dragging" : ""
            }`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const dropped = event.dataTransfer.files?.[0];
              if (dropped && bookName.trim()) {
                void uploadCover(
                  bookName.trim(),
                  dropped,
                  defaultSubject
                );
              }
            }}
            onClick={() => {
              if (bookName.trim()) {
                pickCover(bookName, defaultSubject);
              }
            }}
          >
            <BookCover
              bookName={bookName.trim() || "参考書"}
              coverPath={currentBook?.cover_image_path ?? null}
              className="book-cover-large"
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <span className="label">
              表紙画像（JPG / PNG / WebP）
            </span>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => pickCover(bookName, defaultSubject)}
                disabled={!bookName.trim() || coverBusy !== null}
              >
                {coverBusy === bookName.trim()
                  ? "保存中..."
                  : currentBook?.cover_image_path
                    ? "表紙写真を変更"
                    : "表紙写真を設定"}
              </button>
              {currentBook?.cover_image_path ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => deleteCover(bookName)}
                  disabled={coverBusy !== null}
                >
                  表紙を削除
                </button>
              ) : null}
            </div>
            <span className="hint">
              画像をクリックまたはドラッグ＆ドロップ。3:4の書籍表紙として保存され、参考書カードと模試生成画面に表示されます。
            </span>
          </div>
        </div>

        <div className="grid-2" style={{ marginTop: 14 }}>
          <div className="field">
            <span className="label">
              問題PDF / 画像<span className="req">*</span>
            </span>
            <label className="drop" htmlFor="problem-file">
              <input
                id="problem-file"
                type="file"
                accept=".pdf,image/*"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
              <div className="drop-title">クリックしてファイルを選択</div>
              <div className="drop-sub">
                {file
                  ? `${file.name}（${Math.round(file.size / 1024)} KB）`
                  : "PDF / PNG / JPEG（25MBまで）"}
              </div>
            </label>
          </div>
          <div className="field" style={{ justifyContent: "flex-end" }}>
            <button
              className="btn btn-action"
              onClick={enqueueAnalysis}
              disabled={busy !== null || !file || !bookName.trim()}
            >
              {analysisRunning ? <PlusIcon /> : <PlayIcon />}
              {analysisRunning ? "解析を予約する" : "問題を抽出する"}
            </button>
            <span className="hint">
              {analysisRunning
                ? "解析中でも次のファイルを予約できます。予約は上から順に処理されます。"
                : "参考書名を入力すると抽出できます。抽出後に各問題の教科・分野を調整してください。"}
            </span>
          </div>
        </div>

        {notes ? <div className="alert alert-info">{notes}</div> : null}
        {warnings.map((warning, index) => (
          <div className="alert alert-warn" key={index}>
            {warning}
          </div>
        ))}

        {extractionInfo ? (
          <div className="engine-status-row">
            <span className="badge badge-green">
              {extractionInfo.engineLabel}
            </span>
            <span className="badge">
              {extractionInfo.columns.includes(2)
                ? "2段組み検出"
                : "1段組み"}
            </span>
            {extractionInfo.ocrPages.length > 0 ? (
              <span className="badge badge-amber">
                OCR {extractionInfo.ocrPages.length}ページ
              </span>
            ) : null}
            <span className="badge">AIクリーニング済み</span>
          </div>
        ) : null}

        {rawTextPreview ? (
          <details className="step-detail" style={{ marginTop: 10 }}>
            <summary>
              抽出された生テキストを確認（AIクリーニング前）
            </summary>
            <pre>{rawTextPreview}</pre>
          </details>
        ) : null}
      </section>

      {analysisQueue.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">
                解析予約キュー（{analysisQueue.length}件）
              </h2>
              <p className="panel-sub">
                解析中でも次のファイルを予約できます。上から順に処理します。
              </p>
            </div>
            <div className="btn-row">
              {analysisRunning ? (
                <span className="badge badge-amber">解析中</span>
              ) : null}
              <button
                className="btn btn-sm btn-ghost"
                onClick={() =>
                  updateAnalysisQueue((current) =>
                    current.filter(
                      (job) =>
                        job.status === "waiting" ||
                        job.status === "analyzing"
                    )
                  )
                }
                disabled={
                  !analysisQueue.some(
                    (job) => job.status === "done" || job.status === "error"
                  )
                }
              >
                完了・エラーをクリア
              </button>
            </div>
          </div>
          <div className="stack">
            {analysisQueue.map((job) => (
              <div className="list-item" key={job.id}>
                <div className="list-item-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="list-title">{job.file.name}</div>
                    <div className="list-meta">
                      {job.book}
                      {job.subject ? ` / ${job.subject}` : ""}
                      {job.questionCount !== undefined
                        ? ` / ${job.questionCount}問`
                        : ""}
                    </div>
                  </div>
                  <div className="btn-row">
                    <span
                      className={`badge ${analysisStatusBadgeClass(
                        job.status
                      )}`}
                    >
                      {ANALYSIS_STATUS_LABELS[job.status]}
                    </span>
                    {job.status === "waiting" ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          updateAnalysisQueue((current) =>
                            current.filter((item) => item.id !== job.id)
                          )
                        }
                      >
                        予約取消
                      </button>
                    ) : null}
                  </div>
                </div>
                {job.status === "done" && job.extraction ? (
                  <div className="list-meta">
                    {job.extraction.engineLabel}
                    {job.warnings && job.warnings.length > 0
                      ? ` / 警告 ${job.warnings.length}件`
                      : ""}
                  </div>
                ) : null}
                {job.status === "error" && job.message ? (
                  <div className="list-meta text-danger">{job.message}</div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {drafts.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">抽出された問題（{drafts.length}件）</h2>
              <p className="panel-sub">
                参考書名・教科・難易度・分野を確認してください。分野は候補から選択、または新規入力できます。
              </p>
            </div>
            <div className="btn-row">
              <button
                className="btn btn-sm"
                onClick={() =>
                  setDrafts((current) => [
                    ...current,
                    newDraft(defaultSubject, bookName),
                  ])
                }
              >
                <PlusIcon />
                空の問題を追加
              </button>
              <button
                className="btn btn-save"
                onClick={saveAll}
                disabled={busy !== null}
              >
                {busy === "save" ? <span className="spinner" /> : <SaveIcon />}
                {busy === "save" ? "保存中..." : "すべて保存"}
              </button>
            </div>
          </div>

          {drafts.map((draft, index) => (
            <div className="section-card" key={draft.key}>
              <div className="section-card-head">
                <span className="badge badge-red">問題 {index + 1}</span>
                <button
                  className="icon-btn"
                  title="この入力を破棄"
                  onClick={() =>
                    setDrafts((current) =>
                      current.filter((item) => item.key !== draft.key)
                    )
                  }
                >
                  ×
                </button>
              </div>

              <div className="grid-4">
                <div className="field">
                  <label className="label">
                    参考書名<span className="req">*</span>
                  </label>
                  <ComboBox
                    value={draft.book}
                    onChange={(value) => patchDraft(draft.key, { book: value })}
                    options={bookOptions}
                    placeholder="参考書名"
                    required
                  />
                </div>
                <div className="field">
                  <label className="label">
                    教科<span className="req">*</span>
                  </label>
                  <ComboBox
                    value={draft.subject}
                    onChange={(value) => patchDraft(draft.key, { subject: value })}
                    options={subjectOptions}
                    placeholder="教科"
                    required
                  />
                </div>
                <div className="field">
                  <label className="label">
                    難易度<span className="req">*</span>
                  </label>
                  <select
                    className="select"
                    value={draft.difficulty}
                    onChange={(event) =>
                      patchDraft(draft.key, {
                        difficulty: Number(event.target.value),
                      })
                    }
                  >
                    {[1, 2, 3, 4, 5].map((level) => (
                      <option key={level} value={level}>
                        {level}（{level === 1 ? "基礎" : level === 2 ? "標準" : level === 3 ? "やや応用" : level === 4 ? "発展" : "難関"}）
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="label">
                    分野<span className="req">*</span>
                  </label>
                  <ComboBox
                    value={draft.field}
                    onChange={(value) => patchDraft(draft.key, { field: value })}
                    options={fieldOptions}
                    placeholder="例：2次関数"
                    required
                  />
                </div>
              </div>

              <div className="grid-2" style={{ marginTop: 10 }}>
                <div className="field">
                  <label className="label">問題タイプ</label>
                  <select
                    className="select"
                    value={draft.questionType}
                    onChange={(event) =>
                      patchDraft(draft.key, {
                        questionType: normalizeQuestionType(event.target.value),
                      })
                    }
                  >
                    {QUESTION_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {QUESTION_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="label">タイトル（任意）</label>
                  <input
                    className="input"
                    value={draft.title}
                    placeholder="例：2次関数の最大・最小"
                    onChange={(event) =>
                      patchDraft(draft.key, { title: event.target.value })
                    }
                  />
                </div>
              </div>

              {draft.questionType === "word_fill" ? (
                <div className="grid-2" style={{ marginTop: 10 }}>
                  <div className="field">
                    <label className="label">正解語句</label>
                    <input
                      className="input"
                      value={draft.targetWord}
                      placeholder="例：photosynthesis"
                      onChange={(event) =>
                        patchDraft(draft.key, {
                          targetWord: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label className="label">選択肢（改行/カンマ区切り）</label>
                    <input
                      className="input"
                      value={draft.optionsText}
                      placeholder="例：photosynthesis / respiration / digestion"
                      onChange={(event) =>
                        patchDraft(draft.key, {
                          optionsText: event.target.value,
                        })
                      }
                    />
                  </div>
                </div>
              ) : null}

              <div className="field" style={{ marginTop: 10 }}>
                <label className="label">
                  問題文（LaTeX可）<span className="req">*</span>
                </label>
                <textarea
                  className="textarea"
                  value={draft.body_latex}
                  placeholder="例：$f(x)=x^2-4x+3$ の最小値を求めよ。"
                  onChange={(event) =>
                    patchDraft(draft.key, { body_latex: event.target.value })
                  }
                />
              </div>

              <div className="grid-2" style={{ marginTop: 10 }}>
                <div className="field">
                  <label className="label">解答（LaTeX可）</label>
                  <textarea
                    className="textarea"
                    value={draft.answer_latex}
                    placeholder="例：$x=2$ のとき最小値 $-1$"
                    onChange={(event) =>
                      patchDraft(draft.key, { answer_latex: event.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label className="label">解説（LaTeX可）</label>
                  <textarea
                    className="textarea"
                    value={draft.explanation_latex}
                    placeholder="解説・方針を入力"
                    onChange={(event) =>
                      patchDraft(draft.key, {
                        explanation_latex: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
            </div>
          ))}

          <div className="btn-row" style={{ marginTop: 14 }}>
            <button
              className="btn btn-save"
              onClick={saveAll}
              disabled={busy !== null}
            >
              {busy === "save" ? <span className="spinner" /> : <SaveIcon />}
              {busy === "save" ? "保存中..." : "すべて保存"}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setDrafts([]);
                setExtractionInfo(null);
                setRawTextPreview("");
              }}
              disabled={busy !== null}
            >
              入力をクリア
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">問題バンク（参考書別）</h2>
            <p className="panel-sub">
              登録 {bank.length} 件 / {bookGroups.length} 参考書
            </p>
          </div>
          <div className="btn-row">
            <div className="field" style={{ minWidth: 180 }}>
              <select
                className="select"
                value={bankSubject}
                onChange={(event) => setBankSubject(event.target.value)}
              >
                <option value="">すべての教科</option>
                {bankSubjects.map((subject) => (
                  <option key={subject} value={subject}>
                    {subject}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() =>
                refreshAll().catch((error: Error) =>
                  setAlert({ kind: "error", text: error.message })
                )
              }
            >
              <RefreshIcon />
              再読み込み
            </button>
            {orphanFields.length > 0 ? (
              <button
                className="btn btn-sm btn-danger"
                onClick={() =>
                  setDeleteTarget({
                    kind: "fieldCleanup",
                    count: orphanFields.length,
                  })
                }
                disabled={busy !== null}
              >
                <TrashIcon />
                未使用の分野を整理
              </button>
            ) : null}
          </div>
        </div>

        {bookGroups.length === 0 ? (
          <p className="hint">
            該当する問題がありません。上のフォームから取り込むか、教科フィルタを変更してください。
          </p>
        ) : (
          <div className="stack">
            {bookGroups.map((group) => {
              const book = group.name;
              const items = group.problems;
              const isUncategorized = book === "未分類";
              const isOpen = !collapsedBooks[book];
              const subjects = group.subjects;
              const fieldsInBook = group.fields;
              return (
                <div className="list-item book-card" key={book}>
                  <div className="book-card-head">
                    <div className="book-card-cover">
                      <div
                        className={`book-cover-drop ${
                          coverBusy === book ? "dragging" : ""
                        }`}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          const dropped = event.dataTransfer.files?.[0];
                          if (dropped && !isUncategorized) {
                            void uploadCover(
                              book,
                              dropped,
                              subjects[0] ?? ""
                            );
                          }
                        }}
                        onClick={() => {
                          if (!isUncategorized) {
                            pickCover(book, subjects[0] ?? "");
                          }
                        }}
                      >
                        <BookCover
                          bookName={book}
                          coverPath={group.cover}
                        />
                      </div>
                      {!isUncategorized ? (
                        <div className="book-cover-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              pickCover(book, subjects[0] ?? "")
                            }
                            disabled={coverBusy !== null}
                          >
                            {coverBusy === book
                              ? "保存中..."
                              : group.cover
                                ? "表紙を変更"
                                : "表紙を設定"}
                          </button>
                          {group.cover ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => deleteCover(book)}
                              disabled={coverBusy !== null}
                            >
                              表紙を削除
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <div className="book-card-info">
                      <div className="list-title">
                        {book}
                        <span className="badge" style={{ marginLeft: 8 }}>
                          {items.length}問
                        </span>
                      </div>
                      <div className="list-meta">
                        {subjects.map((subject) => (
                          <span className="badge badge-red" key={subject}>
                            {subject}
                          </span>
                        ))}
                        {fieldsInBook.slice(0, 8).map((field) => (
                          <span className="badge" key={field}>
                            {field}
                          </span>
                        ))}
                        {fieldsInBook.length > 8 ? (
                          <span className="badge">
                            +{fieldsInBook.length - 8}
                          </span>
                        ) : null}
                      </div>
                      <div className="btn-row">
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() =>
                            setCollapsedBooks((current) => ({
                              ...current,
                              [book]: !current[book],
                            }))
                          }
                        >
                          {isOpen ? "閉じる" : "開く"}
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() =>
                            setDeleteTarget({
                              kind: "book",
                              book,
                              ids: items.map((item) => item.id),
                              count: items.length,
                            })
                          }
                          disabled={busy !== null}
                        >
                          <TrashIcon />
                          参考書ごと削除
                        </button>
                      </div>
                    </div>
                  </div>

                  {isOpen ? (
                    <div className="stack" style={{ marginTop: 12 }}>
                      {items.length === 0 ? (
                        <p className="hint">
                          この参考書にはまだ問題がありません。取り込みフォームで参考書名を選択して問題を追加してください。
                        </p>
                      ) : null}
                      {items.map((problem) => {
                        const isEditing = editing?.id === problem.id;
                        return (
                          <div className="section-card" key={problem.id}>
                            {isEditing && editing ? (
                              <div>
                                <div className="section-card-head">
                                  <span className="badge badge-red">
                                    編集中
                                  </span>
                                  <span className="list-meta">
                                    {problem.subject} / {problem.difficulty}
                                  </span>
                                </div>

                                <div className="grid-4">
                                  <div className="field">
                                    <label className="label">
                                      参考書名<span className="req">*</span>
                                    </label>
                                    <ComboBox
                                      value={editing.book}
                                      onChange={(value) =>
                                        patchEdit({ book: value })
                                      }
                                      options={bookOptions}
                                      required
                                    />
                                  </div>
                                  <div className="field">
                                    <label className="label">
                                      教科<span className="req">*</span>
                                    </label>
                                    <ComboBox
                                      value={editing.subject}
                                      onChange={(value) =>
                                        patchEdit({ subject: value })
                                      }
                                      options={subjectOptions}
                                      required
                                    />
                                  </div>
                                  <div className="field">
                                    <label className="label">
                                      難易度<span className="req">*</span>
                                    </label>
                                    <select
                                      className="select"
                                      value={editing.difficulty}
                                      onChange={(event) =>
                                        patchEdit({
                                          difficulty: Number(event.target.value),
                                        })
                                      }
                                    >
                                      {[1, 2, 3, 4, 5].map((level) => (
                                        <option key={level} value={level}>
                                          {level}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <div className="field">
                                    <label className="label">
                                      分野<span className="req">*</span>
                                    </label>
                                    <ComboBox
                                      value={editing.field}
                                      onChange={(value) =>
                                        patchEdit({ field: value })
                                      }
                                      options={fieldOptions}
                                      required
                                    />
                                  </div>
                                </div>

                                <div className="grid-2" style={{ marginTop: 10 }}>
                                  <div className="field">
                                    <label className="label">問題タイプ</label>
                                    <select
                                      className="select"
                                      value={editing.questionType}
                                      onChange={(event) =>
                                        patchEdit({
                                          questionType: normalizeQuestionType(
                                            event.target.value
                                          ),
                                        })
                                      }
                                    >
                                      {QUESTION_TYPES.map((type) => (
                                        <option key={type} value={type}>
                                          {QUESTION_TYPE_LABELS[type]}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <div className="field">
                                    <label className="label">タイトル</label>
                                    <input
                                      className="input"
                                      value={editing.title}
                                      onChange={(event) =>
                                        patchEdit({ title: event.target.value })
                                      }
                                    />
                                  </div>
                                </div>

                                {editing.questionType === "word_fill" ? (
                                  <div className="grid-2" style={{ marginTop: 10 }}>
                                    <div className="field">
                                      <label className="label">正解語句</label>
                                      <input
                                        className="input"
                                        value={editing.targetWord}
                                        onChange={(event) =>
                                          patchEdit({
                                            targetWord: event.target.value,
                                          })
                                        }
                                      />
                                    </div>
                                    <div className="field">
                                      <label className="label">
                                        選択肢（改行/カンマ区切り）
                                      </label>
                                      <input
                                        className="input"
                                        value={editing.optionsText}
                                        onChange={(event) =>
                                          patchEdit({
                                            optionsText: event.target.value,
                                          })
                                        }
                                      />
                                    </div>
                                  </div>
                                ) : null}

                                <div className="field" style={{ marginTop: 10 }}>
                                  <label className="label">
                                    問題文（LaTeX可）<span className="req">*</span>
                                  </label>
                                  <textarea
                                    className="textarea"
                                    value={editing.body_latex}
                                    onChange={(event) =>
                                      patchEdit({
                                        body_latex: event.target.value,
                                      })
                                    }
                                  />
                                </div>

                                <div className="grid-2" style={{ marginTop: 10 }}>
                                  <div className="field">
                                    <label className="label">解答（LaTeX可）</label>
                                    <textarea
                                      className="textarea"
                                      value={editing.answer_latex}
                                      onChange={(event) =>
                                        patchEdit({
                                          answer_latex: event.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                  <div className="field">
                                    <label className="label">解説（LaTeX可）</label>
                                    <textarea
                                      className="textarea"
                                      value={editing.explanation_latex}
                                      onChange={(event) =>
                                        patchEdit({
                                          explanation_latex: event.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                </div>

                                <div className="btn-row" style={{ marginTop: 12 }}>
                                  <button
                                    className="btn btn-sm btn-save"
                                    onClick={saveEdit}
                                    disabled={busy !== null}
                                  >
                                    {busy === `edit-${editing.id}` ? (
                                      <span className="spinner" />
                                    ) : (
                                      <SaveIcon />
                                    )}
                                    {busy === `edit-${editing.id}`
                                      ? "保存中..."
                                      : "変更を保存"}
                                  </button>
                                  <button
                                    className="btn btn-sm btn-ghost"
                                    onClick={() => setEditing(null)}
                                    disabled={busy !== null}
                                  >
                                    キャンセル
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="list-item-head">
                                  <div style={{ minWidth: 0 }}>
                                    <div className="list-title">
                                      {problemName(problem)}
                                    </div>
                                    <div className="list-meta">
                                      <span className="badge badge-red">
                                        {problem.subject}
                                      </span>
                                      <span className="badge">
                                        難易度 {problem.difficulty}
                                      </span>
                                      <span className="badge">
                                        {QUESTION_TYPE_LABELS[
                                          normalizeQuestionType(
                                            problem.question_type
                                          )
                                        ]}
                                      </span>
                                      {problem.field_name ? (
                                        <span className="badge">
                                          {problem.field_name}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="btn-row">
                                    <button
                                      className="btn btn-sm btn-ghost"
                                      onClick={() => startEdit(problem)}
                                      disabled={busy !== null}
                                    >
                                      編集
                                    </button>
                                    <button
                                      className="btn btn-sm btn-danger"
                                      onClick={() =>
                                        setDeleteTarget({
                                          kind: "problem",
                                          id: problem.id,
                                          name: problemName(problem),
                                        })
                                      }
                                      disabled={busy !== null}
                                    >
                                      <TrashIcon />
                                      削除
                                    </button>
                                  </div>
                                </div>
                                <div className="item-text mono pre-wrap">
                                  {problem.body_latex.slice(0, 320)}
                                  {problem.body_latex.length > 320 ? "…" : ""}
                                </div>
                                {problem.answer_latex ? (
                                  <div className="list-meta">
                                    <span>
                                      解答: {problem.answer_latex.slice(0, 100)}
                                    </span>
                                  </div>
                                ) : null}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={dialogTitle}
        target={dialogTarget}
        description={dialogDescription}
        busy={busy === "delete"}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </main>
  );
}
