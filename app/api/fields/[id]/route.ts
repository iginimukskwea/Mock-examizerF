import { NextResponse } from "next/server";
import { deleteField } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const fieldId = Number(id);
    if (!Number.isFinite(fieldId)) {
      return NextResponse.json({ error: "IDが不正です" }, { status: 400 });
    }
    const deleted = deleteField(fieldId);
    if (!deleted) {
      return NextResponse.json(
        { error: "未使用（問題0件）の分野のみ削除できます" },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "削除に失敗しました" },
      { status: 500 }
    );
  }
}
