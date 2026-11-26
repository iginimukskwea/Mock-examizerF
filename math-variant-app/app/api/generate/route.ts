import { NextResponse } from "next/server";
import { generateProblems } from "@/lib/gemini";
import type { Pair } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "GEMINI_API_KEY が設定されていません。math-variant-app/.env.local に設定してください。",
        },
        { status: 400 }
      );
    }

    const body = (await request.json()) as {
      pairs?: unknown;
      count?: unknown;
    };

    const count = Math.min(
      10,
      Math.max(1, Math.round(Number(body.count) || 3))
    );

    const pairs = (Array.isArray(body.pairs) ? body.pairs : []).filter(
      (pair): pair is Pair => {
        if (!pair || typeof pair !== "object") return false;
        const candidate = pair as Partial<Pair>;
        return Boolean(candidate.problem && candidate.answer);
      }
    );

    if (pairs.length === 0) {
      return NextResponse.json(
        { error: "解答が揃った問題ペアがありません。" },
        { status: 400 }
      );
    }

    const result = await generateProblems(pairs, count, apiKey);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "類題の生成に失敗しました。";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
