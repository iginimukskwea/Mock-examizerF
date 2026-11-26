import { NextResponse } from "next/server";
import { cleanupOrphanFields } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = cleanupOrphanFields();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "整理に失敗しました" },
      { status: 500 }
    );
  }
}
