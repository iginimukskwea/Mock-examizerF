import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  PDFiumDocument,
  PDFiumLibrary as PDFiumLibraryType,
} from "@hyzyla/pdfium";
import { DATA_DIR } from "./db";
import {
  detectPythonOcr,
  runPythonOcr,
  type PythonOcrEngine,
} from "./python-ocr";

const TESSDATA_DIR = path.join(DATA_DIR, "tessdata");
const OCR_MAX_PAGES = 60;
const OCR_TEXT_THRESHOLD = 20;
const OCR_RENDER_SCALE = 2;
const OCR_HQ_RENDER_SCALE = 1.6;

export type OcrEngine =
  | "python_pix2text"
  | "python_rapidocr"
  | "python_paddleocr"
  | "tesseract"
  | "none";

export interface OcrImageResult {
  text: string;
  engine: OcrEngine;
  engineLabel: string;
  warnings: string[];
}

export interface PdfHighQualityOcrResult {
  pages: Record<number, string>;
  engines: Record<number, OcrEngine>;
  warnings: string[];
  engine: OcrEngine;
}

export function ocrEngineLabel(engine: OcrEngine): string {
  switch (engine) {
    case "python_pix2text":
      return "Python高精度OCR（Pix2Text）";
    case "python_rapidocr":
      return "Python高精度OCR（RapidOCR）";
    case "python_paddleocr":
      return "Python高精度OCR（PaddleOCR）";
    case "tesseract":
      return "前処理付きTesseract.js（jpn+eng）";
    default:
      return "OCR未使用／失敗";
  }
}

function pythonToOcrEngine(engine: PythonOcrEngine | "none"): OcrEngine {
  if (engine === "pix2text") return "python_pix2text";
  if (engine === "rapidocr") return "python_rapidocr";
  if (engine === "paddleocr") return "python_paddleocr";
  return "none";
}

function imageExtension(buffer: Buffer): string {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return ".jpg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return ".png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  return ".png";
}

async function preprocessImageForOcr(
  buffer: Buffer
): Promise<{ buffer: Buffer; warning?: string }> {
  try {
    const canvasModule = await import("@napi-rs/canvas");
    const image = await canvasModule.loadImage(buffer);
    const largest = Math.max(image.width, image.height, 1);
    const scale = Math.max(0.5, Math.min(2, 5000 / largest));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = canvasModule.createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);

    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;
    for (let index = 0; index < data.length; index += 4) {
      const gray =
        0.299 * data[index] +
        0.587 * data[index + 1] +
        0.114 * data[index + 2];
      const contrasted = Math.max(
        0,
        Math.min(255, (gray - 128) * 1.35 + 128)
      );
      data[index] = contrasted;
      data[index + 1] = contrasted;
      data[index + 2] = contrasted;
    }
    context.putImageData(imageData, 0, 0);
    return { buffer: canvas.toBuffer("image/png") };
  } catch (error) {
    return {
      buffer,
      warning: `OCR前処理（グレースケール・コントラスト強調・2倍拡大）に失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function tesseractOcr(buffer: Buffer): Promise<{
  text: string;
  warning?: string;
}> {
  const preprocessed = await preprocessImageForOcr(buffer);
  const warnings: string[] = [];
  if (preprocessed.warning) warnings.push(preprocessed.warning);
  try {
    const worker = await createOcrWorker();
    try {
      const result = await worker.recognize(preprocessed.buffer);
      return {
        text: String(result.data.text ?? "").trim(),
        warning: warnings.join(" ") || undefined,
      };
    } finally {
      try {
        await worker.terminate();
      } catch {
        // ignore
      }
    }
  } catch (error) {
    return {
      text: "",
      warning: [
        ...warnings,
        `Tesseract OCRに失敗しました: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ].join(" "),
    };
  }
}

/**
 * 画像1枚をOCRする。Python + pix2text/rapidocr/paddleocr があれば優先し、
 * 失敗時はグレースケール・コントラスト強調・2倍拡大をかけたTesseractへ落とす。
 */
export async function ocrImageHighQuality(
  buffer: Buffer
): Promise<OcrImageResult> {
  const warnings: string[] = [];
  const detection = await detectPythonOcr();

  if (detection.available && detection.python) {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "mef-ocr-img-"));
    const temporaryPath = path.join(
      temporaryDir,
      `image${imageExtension(buffer)}`
    );
    try {
      fs.writeFileSync(temporaryPath, buffer);
      const result = await runPythonOcr([temporaryPath]);
      const text = result.texts[0]?.trim() ?? "";
      if (result.engine !== "none" && text) {
        return {
          text,
          engine: pythonToOcrEngine(result.engine),
          engineLabel: ocrEngineLabel(pythonToOcrEngine(result.engine)),
          warnings: result.errors.slice(0, 5),
        };
      }
      warnings.push(
        `Python OCR（${detection.engines.join(
          " / "
        )}）で認識できなかったため、前処理付きTesseract.jsへフォールバックしました。`
      );
      warnings.push(...result.errors.slice(0, 3));
    } catch (error) {
      warnings.push(
        `Python OCRの実行に失敗しました: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  } else {
    warnings.push(
      "Python OCR（pix2text / rapidocr_onnxruntime / paddleocr）が未導入のため、前処理付きTesseract.jsでOCRしました。"
    );
    if (detection.error) warnings.push(detection.error);
  }

  const fallback = await tesseractOcr(buffer);
  if (fallback.warning) warnings.push(fallback.warning);
  return {
    text: fallback.text,
    engine: fallback.text ? "tesseract" : "none",
    engineLabel: ocrEngineLabel(fallback.text ? "tesseract" : "none"),
    warnings,
  };
}

async function renderPdfPagesToPng(
  buffer: Buffer,
  pageNumbers: number[]
): Promise<{ pages: Record<number, Buffer>; errors: string[] }> {
  const pages: Record<number, Buffer> = {};
  const errors: string[] = [];
  let library: PDFiumLibraryType | null = null;
  let document: PDFiumDocument | null = null;

  try {
    const { PDFiumLibrary } = await import("@hyzyla/pdfium");
    const canvasModule = await import("@napi-rs/canvas");
    library = await PDFiumLibrary.init();
    document = await library.loadDocument(new Uint8Array(buffer));

    const renderToPng = async (renderOptions: {
      width: number;
      height: number;
      data: Uint8Array;
    }): Promise<Uint8Array> => {
      const canvas = canvasModule.createCanvas(
        renderOptions.width,
        renderOptions.height
      );
      const context = canvas.getContext("2d");
      const imageData = new canvasModule.ImageData(
        new Uint8ClampedArray(renderOptions.data),
        renderOptions.width,
        renderOptions.height
      );
      context.putImageData(imageData, 0, 0);
      return canvas.toBuffer("image/png");
    };

    for (const pageNumber of pageNumbers) {
      if (pageNumber < 1 || pageNumber > document.getPageCount()) continue;
      try {
        const page = document.getPage(pageNumber - 1);
        try {
          const rendered = await page.render({
            scale: OCR_HQ_RENDER_SCALE,
            render: renderToPng,
          });
          pages[pageNumber] = Buffer.from(rendered.data);
        } finally {
          page.close();
        }
      } catch (error) {
        errors.push(
          `ページ${pageNumber}の画像化に失敗しました: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  } catch (error) {
    errors.push(
      `PDFページの画像化に失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    if (document) {
      try {
        document.destroy();
      } catch {
        // ignore
      }
    }
    if (library) {
      try {
        library.destroy();
      } catch {
        // ignore
      }
    }
  }

  return { pages, errors };
}

function dominantEngine(engines: OcrEngine[]): OcrEngine {
  const counts = new Map<OcrEngine, number>();
  for (const engine of engines) {
    if (engine === "none") continue;
    counts.set(engine, (counts.get(engine) ?? 0) + 1);
  }
  let best: OcrEngine = "none";
  let bestCount = 0;
  for (const [engine, count] of counts) {
    if (count > bestCount || (count === bestCount && engine.startsWith("python_"))) {
      best = engine;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 指定ページをPDFiumで画像化し、Python高精度OCRを一括実行する。
 * Pythonが無い/失敗したページだけ、前処理付きTesseractへフォールバックする。
 */
export async function ocrPdfPagesHighQuality(
  buffer: Buffer,
  pageNumbers: number[]
): Promise<PdfHighQualityOcrResult> {
  const pages: Record<number, string> = {};
  const engines: Record<number, OcrEngine> = {};
  const warnings: string[] = [];
  if (pageNumbers.length === 0) {
    return { pages, engines, warnings, engine: "none" };
  }

  const rendered = await renderPdfPagesToPng(buffer, pageNumbers);
  warnings.push(...rendered.errors);
  const entries = Object.entries(rendered.pages).map(([pageNumber, image]) => ({
    pageNumber: Number(pageNumber),
    image,
  }));
  if (entries.length === 0) {
    return { pages, engines, warnings, engine: "none" };
  }

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "mef-ocr-pdf-"));
  let tesseractWorker: Awaited<ReturnType<typeof createOcrWorker>> | null = null;

  try {
    const images = entries.map((entry) => {
      const filePath = path.join(
        temporaryDir,
        `page-${entry.pageNumber}.png`
      );
      fs.writeFileSync(filePath, entry.image);
      return { ...entry, filePath };
    });

    const detection = await detectPythonOcr();
    let pythonTexts: string[] = [];
    let pythonEngine: OcrEngine = "none";

    if (detection.available) {
      const result = await runPythonOcr(images.map((image) => image.filePath));
      pythonEngine = pythonToOcrEngine(result.engine);
      pythonTexts = result.texts;
      if (result.engine === "none") {
        warnings.push(
          "Python高精度OCRで認識できなかったため、前処理付きTesseract.jsへフォールバックしました。"
        );
      }
      warnings.push(...result.errors.slice(0, 5));
    } else {
      warnings.push(
        "Python OCR（pix2text / rapidocr_onnxruntime / paddleocr）が未導入のため、前処理付きTesseract.jsでOCRしました。"
      );
      if (detection.error) warnings.push(detection.error);
    }

    for (let index = 0; index < images.length; index += 1) {
      const entry = images[index];
      const pythonText = (pythonTexts[index] ?? "").trim();
      if (pythonText && pythonEngine !== "none") {
        pages[entry.pageNumber] = pythonText;
        engines[entry.pageNumber] = pythonEngine;
        continue;
      }

      const preprocessed = await preprocessImageForOcr(entry.image);
      if (preprocessed.warning) warnings.push(preprocessed.warning);
      if (!tesseractWorker) {
        tesseractWorker = await createOcrWorker();
      }
      try {
        const result = await tesseractWorker.recognize(preprocessed.buffer);
        const text = String(result.data.text ?? "").trim();
        pages[entry.pageNumber] = text;
        engines[entry.pageNumber] = text ? "tesseract" : "none";
      } catch (error) {
        warnings.push(
          `ページ${entry.pageNumber}のTesseract OCRに失敗しました: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        engines[entry.pageNumber] = "none";
      }
    }
  } finally {
    if (tesseractWorker) {
      try {
        await tesseractWorker.terminate();
      } catch {
        // ignore
      }
    }
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }

  return {
    pages,
    engines,
    warnings,
    engine: dominantEngine(Object.values(engines)),
  };
}

export interface PdfOcrResult {
  pages: string[];
  ocrPages: number[];
  ocrUsed: boolean;
  errors: string[];
}

/**
 * 同梱の @tesseract.js-data/{jpn,eng} から traineddata を data/tessdata に配置する。
 * これにより実行時にCDNへ取りに行かず、ローカルOCRできる。
 */
function ensureTessdata(): string | null {
  try {
    fs.mkdirSync(TESSDATA_DIR, { recursive: true });
    const packages: Array<{ lang: string; pkg: string }> = [
      { lang: "jpn", pkg: "@tesseract.js-data/jpn" },
      { lang: "eng", pkg: "@tesseract.js-data/eng" },
    ];
    for (const { lang, pkg } of packages) {
      const target = path.join(TESSDATA_DIR, `${lang}.traineddata.gz`);
      if (fs.existsSync(target)) continue;
      const pkgDir = path.join(process.cwd(), "node_modules", ...pkg.split("/"));
      const candidates = [
        path.join(pkgDir, "4.0.0_best_int", `${lang}.traineddata.gz`),
        path.join(pkgDir, "4.0.0", `${lang}.traineddata.gz`),
        path.join(pkgDir, `${lang}.traineddata.gz`),
      ];
      const source = candidates.find((candidate) => fs.existsSync(candidate));
      if (!source) return null;
      fs.copyFileSync(source, target);
    }
    return TESSDATA_DIR;
  } catch {
    return null;
  }
}

async function createOcrWorker() {
  const langPath = ensureTessdata();
  const tesseract = await import("tesseract.js");
  const options: Record<string, unknown> = {
    logger: () => undefined,
  };
  if (langPath) {
    process.env.TESSDATA_PREFIX = langPath;
    options.langPath = langPath;
    options.cachePath = langPath;
    options.gzip = true;
  }
  return tesseract.createWorker("jpn+eng", 1, options);
}

export async function ocrImage(buffer: Buffer): Promise<string> {
  const worker = await createOcrWorker();
  try {
    const result = await worker.recognize(buffer);
    return String(result.data.text ?? "").trim();
  } finally {
    try {
      await worker.terminate();
    } catch {
      // ignore
    }
  }
}

/**
 * PDFiumでページごとの埋め込みテキストを抽出する。
 * pdfjs-distは日本語CMapが無いと文字化けするため、CJK対応のPDFiumを第一候補にする。
 * テキストが無いページだけ画像化してTesseract.jsでOCRする。
 */
export async function extractPdfPagesWithOcr(
  buffer: Buffer,
  options: { ocr?: boolean; ocrMaxPages?: number } = {}
): Promise<PdfOcrResult> {
  const pages: string[] = [];
  const needsOcr: number[] = [];
  const ocrPages: number[] = [];
  const errors: string[] = [];
  const ocrEnabled = options.ocr !== false;

  let library: PDFiumLibraryType | null = null;
  let pdfiumDoc: PDFiumDocument | null = null;
  let worker: Awaited<ReturnType<typeof createOcrWorker>> | null = null;

  try {
    const { PDFiumLibrary } = await import("@hyzyla/pdfium");
    library = await PDFiumLibrary.init();
    pdfiumDoc = await library.loadDocument(new Uint8Array(buffer));

    const total = Math.min(pdfiumDoc.getPageCount(), OCR_MAX_PAGES);
    for (let i = 0; i < total; i += 1) {
      const page = pdfiumDoc.getPage(i);
      let text = "";
      try {
        text = page
          .getText()
          .replace(/\r/g, "")
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      } finally {
        page.close();
      }
      pages.push(text);
      if (text.length < OCR_TEXT_THRESHOLD) needsOcr.push(i + 1);
    }

    const ocrTargets =
      typeof options.ocrMaxPages === "number" && options.ocrMaxPages > 0
        ? needsOcr.filter((pageNumber) => pageNumber <= options.ocrMaxPages!)
        : needsOcr;

    if (ocrEnabled && ocrTargets.length > 0) {
      const canvasModule = await import("@napi-rs/canvas");
      worker = await createOcrWorker();

      const renderToPng = async (renderOptions: {
        width: number;
        height: number;
        data: Uint8Array;
      }): Promise<Uint8Array> => {
        const canvas = canvasModule.createCanvas(
          renderOptions.width,
          renderOptions.height
        );
        const context = canvas.getContext("2d");
        const imageData = new canvasModule.ImageData(
          new Uint8ClampedArray(renderOptions.data),
          renderOptions.width,
          renderOptions.height
        );
        context.putImageData(imageData, 0, 0);
        return canvas.toBuffer("image/png");
      };

      for (const pageNumber of ocrTargets) {
        try {
          const page = pdfiumDoc.getPage(pageNumber - 1);
          try {
            const rendered = await page.render({
              scale: OCR_RENDER_SCALE,
              render: renderToPng,
            });
            const recognized = await worker.recognize(Buffer.from(rendered.data));
            pages[pageNumber - 1] = String(recognized.data.text ?? "").trim();
            ocrPages.push(pageNumber);
          } finally {
            page.close();
          }
        } catch (error) {
          errors.push(
            `ページ${pageNumber}のOCRに失敗しました: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
  } catch (error) {
    errors.push(
      `PDFの解析に失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    if (pdfiumDoc) {
      try {
        pdfiumDoc.destroy();
      } catch {
        // ignore
      }
    }
    if (library) {
      try {
        library.destroy();
      } catch {
        // ignore
      }
    }
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // ignore
      }
    }
  }

  return { pages, ocrPages, ocrUsed: ocrPages.length > 0, errors };
}
