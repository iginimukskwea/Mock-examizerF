import { NextResponse } from "next/server";
import { deleteProblems } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.map(Number).filter((id) => Number.isFinite(id))
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "削除する問題を選択してください" }, { status: 400 });
    }
    const deleted = deleteProblems(ids);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "削除に失敗しました" },
      { status: 500 }
    );
  }
}
