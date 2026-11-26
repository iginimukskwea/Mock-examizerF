import fs from "node:fs";
import { NextResponse } from "next/server";
import { aiMode, aiModeLabel } from "@/lib/ai";
import {
  UPLOAD_DIR,
  countExams,
  countProblems,
  countTemplates,
  listBooks,
  listFields,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function countUploads(): number {
  try {
    return fs.readdirSync(UPLOAD_DIR).length;
  } catch {
    return 0;
  }
}

export async function GET() {
  const fields = listFields();
  return NextResponse.json({
    mode: aiMode(),
    label: aiModeLabel(),
    problemCount: countProblems(),
    templateCount: countTemplates(),
    bookCount: listBooks().length,
    examCount: countExams(),
    fieldCount: fields.length,
    uploadCount: countUploads(),
    fields,
  });
}
