import type { AnswerFormat, Issue, QuestionType, TemplateData } from "./types";

export interface CheckableItem {
  section_no: number;
  question_no: number;
  body_latex: string;
  answer_latex: string;
  explanation_latex?: string;
  question_type?: QuestionType;
  target_word?: string | null;
  options?: string[];
}

function locationOf(item: CheckableItem): string {
  return `第${item.section_no}問（${item.question_no}）`;
}

function probabilityFractions(text: string): Array<[number, number]> {
  const fractions: Array<[number, number]> = [];
  const plain = /(\d+)\s*\/\s*(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = plain.exec(text)) !== null) {
    fractions.push([Number(match[1]), Number(match[2])]);
  }
  const latex = /\\frac\s*\{\s*(\d+)\s*\}\s*\{\s*(\d+)\s*\}/g;
  while ((match = latex.exec(text)) !== null) {
    fractions.push([Number(match[1]), Number(match[2])]);
  }
  return fractions;
}

function braceIssues(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return true;
  }
  return depth !== 0;
}

export function numericChecks(items: CheckableItem[]): Issue[] {
  const issues: Issue[] = [];

  for (const item of items) {
    const text = `${item.body_latex}\n${item.answer_latex}`;
    const location = locationOf(item);
    const push = (type: string, message: string, severity: Issue["severity"] = "error") => {
      issues.push({ type, severity, message, location });
    };

    const negativeCount = text.match(/-\s*\d+(?:\.\d+)?\s*(?:個|人|本|枚|匹|台|冊|組|点)/g);
    if (negativeCount) {
      push("negative_count", `個数が負になっています: ${negativeCount[0]}`);
    }

    const negativeLength = text.match(
      /(?:長さ|距離|半径|高さ|面積|体積|質量|重さ|金額|代金|速さ)[^。\n]{0,15}?-\s*\d+(?:\.\d+)?/
    );
    if (negativeLength) {
      push("negative_quantity", `量が負になっています: ${negativeLength[0]}`);
    }

    const fractionalCount = text.match(/\d+\.\d+\s*(?:個|人|本|枚|匹|台|冊|組)/g);
    if (fractionalCount) {
      push("fractional_count", `個数が整数になっていません: ${fractionalCount[0]}`);
    }

    if (/確率|割合|当選|場合の数/.test(text)) {
      for (const [numerator, denominator] of probabilityFractions(text)) {
        if (denominator === 0) {
          push("probability_denominator", "確率の分母が0になっています");
        } else if (numerator > denominator) {
          push("probability_over_one", `確率が1を超えています: ${numerator}/${denominator}`);
        } else if (numerator < 0 || denominator < 0) {
          push("probability_negative", "確率が負になっています");
        }
      }
      const percent = text.match(/(\d{3,})\s*%/);
      if (percent && Number(percent[1]) > 100) {
        push("probability_over_100", `確率が100%を超えています: ${percent[1]}%`);
      }
      if (/確率[^。\n]{0,12}?1\.[1-9]\d*|確率[^。\n]{0,12}?[2-9]\.\d+/.test(text)) {
        push("probability_over_one", "確率が1を超える小数になっています");
      }
    }

    if (/\\sqrt\s*\{\s*-\d|√\s*\(?\s*-\d/.test(text)) {
      push("negative_sqrt", "負の数の平方根が含まれています");
    }

    if (/\\log(?:_\{?\w+\}?)?\s*\(?\s*(?:0(?![\d.])|-\d)/.test(text)) {
      push("log_domain", "真数条件を満たさない対数が含まれています");
    }

    if (/\\frac\s*\{[^{}]*\}\s*\{\s*0\s*\}/.test(text)) {
      push("zero_division", "0で割る式が含まれています");
    }

    if (braceIssues(text)) {
      push("latex_brace", "LaTeXの波括弧が対応していません", "warning");
    }

    const dollarCount = (text.match(/\$/g) ?? []).length;
    if (dollarCount % 2 !== 0) {
      push("latex_math_delimiter", "数式の$記号が閉じていません", "warning");
    }

    if (/\b(?:TODO|FIXME|NaN|undefined)\b/.test(text)) {
      push("placeholder", "未確定のプレースホルダが残っています");
    }

    if (!item.answer_latex.trim()) {
      push("missing_answer", "解答が空です", "warning");
    }
  }

  return issues;
}

function formatOf(
  template: TemplateData | undefined,
  sectionNo: number,
  questionNo: number
): AnswerFormat | null {
  if (!template) return null;
  const section = template.sections.find((entry) => entry.no === sectionNo);
  const sub = section?.subQuestions.find((entry) => entry.no === questionNo);
  return sub?.format ?? null;
}

function triangleIssues(text: string): string | null {
  if (!/三角形/.test(text)) return null;

  const declared = Array.from(
    text.matchAll(/(?:辺\s*)?(?:[abcxyz]|AB|BC|CA|XY|YZ|ZX)\s*[=＝]\s*(\d+(?:\.\d+)?)/gi)
  ).map((match) => Number(match[1]));
  const listed = text.match(
    /(\d+(?:\.\d+)?)\s*[,、]\s*(\d+(?:\.\d+)?)\s*[,、]\s*(\d+(?:\.\d+)?)/
  );
  const sides = declared.length >= 3 ? declared.slice(0, 3) : listed
    ? [Number(listed[1]), Number(listed[2]), Number(listed[3])]
    : [];

  if (sides.length !== 3 || sides.some((value) => !Number.isFinite(value) || value <= 0)) {
    return null;
  }
  const sorted = [...sides].sort((a, b) => a - b);
  if (sorted[2] >= sorted[0] + sorted[1]) {
    return `三角形の成立条件を満たしません（${sorted.join(", ")}: 最長辺が他の2辺の和以上）`;
  }
  return null;
}

export function domainChecks(
  items: CheckableItem[],
  template?: TemplateData
): Issue[] {
  const issues: Issue[] = [];
  const digitLimitMatch = template?.answerFormatRules.fillBlankDigits.match(/(\d+)/);
  const digitLimit = digitLimitMatch ? Number(digitLimitMatch[1]) : null;

  for (const item of items) {
    const text = `${item.body_latex}\n${item.answer_latex}`;
    const location = locationOf(item);
    const push = (type: string, message: string, severity: Issue["severity"] = "error") => {
      issues.push({ type, severity, message, location });
    };

    for (const match of text.matchAll(
      /(?:^|[^\d.-])0\s*(?:個|人|本|枚|匹|台|冊|組|回)/g
    )) {
      push("non_positive_count", `個数・回数が0以下になっています: ${match[0].trim()}`);
    }
    for (const match of text.matchAll(/(?:^|[^\d.-])0\s*(?:秒|分|時間)/g)) {
      push("non_positive_time", `時間が0以下になっています: ${match[0].trim()}`);
    }

    const negativePhysical = text.match(
      /(?:質量|重さ|絶対温度|温度|ケルビン|体積|密度)\s*(?:が|は|を)?\s*-\s*\d+(?:\.\d+)?/
    );
    if (negativePhysical) {
      push("negative_physical", `質量・温度などの物理量が負になっています: ${negativePhysical[0]}`);
    }

    const triangle = triangleIssues(text);
    if (triangle) push("triangle_inequality", triangle);

    if (digitLimit !== null) {
      const format = formatOf(template, item.section_no, item.question_no);
      if (format === "fill_blank") {
        const numbers = item.answer_latex.match(/\d+/g) ?? [];
        const tooLong = numbers.find((value) => value.replace(/^0+/, "").length > digitLimit);
        if (tooLong) {
          push(
            "fill_blank_digits",
            `穴埋めの解答「${tooLong}」が桁数上限（${digitLimit}桁）を超えています`
          );
        }
      }
    }
  }

  return issues;
}

function normalizeWord(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s「」『』（）()、。，,.\-—–'"]/g, "");
}

export function wordFillChecks(items: CheckableItem[]): Issue[] {
  const issues: Issue[] = [];

  for (const item of items) {
    if (item.question_type !== "word_fill") continue;
    const location = locationOf(item);
    const target = (item.target_word ?? "").trim();
    if (!target) {
      issues.push({
        type: "word_fill_target_missing",
        severity: "warning",
        message: "語句補充の正解語句（target_word）が設定されていません",
        location,
      });
      continue;
    }

    if (normalizeWord(item.body_latex).includes(normalizeWord(target))) {
      issues.push({
        type: "word_fill_self_leak",
        severity: "error",
        message: `空所の正解「${target}」が問題文にそのまま露出しています`,
        location,
      });
    }

    for (const other of items) {
      if (other === item || other.section_no !== item.section_no) continue;
      const haystack = `${other.body_latex}\n${other.explanation_latex ?? ""}`;
      if (normalizeWord(haystack).includes(normalizeWord(target))) {
        issues.push({
          type: "word_fill_context_leak",
          severity: "error",
          message: `同じ大問の小問（${other.question_no}）の問題文・解説に正解「${target}」が露出しています`,
          location,
        });
      }
    }

    if (item.options && item.options.length > 0) {
      const matches = item.options.filter(
        (option) => normalizeWord(option) === normalizeWord(target)
      ).length;
      if (matches !== 1) {
        issues.push({
          type: "word_fill_options",
          severity: "error",
          message: `選択肢に正解「${target}」が1つだけ含まれていません（${matches}件）`,
          location,
        });
      }
    }
  }

  return issues;
}

export function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const result: Issue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}|${issue.type}|${issue.message}|${issue.location ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}
