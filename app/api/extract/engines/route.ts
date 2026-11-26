import { NextResponse } from "next/server";
import { detectPythonOcr } from "@/lib/python-ocr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const python = await detectPythonOcr();
    return NextResponse.json({
      pdfLayout: true,
      tesseract: true,
      python: {
        available: python.available,
        engines: python.engines,
        version: python.version,
        error: python.error,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        pdfLayout: true,
        tesseract: true,
        python: {
          available: false,
          engines: [],
          version: null,
          error:
            error instanceof Error
              ? error.message
              : "OCRエンジン状態の取得に失敗しました",
        },
      },
      { status: 500 }
    );
  }
}
