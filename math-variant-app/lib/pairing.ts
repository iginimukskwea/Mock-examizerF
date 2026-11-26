import type { ExtractedItem, Pair } from "./types";

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
}

export function normalizePairKey(value: string): string {
  const normalized = toAsciiDigits(value)
    .replace(/\s+/g, "")
    .toLowerCase();
  const digits = normalized.match(/\d+/);
  return digits ? digits[0] : normalized;
}

function keysOf(item: ExtractedItem): string[] {
  const keys = [
    normalizePairKey(item.pair_key),
    normalizePairKey(item.number),
  ].filter(Boolean);
  if (keys.length === 0) {
    const titleKey = normalizePairKey(item.title);
    if (titleKey) keys.push(titleKey);
  }
  return Array.from(new Set(keys));
}

export interface PairingResult {
  pairs: Pair[];
  warnings: string[];
}

/**
 * 問題と解答を pair_key / 問題番号で対応付ける。
 * 一致しない問題が残った場合は、残った解答と順番で対応付け、status を order_matched にする。
 */
export function pairItems(items: ExtractedItem[]): PairingResult {
  const problems = items.filter((item) => item.kind === "problem");
  const answers = items.filter((item) => item.kind === "answer");
  const warnings: string[] = [];

  if (problems.length === 0) {
    warnings.push("問題（problem）が見つかりませんでした。ファイルの内容を確認してください。");
    return { pairs: [], warnings };
  }

  const answerQueues = new Map<string, number[]>();
  answers.forEach((answer, index) => {
    for (const key of keysOf(answer)) {
      const queue = answerQueues.get(key) ?? [];
      queue.push(index);
      answerQueues.set(key, queue);
    }
  });

  const usedAnswers = new Set<number>();
  const pairs: Pair[] = [];

  problems.forEach((problem, problemIndex) => {
    let answerIndex: number | null = null;

    for (const key of keysOf(problem)) {
      const queue = answerQueues.get(key);
      if (!queue) continue;
      const candidate = queue.find((index) => !usedAnswers.has(index));
      if (candidate !== undefined) {
        answerIndex = candidate;
        break;
      }
    }

    const key =
      problem.pair_key ||
      problem.number ||
      problem.title ||
      `problem-${problemIndex + 1}`;

    if (answerIndex !== null) {
      usedAnswers.add(answerIndex);
      pairs.push({
        key,
        problem,
        answer: answers[answerIndex],
        status: "matched",
        figureOnly: problem.figure_only,
      });
      return;
    }

    pairs.push({
      key,
      problem,
      answer: null,
      status: "missing_answer",
      figureOnly: problem.figure_only,
    });
  });

  const unmatchedProblems = pairs.filter((pair) => !pair.answer);
  const unusedAnswers = answers.filter((_, index) => !usedAnswers.has(index));
  const orderPairCount = Math.min(unmatchedProblems.length, unusedAnswers.length);

  for (let index = 0; index < orderPairCount; index += 1) {
    const pair = unmatchedProblems[index];
    pair.answer = unusedAnswers[index];
    pair.status = "order_matched";
    warnings.push(
      `「${pair.problem.number || pair.problem.title || pair.key}」は番号一致がなかったため、残った解答と順番で対応付けました。`
    );
  }

  const orphanAnswers = unusedAnswers.length - orderPairCount;
  if (orphanAnswers > 0) {
    warnings.push(`対応する問題がない解答が${orphanAnswers}件あります。`);
  }

  const missingAnswers = pairs.filter((pair) => !pair.answer).length;
  if (missingAnswers > 0) {
    warnings.push(`解答が見つからない問題が${missingAnswers}件あります。`);
  }

  return { pairs, warnings };
}
