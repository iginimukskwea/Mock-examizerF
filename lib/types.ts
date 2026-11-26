export const SUBJECTS = [
  "数学ⅠA",
  "数学ⅡB",
  "数学ⅢC",
  "化学",
  "物理",
  "生物",
  "地学",
  "情報",
  "その他",
] as const;

export type Subject = (typeof SUBJECTS)[number];

export const DIFFICULTY_LABELS: Record<number, string> = {
  1: "基礎",
  2: "標準",
  3: "やや応用",
  4: "発展",
  5: "難関",
};

export const ANSWER_FORMATS = ["written", "choice", "fill_blank"] as const;
export type AnswerFormat = (typeof ANSWER_FORMATS)[number];

export const ANSWER_FORMAT_LABELS: Record<AnswerFormat, string> = {
  written: "記述",
  choice: "選択",
  fill_blank: "穴埋め",
};

export const QUESTION_TYPES = ["calculation", "word_fill", "knowledge"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  calculation: "計算・記述",
  word_fill: "語句補充",
  knowledge: "知識問題",
};

export function normalizeQuestionType(value: unknown): QuestionType {
  return QUESTION_TYPES.includes(value as QuestionType)
    ? (value as QuestionType)
    : "calculation";
}

export const SCAFFOLDING_TYPES = [
  "numeric_chain",
  "lemma",
  "generalize",
  "independent",
  "mixed",
] as const;
export type ScaffoldingType = (typeof SCAFFOLDING_TYPES)[number];

export const SCAFFOLDING_LABELS: Record<ScaffoldingType, string> = {
  numeric_chain: "数値引き継ぎ型",
  lemma: "補題利用型",
  generalize: "具体から一般化型",
  independent: "独立型",
  mixed: "複合型",
};

export interface DifficultyCurveSection {
  no: number;
  trend: string;
  subGradient: string;
}

export interface DifficultyCurveSpec {
  overall: string;
  hopStepJump: string;
  sections: DifficultyCurveSection[];
}

export interface AnswerFormatRules {
  fillBlankDigits: string;
  fractionRules: string;
  surdRules: string;
  writtenInstructions: string;
}

export interface PreambleConventions {
  preambleBlock: string;
  constants: string;
  significantFigures: string;
  variableNaming: string;
}

export interface LayoutDensity {
  leadText: string;
  dialogue: string;
  figures: string;
  whitespace: string;
}

export interface TemplateAdvanced {
  difficultyCurve: DifficultyCurveSpec;
  scaffoldingType: ScaffoldingType;
  answerFormatRules: AnswerFormatRules;
  preambleConventions: PreambleConventions;
  layoutDensity: LayoutDensity;
}

export interface SubQuestionSpec {
  no: number;
  format: AnswerFormat;
  points?: number;
  answerSpace?: string;
  note?: string;
}

export interface SectionSpec {
  no: number;
  title?: string;
  points?: number;
  induction?: string;
  subQuestions: SubQuestionSpec[];
}

export interface LayoutSpec {
  columns: 1 | 2;
  headerFormat: string;
  showPoints: boolean;
  answerStyle: string;
}

export interface TemplateData {
  schemaVersion: number;
  examMinutes: number;
  totalScore: number;
  sections: SectionSpec[];
  layout: LayoutSpec;
  extras: Record<string, unknown>;
  difficultyCurve: DifficultyCurveSpec;
  scaffoldingType: ScaffoldingType;
  answerFormatRules: AnswerFormatRules;
  preambleConventions: PreambleConventions;
  layoutDensity: LayoutDensity;
}

export type GenerationMode = "numeric_variant" | "fusion";

export const GENERATION_MODE_LABELS: Record<GenerationMode, string> = {
  numeric_variant: "数違い",
  fusion: "融合",
};

export interface TemplateSummary {
  sectionCount: number;
  subQuestionCount: number;
  formats: AnswerFormat[];
}

export interface ProblemRow {
  id: number;
  subject: string;
  difficulty: number;
  field_id: number | null;
  field_name: string | null;
  title: string | null;
  body_latex: string;
  answer_latex: string;
  explanation_latex: string;
  source_filename: string | null;
  book_name: string | null;
  question_type: QuestionType;
  target_word: string | null;
  options_json: string;
  created_at: string;
  updated_at: string;
}

export interface ExtractedProblem {
  title: string;
  body_latex: string;
  answer_latex: string;
  explanation_latex: string;
  suggested_field: string;
  suggested_difficulty: number;
  question_type?: QuestionType;
  target_word?: string;
  options?: string[];
}

export type ItemOrigin = "original" | "numeric_variant" | "fusion_chain";

export interface ExamItem {
  section_no: number;
  question_no: number;
  difficulty: number;
  body_latex: string;
  answer_latex: string;
  explanation_latex: string;
  origin: ItemOrigin;
  problem_id: number | null;
  meta?: Record<string, unknown>;
  question_type?: QuestionType;
  target_word?: string | null;
  options?: string[];
}

export interface Issue {
  type: string;
  severity: "error" | "warning";
  message: string;
  location?: string;
}

export interface RunLog {
  iteration: number;
  stage: string;
  message: string;
  issues: Issue[];
}

export type VerificationStatus = "pass" | "fail" | "warn" | "skip";

export interface VerificationStep {
  iteration: number;
  step: string;
  status: VerificationStatus;
  summary: string;
  issues: Issue[];
  detail: Record<string, unknown>;
}

export interface ExamRow {
  id: number;
  title: string;
  subject: string;
  template_id: number | null;
  template_name: string;
  target_difficulty: number;
  avg_difficulty: number;
  mode: GenerationMode;
  fields_json: string;
  config_json: string;
  template_json: string;
  verification_json: string;
  question_pdf_path: string | null;
  answer_pdf_path: string | null;
  created_at: string;
}

export function normalizeDifficulty(value: unknown, fallback = 3): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, n));
}
