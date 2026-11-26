import { NextResponse } from "next/server";
import { deleteTemplateVersion } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; versionId: string }> }
) {
  try {
    const { id, versionId } = await context.params;
    const templateId = Number(id);
    const targetVersion = Number(versionId);
    if (!Number.isFinite(templateId) || !Number.isFinite(targetVersion)) {
      return NextResponse.json({ error: "IDが不正です" }, { status: 400 });
    }
    const deleted = deleteTemplateVersion(templateId, targetVersion);
    if (!deleted) {
      return NextResponse.json({ error: "版が見つかりません" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "削除に失敗しました" },
      { status: 500 }
    );
  }
}
