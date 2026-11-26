export type ItemKind = "problem" | "answer";

export interface ExtractedItem {
  kind: ItemKind;
  pair_key: string;
  number: string;
  title: string;
  body_latex: string;
  figure_only: boolean;
  source_file: string;
}

export type PairStatus = "matched" | "order_matched" | "missing_answer";

export interface Pair {
  key: string;
  problem: ExtractedItem;
  answer: ExtractedItem | null;
  status: PairStatus;
  figureOnly: boolean;
}

export interface Skipped {
  source_number: string;
  reason: string;
}

export interface GeneratedProblem {
  title: string;
  source_number: string;
  body_latex: string;
  answer_latex: string;
  explanation_latex: string;
}

export interface ExtractResponse {
  items: ExtractedItem[];
  pairs: Pair[];
  warnings: string[];
}

export interface GenerateResponse {
  problems: GeneratedProblem[];
  skipped: Skipped[];
  warnings: string[];
}
