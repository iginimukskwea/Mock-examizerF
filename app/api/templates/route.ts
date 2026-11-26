import { NextResponse } from "next/server";
import { listTemplates, saveTemplate } from "@/lib/db";
import { normalizeTemplate } from "@/lib/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ templates: listTemplates() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "一覧の取得に失敗しました" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      data?: unknown;
      source_filename?: string | null;
    };
    const name = String(body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ error: "模試名を入力してください" }, { status: 400 });
    }
    const data = normalizeTemplate(body.data);
    const result = saveTemplate(name, data, body.source_filename ?? null);
    return NextResponse.json({ ok: true, ...result, data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存に失敗しました" },
      { status: 500 }
    );
  }
}
