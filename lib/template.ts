import {
  ANSWER_FORMATS,
  SCAFFOLDING_TYPES,
  type AnswerFormat,
  type AnswerFormatRules,
  type DifficultyCurveSection,
  type DifficultyCurveSpec,
  type LayoutDensity,
  type PreambleConventions,
  type ScaffoldingType,
  type SectionSpec,
  type SubQuestionSpec,
  type TemplateData,
  type TemplateSummary,
} from "./types";

export const DEFAULT_TEMPLATE: TemplateData = {
  schemaVersion: 1,
  examMinutes: 60,
  totalScore: 100,
  sections: [
    {
      no: 1,
      title: "小問集合",
      points: 25,
      induction: "",
      subQuestions: [
        { no: 1, format: "written", points: 5 },
        { no: 2, format: "written", points: 5 },
        { no: 3, format: "choice", points: 5 },
        { no: 4, format: "fill_blank", points: 5 },
        { no: 5, format: "written", points: 5 },
      ],
    },
    {
      no: 2,
      title: "図形と計量",
      points: 25,
      induction: "（1）→（2）→（3）と誘導",
      subQuestions: [
        { no: 1, format: "written", points: 8 },
        { no: 2, format: "written", points: 8 },
        { no: 3, format: "written", points: 9 },
      ],
    },
    {
      no: 3,
      title: "確率",
      points: 25,
      induction: "",
      subQuestions: [
        { no: 1, format: "written", points: 8 },
        { no: 2, format: "written", points: 8 },
        { no: 3, format: "written", points: 9 },
      ],
    },
    {
      no: 4,
      title: "微分・積分",
      points: 25,
      induction: "（1）の結果を（2）で利用",
      subQuestions: [
        { no: 1, format: "written", points: 8 },
        { no: 2, format: "written", points: 8 },
        { no: 3, format: "written", points: 9 },
      ],
    },
  ],
  layout: {
    columns: 2,
    headerFormat: "模試名 / 教科 / 試験時間 / 総配点",
    showPoints: true,
    answerStyle: "記述式（解答欄は罫線）",
  },
  extras: {},
  difficultyCurve: {
    overall: "",
    hopStepJump: "",
    sections: [],
  },
  scaffoldingType: "mixed",
  answerFormatRules: {
    fillBlankDigits: "",
    fractionRules: "既約分数で解答する",
    surdRules: "根号内を最も簡単な形にする",
    writtenInstructions: "",
  },
  preambleConventions: {
    preambleBlock: "",
    constants: "",
    significantFigures: "",
    variableNaming: "",
  },
  layoutDensity: {
    leadText: "",
    dialogue: "",
    figures: "",
    whitespace: "",
  },
};

function asFormat(value: unknown): AnswerFormat {
  return ANSWER_FORMATS.includes(value as AnswerFormat)
    ? (value as AnswerFormat)
    : "written";
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function asScaffolding(value: unknown): ScaffoldingType {
  return SCAFFOLDING_TYPES.includes(value as ScaffoldingType)
    ? (value as ScaffoldingType)
    : "mixed";
}

function normalizeCurve(raw: Record<string, unknown>): DifficultyCurveSpec {
  const curve = asRecord(pick(raw, "difficulty_curve", "difficultyCurve"));
  const rawSections = Array.isArray(curve.sections) ? curve.sections : [];
  const sections: DifficultyCurveSection[] = rawSections.slice(0, 12).map((entry, index) => {
    const row = asRecord(entry);
    return {
      no: index + 1,
      trend: asText(pick(row, "trend", "curve", "difficulty")),
      subGradient: asText(pick(row, "sub_gradient", "subGradient", "gradient")),
    };
  });
  return {
    overall: asText(pick(curve, "overall", "summary")),
    hopStepJump: asText(pick(curve, "hop_step_jump", "hopStepJump", "hops")),
    sections,
  };
}

function normalizeAnswerFormatRules(raw: Record<string, unknown>): AnswerFormatRules {
  const rules = asRecord(pick(raw, "answer_format_rules", "answerFormatRules"));
  const defaults = DEFAULT_TEMPLATE.answerFormatRules;
  return {
    fillBlankDigits: asText(
      pick(rules, "fill_blank_digits", "fillBlankDigits"),
      defaults.fillBlankDigits
    ),
    fractionRules: asText(
      pick(rules, "fraction_rules", "fractionRules"),
      defaults.fractionRules
    ),
    surdRules: asText(pick(rules, "surd_rules", "surdRules"), defaults.surdRules),
    writtenInstructions: asText(
      pick(rules, "written_instructions", "writtenInstructions"),
      defaults.writtenInstructions
    ),
  };
}

function normalizePreambleConventions(raw: Record<string, unknown>): PreambleConventions {
  const preamble = asRecord(pick(raw, "preamble_conventions", "preambleConventions"));
  const defaults = DEFAULT_TEMPLATE.preambleConventions;
  return {
    preambleBlock: asText(
      pick(preamble, "preamble_block", "preambleBlock"),
      defaults.preambleBlock
    ),
    constants: asText(preamble.constants, defaults.constants),
    significantFigures: asText(
      pick(preamble, "significant_figures", "significantFigures"),
      defaults.significantFigures
    ),
    variableNaming: asText(
      pick(preamble, "variable_naming", "variableNaming"),
      defaults.variableNaming
    ),
  };
}

function normalizeLayoutDensity(raw: Record<string, unknown>): LayoutDensity {
  const density = asRecord(pick(raw, "layout_density", "layoutDensity"));
  const defaults = DEFAULT_TEMPLATE.layoutDensity;
  return {
    leadText: asText(pick(density, "lead_text", "leadText"), defaults.leadText),
    dialogue: asText(density.dialogue, defaults.dialogue),
    figures: asText(density.figures, defaults.figures),
    whitespace: asText(density.whitespace, defaults.whitespace),
  };
}

export function normalizeTemplate(rawInput: unknown): TemplateData {
  const raw = asRecord(rawInput);
  const layout = asRecord(raw.layout);
  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];

  const sections: SectionSpec[] = rawSections.slice(0, 12).map((section, sIndex) => {
    const sec = asRecord(section);
    const rawSubs = Array.isArray(sec.subQuestions) ? sec.subQuestions : [];
    const subQuestions: SubQuestionSpec[] = rawSubs.slice(0, 20).map((sub, qIndex) => {
      const sq = asRecord(sub);
      return {
        no: qIndex + 1,
        format: asFormat(sq.format),
        points: Math.round(asNumber(sq.points, 0, 0, 200)),
        answerSpace: asText(sq.answerSpace),
        note: asText(sq.note),
      };
    });
    return {
      no: sIndex + 1,
      title: asText(sec.title),
      points: Math.round(asNumber(sec.points, 0, 0, 500)),
      induction: asText(sec.induction),
      subQuestions:
        subQuestions.length > 0 ? subQuestions : [{ no: 1, format: "written", points: 0 }],
    };
  });

  return {
    schemaVersion: 1,
    examMinutes: Math.round(asNumber(raw.examMinutes, 60, 1, 600)),
    totalScore: Math.round(asNumber(raw.totalScore, 100, 1, 1000)),
    sections: sections.length > 0 ? sections : DEFAULT_TEMPLATE.sections,
    layout: {
      columns: layout.columns === 1 ? 1 : 2,
      headerFormat: asText(layout.headerFormat, DEFAULT_TEMPLATE.layout.headerFormat),
      showPoints:
        typeof layout.showPoints === "boolean"
          ? layout.showPoints
          : DEFAULT_TEMPLATE.layout.showPoints,
      answerStyle: asText(layout.answerStyle, DEFAULT_TEMPLATE.layout.answerStyle),
    },
    extras: asRecord(raw.extras),
    difficultyCurve: normalizeCurve(raw),
    scaffoldingType: asScaffolding(pick(raw, "scaffolding_type", "scaffoldingType")),
    answerFormatRules: normalizeAnswerFormatRules(raw),
    preambleConventions: normalizePreambleConventions(raw),
    layoutDensity: normalizeLayoutDensity(raw),
  };
}

export function summarizeTemplate(data: TemplateData): TemplateSummary {
  const formats = new Set<AnswerFormat>();
  let subQuestionCount = 0;
  for (const section of data.sections) {
    for (const sub of section.subQuestions) {
      formats.add(sub.format);
      subQuestionCount += 1;
    }
  }
  return {
    sectionCount: data.sections.length,
    subQuestionCount,
    formats: Array.from(formats),
  };
}

export function countSubQuestions(data: TemplateData): number {
  return data.sections.reduce((total, section) => total + section.subQuestions.length, 0);
}

function extractTotal(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

export function heuristicTemplate(text: string): TemplateData {
  const source = text.replace(/\r/g, "");
  const examMinutes = extractTotal(source, /(\d{2,3})\s*分/);
  const totalScore = extractTotal(source, /(?:合計|総点|配点)\s*[：:]?\s*(\d{2,3})\s*点/);

  const sectionMatches = source.match(/大問\s*\d+|第\s*\d+\s*問|^[ⅠⅡⅢⅣⅤⅥ]\s/gm) ?? [];
  const sectionCount = Math.min(8, Math.max(1, sectionMatches.length));

  const formats: AnswerFormat[] = [];
  if (/選択|ア\s*[〜~]\s*エ|正誤/.test(source)) formats.push("choice");
  if (/穴埋め|空欄/.test(source)) formats.push("fill_blank");
  formats.push("written");

  const sections: SectionSpec[] = Array.from({ length: sectionCount }).map((_, index) => {
    const subCount = sectionCount === 1 ? 5 : 3;
    return {
      no: index + 1,
      title: "",
      points: 0,
      induction: /誘導/.test(source) ? "誘導あり" : "",
      subQuestions: Array.from({ length: subCount }).map((__, qIndex) => ({
        no: qIndex + 1,
        format: formats[(index + qIndex) % formats.length],
        points: 0,
      })),
    };
  });

  const columns: 1 | 2 = /2\s*段|二段|２段/.test(source) ? 2 : 2;
  const hasInduction = /誘導|前問|前の問|(?:\(|（)[1-9](?:\)|）).{0,12}(?:利用|用いて)/.test(source);

  return normalizeTemplate({
    schemaVersion: 1,
    examMinutes: examMinutes ?? 60,
    totalScore: totalScore ?? 100,
    sections,
    layout: {
      columns,
      headerFormat: "模試名 / 教科 / 試験時間 / 総配点",
      showPoints: /配点/.test(source),
      answerStyle: /マーク|選択/.test(source) ? "選択式（マーク）" : "記述式（罫線）",
    },
    extras: { heuristic: true },
    difficulty_curve: {
      overall: "",
      hop_step_jump: "",
      sections: sections.map((section) => ({
        no: section.no,
        trend: "",
        sub_gradient: "",
      })),
    },
    scaffolding_type: hasInduction ? "mixed" : "independent",
    answer_format_rules: {
      fill_blank_digits: "",
      fraction_rules: "既約分数で解答する",
      surd_rules: "根号内を最も簡単な形にする",
      written_instructions: "",
    },
    preamble_conventions: {
      preamble_block: "",
      constants: "",
      significant_figures: "",
      variable_naming: "",
    },
    layout_density: {
      lead_text: "",
      dialogue: "",
      figures: "",
      whitespace: /余白|ゆったり/.test(source) ? "余白を広めに取る" : "",
    },
  });
}
