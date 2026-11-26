import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeDifficulty,
  type ExamItem,
  type ExamRow,
  type GenerationMode,
  normalizeQuestionType,
  type ProblemRow,
  type QuestionType,
  type RunLog,
  type TemplateData,
  type VerificationStep,
} from "./types";
import { normalizeTemplate } from "./template";

export const DATA_DIR = path.join(process.cwd(), "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const PDF_DIR = path.join(DATA_DIR, "pdfs");
export const COVERS_DIR = path.join(
  process.cwd(),
  "public",
  "uploads",
  "covers"
);
const DB_PATH = path.join(DATA_DIR, "mock-examizer.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exam_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  data_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  source_filename TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES exam_templates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  subject TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  field_id INTEGER REFERENCES fields(id) ON DELETE SET NULL,
  title TEXT,
  body_latex TEXT NOT NULL,
  answer_latex TEXT NOT NULL DEFAULT '',
  explanation_latex TEXT NOT NULL DEFAULT '',
  source_filename TEXT,
  book_name TEXT,
  structure_json TEXT NOT NULL DEFAULT '{}',
  question_type TEXT NOT NULL DEFAULT 'calculation',
  target_word TEXT,
  options_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  template_id INTEGER REFERENCES exam_templates(id) ON DELETE SET NULL,
  template_name TEXT NOT NULL,
  target_difficulty REAL NOT NULL,
  avg_difficulty REAL NOT NULL,
  mode TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  template_json TEXT NOT NULL,
  verification_json TEXT NOT NULL DEFAULT '{}',
  question_pdf_path TEXT,
  answer_pdf_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  section_no INTEGER NOT NULL,
  question_no INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  difficulty INTEGER NOT NULL,
  body_latex TEXT NOT NULL,
  answer_latex TEXT NOT NULL DEFAULT '',
  explanation_latex TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  problem_id INTEGER REFERENCES problems(id) ON DELETE SET NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  question_type TEXT NOT NULL DEFAULT 'calculation',
  target_word TEXT,
  options_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS generation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  iteration INTEGER NOT NULL,
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  step TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  iteration INTEGER NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS input_histories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(category, value)
);

CREATE TABLE IF NOT EXISTS reference_books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  cover_image_path TEXT,
  subject TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_problems_subject ON problems(subject);
CREATE INDEX IF NOT EXISTS idx_reference_books_name ON reference_books(book_name);
CREATE INDEX IF NOT EXISTS idx_input_histories_category ON input_histories(category);
CREATE INDEX IF NOT EXISTS idx_exam_items_exam ON exam_items(exam_id);
CREATE INDEX IF NOT EXISTS idx_exams_subject ON exams(subject);
CREATE INDEX IF NOT EXISTS idx_verification_exam ON verification_logs(exam_id);
`;

function ensureDirs(): void {
  for (const dir of [DATA_DIR, UPLOAD_DIR, PDF_DIR, COVERS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createDb(): Database.Database {
  ensureDirs();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const columnsOf = (table: string): Set<string> => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  };
  const addColumn = (table: string, column: string, ddl: string): void => {
    if (!columnsOf(table).has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };

  addColumn("problems", "book_name", "book_name TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_problems_book ON problems(book_name)"
  );
  db.exec(
    `INSERT OR IGNORE INTO reference_books
       (book_name, cover_image_path, subject, created_at, updated_at)
     SELECT book_name, NULL, MIN(subject), datetime('now'), datetime('now')
     FROM problems
     WHERE book_name IS NOT NULL AND TRIM(book_name) <> ''
     GROUP BY book_name`
  );
  addColumn("problems", "question_type", "question_type TEXT NOT NULL DEFAULT 'calculation'");
  addColumn("problems", "target_word", "target_word TEXT");
  addColumn("problems", "options_json", "options_json TEXT NOT NULL DEFAULT '[]'");
  addColumn("exam_items", "question_type", "question_type TEXT NOT NULL DEFAULT 'calculation'");
  addColumn("exam_items", "target_word", "target_word TEXT");
  addColumn("exam_items", "options_json", "options_json TEXT NOT NULL DEFAULT '[]'");
  addColumn("generation_runs", "step", "step TEXT NOT NULL DEFAULT ''");
  addColumn("generation_runs", "status", "status TEXT NOT NULL DEFAULT ''");
  addColumn("generation_runs", "detail_json", "detail_json TEXT NOT NULL DEFAULT '{}'");
}

declare global {
  var __mefDb: Database.Database | undefined;
}

export function getDb(): Database.Database {
  if (!globalThis.__mefDb) globalThis.__mefDb = createDb();
  return globalThis.__mefDb;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface TemplateListItem {
  id: number;
  name: string;
  data: TemplateData;
  version: number;
  source_filename: string | null;
  updated_at: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function listTemplates(): TemplateListItem[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.name, t.data_json, t.source_filename, t.updated_at,
              COALESCE((SELECT MAX(version) FROM exam_template_versions v WHERE v.template_id = t.id), 1) AS version
       FROM exam_templates t
       ORDER BY t.updated_at DESC`
    )
    .all() as Array<{
    id: number;
    name: string;
    data_json: string;
    source_filename: string | null;
    updated_at: string;
    version: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    data: normalizeTemplate(parseJson(row.data_json, {})),
    version: row.version,
    source_filename: row.source_filename,
    updated_at: row.updated_at,
  }));
}

export function saveTemplate(
  name: string,
  data: TemplateData,
  sourceFilename?: string | null
): { id: number; version: number; name: string } {
  const db = getDb();
  const normalized = normalizeTemplate(data);
  const timestamp = nowIso();

  const transaction = db.transaction(() => {
    const existing = db
      .prepare(`SELECT id FROM exam_templates WHERE name = ?`)
      .get(name) as { id: number } | undefined;

    let id: number;
    if (existing) {
      db.prepare(
        `UPDATE exam_templates SET data_json = ?, source_filename = COALESCE(?, source_filename), updated_at = ? WHERE id = ?`
      ).run(JSON.stringify(normalized), sourceFilename ?? null, timestamp, existing.id);
      id = existing.id;
    } else {
      const info = db
        .prepare(
          `INSERT INTO exam_templates (name, data_json, schema_version, source_filename, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(name, JSON.stringify(normalized), 1, sourceFilename ?? null, timestamp, timestamp);
      id = Number(info.lastInsertRowid);
    }

    const current = db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS version FROM exam_template_versions WHERE template_id = ?`
      )
      .get(id) as { version: number };
    const version = current.version + 1;
    db.prepare(
      `INSERT INTO exam_template_versions (template_id, version, data_json, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(id, version, JSON.stringify(normalized), timestamp);

    return { id, version, name };
  });

  return transaction();
}

export interface FieldRow {
  id: number;
  name: string;
  subject: string | null;
  problem_count: number;
}

export function listFields(subject?: string): FieldRow[] {
  const db = getDb();
  const sql = `SELECT f.id, f.name, f.subject,
                      (SELECT COUNT(*) FROM problems p WHERE p.field_id = f.id) AS problem_count
               FROM fields f
               ${subject ? "WHERE f.subject = ? OR f.subject IS NULL" : ""}
               ORDER BY f.name`;
  const rows = (subject ? db.prepare(sql).all(subject) : db.prepare(sql).all()) as FieldRow[];
  return rows;
}

export function resolveField(name: string, subject?: string | null): number | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM fields WHERE name = ? COLLATE NOCASE`)
    .get(trimmed) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare(`INSERT INTO fields (name, subject, created_at) VALUES (?, ?, ?)`)
    .run(trimmed, subject ?? null, nowIso());
  return Number(info.lastInsertRowid);
}

export function listProblems(filter: { subject?: string } = {}): ProblemRow[] {
  const db = getDb();
  const where = filter.subject ? "WHERE p.subject = ?" : "";
  return db
    .prepare(
      `SELECT p.*, f.name AS field_name
       FROM problems p
       LEFT JOIN fields f ON f.id = p.field_id
       ${where}
       ORDER BY p.created_at DESC`
    )
    .all(...(filter.subject ? [filter.subject] : [])) as ProblemRow[];
}

export interface ProblemInput {
  subject: string;
  difficulty: number;
  fieldName?: string;
  fieldId?: number;
  title?: string;
  body_latex: string;
  answer_latex?: string;
  explanation_latex?: string;
  source_filename?: string | null;
  bookName?: string;
  structure?: Record<string, unknown>;
  questionType?: QuestionType;
  targetWord?: string | null;
  options?: string[];
}

export function insertProblem(input: ProblemInput): ProblemRow {
  const db = getDb();
  const timestamp = nowIso();
  const bookName = input.bookName?.trim();
  if (!bookName) {
    throw new Error("参考書名は必須です");
  }
  const fieldName = input.fieldName?.trim();
  if (!fieldName) {
    throw new Error("分野は必須です");
  }
  const fieldId = input.fieldId ?? resolveField(fieldName, input.subject);
  const options = Array.isArray(input.options)
    ? input.options.map((option) => String(option).trim()).filter(Boolean).slice(0, 12)
    : [];
  const info = db
    .prepare(
      `INSERT INTO problems
        (subject, difficulty, field_id, title, body_latex, answer_latex, explanation_latex,
         source_filename, book_name, structure_json, question_type, target_word, options_json,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.subject,
      normalizeDifficulty(input.difficulty),
      fieldId,
      input.title ?? null,
      input.body_latex,
      input.answer_latex ?? "",
      input.explanation_latex ?? "",
      input.source_filename ?? null,
      bookName,
      JSON.stringify(input.structure ?? {}),
      normalizeQuestionType(input.questionType),
      input.targetWord ?? null,
      JSON.stringify(options),
      timestamp,
      timestamp
    );

  ensureReferenceBook(bookName, input.subject);
  recordHistory("subject", input.subject);
  recordHistory("book", bookName);
  recordHistory("field", fieldName);
  recordHistory("difficulty", String(normalizeDifficulty(input.difficulty)));
  recordHistory("question_type", normalizeQuestionType(input.questionType));
  return db
    .prepare(
      `SELECT p.*, f.name AS field_name FROM problems p LEFT JOIN fields f ON f.id = p.field_id WHERE p.id = ?`
    )
    .get(Number(info.lastInsertRowid)) as ProblemRow;
}

export function deleteProblem(id: number): void {
  getDb().prepare(`DELETE FROM problems WHERE id = ?`).run(id);
}

export function recordHistory(
  category: string,
  value: string | null | undefined
): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  try {
    getDb()
      .prepare(
        `INSERT INTO input_histories (category, value, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(category, value) DO UPDATE SET created_at = excluded.created_at`
      )
      .run(category, trimmed, nowIso());
  } catch {
    // 履歴保存の失敗で本来の保存処理を止めない
  }
}

export function listHistories(): Record<string, string[]> {
  const rows = getDb()
    .prepare(
      `SELECT category, value FROM input_histories
       ORDER BY created_at DESC, id DESC`
    )
    .all() as Array<{ category: string; value: string }>;
  const map: Record<string, string[]> = {};
  for (const row of rows) {
    const list = map[row.category] ?? [];
    if (list.length < 50) list.push(row.value);
    map[row.category] = list;
  }
  return map;
}

export interface BookRow {
  name: string;
  problem_count: number;
  cover_image_path: string | null;
  subject: string | null;
  updated_at: string | null;
}

export function listBooks(): BookRow[] {
  const db = getDb();
  const refs = db
    .prepare(
      `SELECT book_name AS name, cover_image_path, subject, updated_at
       FROM reference_books`
    )
    .all() as Array<{
    name: string;
    cover_image_path: string | null;
    subject: string | null;
    updated_at: string;
  }>;
  const counts = db
    .prepare(
      `SELECT book_name AS name, COUNT(*) AS problem_count
       FROM problems
       WHERE book_name IS NOT NULL AND TRIM(book_name) <> ''
       GROUP BY book_name`
    )
    .all() as Array<{ name: string; problem_count: number }>;

  const map = new Map<string, BookRow>();
  for (const ref of refs) {
    map.set(ref.name.trim().toLocaleLowerCase(), {
      name: ref.name,
      problem_count: 0,
      cover_image_path: ref.cover_image_path,
      subject: ref.subject,
      updated_at: ref.updated_at,
    });
  }
  for (const count of counts) {
    const key = count.name.trim().toLocaleLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.problem_count += count.problem_count;
    } else {
      map.set(key, {
        name: count.name,
        problem_count: count.problem_count,
        cover_image_path: null,
        subject: null,
        updated_at: null,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "ja")
  );
}

export interface ReferenceBookRow {
  id: number;
  book_name: string;
  cover_image_path: string | null;
  subject: string | null;
  created_at: string;
  updated_at: string;
}

export function getReferenceBook(
  bookName: string
): ReferenceBookRow | null {
  const name = bookName.trim();
  if (!name) return null;
  const row = getDb()
    .prepare(`SELECT * FROM reference_books WHERE book_name = ?`)
    .get(name) as ReferenceBookRow | undefined;
  return row ?? null;
}

export function ensureReferenceBook(
  bookName: string,
  subject?: string | null
): void {
  const name = bookName.trim();
  if (!name) return;
  const timestamp = nowIso();
  getDb()
    .prepare(
      `INSERT INTO reference_books
        (book_name, cover_image_path, subject, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT DO UPDATE SET
         subject = COALESCE(reference_books.subject, excluded.subject),
         updated_at = excluded.updated_at`
    )
    .run(name, subject?.trim() || null, timestamp, timestamp);
}

export function setReferenceBookCover(
  bookName: string,
  coverImagePath: string,
  subject?: string | null
): ReferenceBookRow {
  const name = bookName.trim();
  if (!name) {
    throw new Error("参考書名は必須です");
  }
  const timestamp = nowIso();
  const db = getDb();
  db.prepare(
    `INSERT INTO reference_books
      (book_name, cover_image_path, subject, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       cover_image_path = excluded.cover_image_path,
       subject = COALESCE(excluded.subject, reference_books.subject),
       updated_at = excluded.updated_at`
  ).run(name, coverImagePath, subject?.trim() || null, timestamp, timestamp);
  return getReferenceBook(name) as ReferenceBookRow;
}

export function clearReferenceBookCover(
  bookName: string
): string | null {
  const existing = getReferenceBook(bookName);
  if (!existing) return null;
  const db = getDb();
  db.prepare(
    `UPDATE reference_books
     SET cover_image_path = NULL, updated_at = ?
     WHERE book_name = ?`
  ).run(nowIso(), existing.book_name);

  const count = db
    .prepare(
      `SELECT COUNT(*) AS c FROM problems WHERE book_name = ? COLLATE NOCASE`
    )
    .get(existing.book_name) as { c: number };
  if (count.c === 0) {
    db.prepare(`DELETE FROM reference_books WHERE book_name = ?`).run(
      existing.book_name
    );
  }
  return existing.cover_image_path;
}

export function deleteReferenceBook(
  bookName: string,
  deleteProblems = true
): {
  deletedProblems: number;
  coverImagePath: string | null;
  found: boolean;
} {
  const name = bookName.trim();
  const existing = getReferenceBook(name);
  let deletedProblems = 0;
  const db = getDb();
  const transaction = db.transaction(() => {
    if (deleteProblems) {
      const info = db
        .prepare(
          `DELETE FROM problems WHERE book_name = ? COLLATE NOCASE`
        )
        .run(name);
      deletedProblems = info.changes;
    }
    db.prepare(`DELETE FROM reference_books WHERE book_name = ?`).run(name);
  });
  transaction();
  return {
    deletedProblems,
    coverImagePath: existing?.cover_image_path ?? null,
    found: Boolean(existing),
  };
}

export interface ProblemUpdateInput {
  subject?: string;
  difficulty?: number;
  fieldName?: string;
  bookName?: string;
  title?: string;
  body_latex?: string;
  answer_latex?: string;
  explanation_latex?: string;
  questionType?: QuestionType;
  targetWord?: string | null;
  options?: string[];
}

export function updateProblem(
  id: number,
  input: ProblemUpdateInput
): ProblemRow | null {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT p.*, f.name AS field_name
       FROM problems p LEFT JOIN fields f ON f.id = p.field_id
       WHERE p.id = ?`
    )
    .get(id) as ProblemRow | undefined;
  if (!existing) return null;

  const subject = input.subject?.trim() || existing.subject;
  const bookName =
    input.bookName !== undefined
      ? input.bookName.trim()
      : (existing.book_name ?? "").trim();
  if (!bookName) {
    throw new Error("参考書名は必須です");
  }

  const fieldName =
    input.fieldName !== undefined ? input.fieldName : existing.field_name ?? "";
  if (!fieldName.trim()) {
    throw new Error("分野は必須です");
  }
  const fieldId = resolveField(fieldName, subject);
  const body =
    input.body_latex !== undefined ? input.body_latex : existing.body_latex;
  if (!body.trim()) {
    throw new Error("問題文は必須です");
  }

  const options =
    input.options !== undefined
      ? JSON.stringify(
          input.options
            .map((option) => String(option).trim())
            .filter(Boolean)
            .slice(0, 12)
        )
      : existing.options_json;
  const difficulty =
    input.difficulty !== undefined
      ? normalizeDifficulty(input.difficulty)
      : existing.difficulty;
  const questionType =
    input.questionType !== undefined
      ? normalizeQuestionType(input.questionType)
      : normalizeQuestionType(existing.question_type);
  const targetWord =
    input.targetWord !== undefined ? input.targetWord : existing.target_word;
  const timestamp = nowIso();

  db.prepare(
    `UPDATE problems SET subject = ?, difficulty = ?, field_id = ?, book_name = ?,
       title = ?, body_latex = ?, answer_latex = ?, explanation_latex = ?,
       question_type = ?, target_word = ?, options_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    subject,
    difficulty,
    fieldId,
    bookName,
    input.title !== undefined ? input.title : existing.title,
    body,
    input.answer_latex !== undefined
      ? input.answer_latex
      : existing.answer_latex,
    input.explanation_latex !== undefined
      ? input.explanation_latex
      : existing.explanation_latex,
    questionType,
    targetWord,
    options,
    timestamp,
    id
  );

  ensureReferenceBook(bookName, subject);
  recordHistory("subject", subject);
  recordHistory("book", bookName);
  recordHistory("field", fieldName);
  recordHistory("difficulty", String(difficulty));
  recordHistory("question_type", questionType);

  return db
    .prepare(
      `SELECT p.*, f.name AS field_name
       FROM problems p LEFT JOIN fields f ON f.id = p.field_id
       WHERE p.id = ?`
    )
    .get(id) as ProblemRow;
}

export function countProblems(subject?: string): number {
  const db = getDb();
  const row = (
    subject
      ? db.prepare(`SELECT COUNT(*) AS c FROM problems WHERE subject = ?`).get(subject)
      : db.prepare(`SELECT COUNT(*) AS c FROM problems`).get()
  ) as { c: number };
  return row.c;
}

export interface CreateExamInput {
  title: string;
  subject: string;
  templateId: number | null;
  templateName: string;
  targetDifficulty: number;
  avgDifficulty: number;
  mode: GenerationMode;
  fields: Array<{ id: number; name: string }>;
  config: Record<string, unknown>;
  template: TemplateData;
  verification: Record<string, unknown>;
  items: ExamItem[];
  runs: RunLog[];
  verificationLogs: VerificationStep[];
}

export function createExam(input: CreateExamInput): number {
  const db = getDb();
  const timestamp = nowIso();

  const transaction = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO exams
          (title, subject, template_id, template_name, target_difficulty, avg_difficulty, mode,
           fields_json, config_json, template_json, verification_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.title,
        input.subject,
        input.templateId,
        input.templateName,
        input.targetDifficulty,
        input.avgDifficulty,
        input.mode,
        JSON.stringify(input.fields),
        JSON.stringify(input.config),
        JSON.stringify(input.template),
        JSON.stringify(input.verification),
        timestamp
      );
    const examId = Number(info.lastInsertRowid);

    const itemStmt = db.prepare(
      `INSERT INTO exam_items
        (exam_id, section_no, question_no, sort_order, difficulty, body_latex, answer_latex,
         explanation_latex, origin, problem_id, meta_json, question_type, target_word, options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    input.items.forEach((item, index) => {
      const options = Array.isArray(item.options)
        ? item.options.map((option) => String(option)).filter(Boolean).slice(0, 12)
        : [];
      itemStmt.run(
        examId,
        item.section_no,
        item.question_no,
        index,
        normalizeDifficulty(item.difficulty),
        item.body_latex,
        item.answer_latex,
        item.explanation_latex,
        item.origin,
        item.problem_id,
        JSON.stringify(item.meta ?? {}),
        normalizeQuestionType(item.question_type),
        item.target_word ?? null,
        JSON.stringify(options)
      );
    });

    const runStmt = db.prepare(
      `INSERT INTO generation_runs
        (exam_id, iteration, stage, message, issues_json, step, status, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const run of input.runs) {
      runStmt.run(
        examId,
        run.iteration,
        run.stage,
        run.message,
        JSON.stringify(run.issues),
        "",
        "",
        "{}",
        timestamp
      );
    }

    // 検算ログ（Step A〜D）は generation_runs にも詳細付きで記録する。
    for (const log of input.verificationLogs) {
      runStmt.run(
        examId,
        log.iteration,
        `Step ${log.step}`,
        log.summary,
        JSON.stringify(log.issues ?? []),
        log.step,
        log.status,
        JSON.stringify(log.detail ?? {}),
        timestamp
      );
    }

    const verificationStmt = db.prepare(
      `INSERT INTO verification_logs
        (exam_id, iteration, step, status, summary, issues_json, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const log of input.verificationLogs) {
      verificationStmt.run(
        examId,
        log.iteration,
        log.step,
        log.status,
        log.summary,
        JSON.stringify(log.issues ?? []),
        JSON.stringify(log.detail ?? {}),
        timestamp
      );
    }

    recordHistory("subject", input.subject);
    recordHistory("mode", input.mode);
    recordHistory("difficulty", String(input.targetDifficulty));
    recordHistory("section_count", String(input.template.sections.length));
    for (const section of input.template.sections) {
      recordHistory("question_count", String(section.subQuestions.length));
      if (section.title?.trim()) recordHistory("field", section.title);
    }

    return examId;
  });

  return transaction();
}

export function listExams(subject?: string): ExamRow[] {
  const db = getDb();
  const sql = `SELECT * FROM exams ${subject ? "WHERE subject = ?" : ""} ORDER BY created_at DESC`;
  return (subject ? db.prepare(sql).all(subject) : db.prepare(sql).all()) as ExamRow[];
}

export interface ExamItemRow extends ExamItem {
  id: number;
  sort_order: number;
  meta_json: string;
  options_json: string;
}

export interface VerificationLogRow extends VerificationStep {
  id: number;
  created_at: string;
  issues_json: string;
  detail_json: string;
}

export interface ExamDetail {
  exam: ExamRow;
  items: ExamItemRow[];
  runs: Array<RunLog & { id: number; created_at: string; issues_json: string }>;
  verificationLogs: VerificationLogRow[];
}

export function getExamDetail(id: number): ExamDetail | null {
  const db = getDb();
  const exam = db.prepare(`SELECT * FROM exams WHERE id = ?`).get(id) as ExamRow | undefined;
  if (!exam) return null;
  const itemRows = db
    .prepare(`SELECT * FROM exam_items WHERE exam_id = ? ORDER BY sort_order`)
    .all(id) as Array<Record<string, unknown>>;
  const items = itemRows.map((row) => ({
    ...row,
    question_type: normalizeQuestionType(row.question_type),
    options: parseJson<string[]>(String(row.options_json ?? "[]"), []),
  })) as unknown as ExamItemRow[];
  const runs = db
    .prepare(`SELECT * FROM generation_runs WHERE exam_id = ? ORDER BY iteration, id`)
    .all(id) as Array<RunLog & { id: number; created_at: string; issues_json: string }>;
  const verificationLogs = db
    .prepare(`SELECT * FROM verification_logs WHERE exam_id = ? ORDER BY iteration, id`)
    .all(id) as VerificationLogRow[];
  return { exam, items, runs, verificationLogs };
}

export function setExamPdfPath(id: number, kind: "question" | "answer", filename: string): void {
  const column = kind === "question" ? "question_pdf_path" : "answer_pdf_path";
  getDb().prepare(`UPDATE exams SET ${column} = ? WHERE id = ?`).run(filename, id);
}

export interface TemplateVersionRow {
  id: number;
  template_id: number;
  version: number;
  data_json: string;
  created_at: string;
}

export interface TemplateDetail {
  template: TemplateListItem;
  versions: TemplateVersionRow[];
}

export function getTemplateDetail(id: number): TemplateDetail | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT t.id, t.name, t.data_json, t.source_filename, t.updated_at
       FROM exam_templates t WHERE t.id = ?`
    )
    .get(id) as
    | {
        id: number;
        name: string;
        data_json: string;
        source_filename: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  const versions = db
    .prepare(
      `SELECT id, template_id, version, data_json, created_at
       FROM exam_template_versions WHERE template_id = ? ORDER BY version DESC`
    )
    .all(id) as TemplateVersionRow[];
  return {
    template: {
      id: row.id,
      name: row.name,
      data: normalizeTemplate(parseJson(row.data_json, {})),
      version: versions[0]?.version ?? 1,
      source_filename: row.source_filename,
      updated_at: row.updated_at,
    },
    versions,
  };
}

export function deleteTemplate(id: number): boolean {
  const info = getDb().prepare(`DELETE FROM exam_templates WHERE id = ?`).run(id);
  return info.changes > 0;
}

export function deleteTemplateVersion(templateId: number, versionId: number): boolean {
  const info = getDb()
    .prepare(`DELETE FROM exam_template_versions WHERE id = ? AND template_id = ?`)
    .run(versionId, templateId);
  return info.changes > 0;
}

export function deleteProblems(ids: number[]): number {
  const clean = ids.map(Number).filter((id) => Number.isFinite(id));
  if (clean.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`DELETE FROM problems WHERE id = ?`);
  const transaction = db.transaction(() =>
    clean.reduce((total, id) => total + Number(stmt.run(id).changes), 0)
  );
  return transaction();
}

export function deleteField(id: number): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM problems WHERE field_id = ?`)
    .get(id) as { c: number };
  if (row.c > 0) return false;
  return db.prepare(`DELETE FROM fields WHERE id = ?`).run(id).changes > 0;
}

export function cleanupOrphanFields(): { count: number; names: string[] } {
  const db = getDb();
  const transaction = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT f.id, f.name FROM fields f
         WHERE NOT EXISTS (SELECT 1 FROM problems p WHERE p.field_id = f.id)`
      )
      .all() as Array<{ id: number; name: string }>;
    const stmt = db.prepare(`DELETE FROM fields WHERE id = ?`);
    for (const row of rows) stmt.run(row.id);
    return rows.map((row) => row.name);
  });
  const names = transaction();
  return { count: names.length, names };
}

export interface DeleteExamResult {
  deleted: boolean;
  pdfFiles: string[];
}

function examPdfFiles(examId: number, stored: Array<string | null>): string[] {
  const files = new Set<string>();
  for (const name of stored) if (name) files.add(name);
  try {
    for (const name of fs.readdirSync(PDF_DIR)) {
      if (name === `exam-${examId}-question.pdf` || name === `exam-${examId}-answer.pdf`) {
        files.add(name);
      }
    }
  } catch {
    // PDFディレクトリが無い場合はDB上のパスのみ対象
  }
  return Array.from(files);
}

export function deleteExam(id: number): DeleteExamResult {
  const db = getDb();
  const exam = db
    .prepare(`SELECT question_pdf_path, answer_pdf_path FROM exams WHERE id = ?`)
    .get(id) as { question_pdf_path: string | null; answer_pdf_path: string | null } | undefined;
  if (!exam) return { deleted: false, pdfFiles: [] };
  const pdfFiles = examPdfFiles(id, [exam.question_pdf_path, exam.answer_pdf_path]);
  const info = db.prepare(`DELETE FROM exams WHERE id = ?`).run(id);
  return { deleted: info.changes > 0, pdfFiles };
}

export type ResetCategory = "templates" | "problems" | "fields" | "exams" | "uploads";

export interface ResetResult {
  templates: number;
  problems: number;
  fields: number;
  exams: number;
  pdfFiles: string[];
  coverFiles: string[];
}

export function resetData(categories: ResetCategory[]): ResetResult {
  const db = getDb();
  const selected = new Set(categories);
  const result: ResetResult = {
    templates: 0,
    problems: 0,
    fields: 0,
    exams: 0,
    pdfFiles: [],
    coverFiles: [],
  };

  const transaction = db.transaction(() => {
    if (selected.has("exams")) {
      const rows = db
        .prepare(
          `SELECT id, question_pdf_path, answer_pdf_path FROM exams`
        )
        .all() as Array<{
        id: number;
        question_pdf_path: string | null;
        answer_pdf_path: string | null;
      }>;
      for (const row of rows) {
        result.pdfFiles.push(
          ...examPdfFiles(row.id, [row.question_pdf_path, row.answer_pdf_path])
        );
      }
      result.exams = Number(db.prepare(`DELETE FROM exams`).run().changes);
    }
    if (selected.has("problems")) {
      const covers = db
        .prepare(
          `SELECT cover_image_path FROM reference_books
           WHERE cover_image_path IS NOT NULL`
        )
        .all() as Array<{ cover_image_path: string }>;
      result.coverFiles = covers.map((row) => row.cover_image_path);
      result.problems = Number(db.prepare(`DELETE FROM problems`).run().changes);
      db.prepare(`DELETE FROM reference_books`).run();
    }
    if (selected.has("templates")) {
      result.templates = Number(db.prepare(`DELETE FROM exam_templates`).run().changes);
    }
    if (selected.has("fields")) {
      result.fields = Number(db.prepare(`DELETE FROM fields`).run().changes);
    }
  });
  transaction();

  result.pdfFiles = Array.from(new Set(result.pdfFiles));
  return result;
}

export function countTemplates(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS c FROM exam_templates`).get() as { c: number }).c;
}

export function countExams(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS c FROM exams`).get() as { c: number }).c;
}
