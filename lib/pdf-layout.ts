import path from "node:path";

export interface PdfLayoutPage {
  pageNumber: number;
  text: string;
  columns: 1 | 2;
  itemCount: number;
  lineCount: number;
  quality: "good" | "garbled" | "empty";
}

export interface PdfLayoutResult {
  pages: PdfLayoutPage[];
  errors: string[];
}

interface RawItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextLine {
  y: number;
  height: number;
  minX: number;
  maxX: number;
  items: RawItem[];
}

interface PdfPageProxyLike {
  getViewport: (params: { scale: number }) => {
    width: number;
    height: number;
  };
  getTextContent: () => Promise<{ items: unknown[] }>;
  cleanup: () => void;
}

interface PdfDocumentProxyLike {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageProxyLike>;
  destroy: () => Promise<void>;
}

function asTextItem(
  item: unknown
): { str: string; transform: number[]; width: number; height: number } | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  if (typeof row.str !== "string") return null;
  const transform = row.transform;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const numeric = transform.map((value) => Number(value));
  if (numeric.some((value) => !Number.isFinite(value))) return null;
  return {
    str: row.str,
    transform: numeric,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
  };
}

function buildLines(items: RawItem[]): TextLine[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextLine[] = [];

  for (const item of sorted) {
    const tolerance = Math.max(
      3,
      Math.min(
        8,
        Math.max(item.height, 6) * 0.55
      )
    );
    const line = lines.find(
      (candidate) => Math.abs(candidate.y - item.y) <= tolerance
    );
    if (line) {
      line.y =
        (line.y * line.items.length + item.y) / (line.items.length + 1);
      line.items.push(item);
      line.height = Math.max(line.height, item.height);
      line.minX = Math.min(line.minX, item.x);
      line.maxX = Math.max(line.maxX, item.x + item.width);
    } else {
      lines.push({
        y: item.y,
        height: item.height,
        minX: item.x,
        maxX: item.x + item.width,
        items: [item],
      });
    }
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }
  return lines.sort((a, b) => b.y - a.y);
}

function joinLine(line: TextLine): string {
  let text = "";
  let previousEnd: number | null = null;

  for (const item of line.items) {
    if (!item.str) continue;
    if (previousEnd !== null) {
      const gap = item.x - previousEnd;
      const previousChar = text.slice(-1);
      const nextChar = item.str.charAt(0);
      if (
        gap > Math.max(1.5, item.height * 0.22) &&
        /[A-Za-z0-9]/.test(previousChar) &&
        /[A-Za-z0-9]/.test(nextChar)
      ) {
        text += " ";
      }
    }
    text += item.str;
    previousEnd = item.x + item.width;
  }

  return text.replace(/[ \t\u3000]+/g, " ").trim();
}

function detectTwoColumns(lines: TextLine[], pageWidth: number): boolean {
  if (lines.length < 4 || pageWidth <= 0) return false;
  const middle = pageWidth / 2;
  const left = lines.filter((line) => line.maxX <= middle - 4);
  const right = lines.filter((line) => line.minX >= middle + 4);
  if (left.length < 2 || right.length < 2) return false;

  const leftMax = Math.max(...left.map((line) => line.maxX));
  const rightMin = Math.min(...right.map((line) => line.minX));
  return leftMax < middle && rightMin > middle && rightMin - leftMax > 12;
}

function orderLines(
  lines: TextLine[],
  pageWidth: number,
  twoColumns: boolean
): TextLine[] {
  const sorted = [...lines].sort(
    (a, b) => b.y - a.y || a.minX - b.minX
  );
  if (!twoColumns) return sorted;

  const middle = pageWidth / 2;
  const output: TextLine[] = [];
  let left: TextLine[] = [];
  let right: TextLine[] = [];

  const flush = () => {
    output.push(
      ...left.sort((a, b) => b.y - a.y || a.minX - b.minX)
    );
    output.push(
      ...right.sort((a, b) => b.y - a.y || a.minX - b.minX)
    );
    left = [];
    right = [];
  };

  for (const line of sorted) {
    const fullWidth =
      line.minX < middle - 6 && line.maxX > middle + 6;
    if (fullWidth) {
      flush();
      output.push(line);
    } else if (line.maxX <= middle + 6) {
      left.push(line);
    } else {
      right.push(line);
    }
  }
  flush();
  return output;
}

function linesToText(lines: TextLine[]): string {
  if (lines.length === 0) return "";
  const heights = lines
    .map((line) => line.height)
    .filter((height) => height > 0)
    .sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 10;

  const parts: string[] = [];
  let previous: TextLine | null = null;
  for (const line of lines) {
    const text = joinLine(line);
    if (!text) continue;
    if (previous) {
      const gap = previous.y - line.y;
      parts.push(gap > median * 1.8 ? "\n\n" : "\n");
    }
    parts.push(text);
    previous = line;
  }

  return parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assessTextQuality(text: string): "good" | "garbled" | "empty" {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  const bad = (trimmed.match(/\uFFFD|\(cid:\d+\)/g) ?? []).length;
  if (bad > 0 && bad / trimmed.length > 0.01) return "garbled";
  return "good";
}

/**
 * PDFの埋め込みテキストを文字アイテムの座標付きで抽出し、
 * 行→段組み→読み順に再構成する。スキャンPDFは空ページとして返す。
 */
export async function extractPdfPagesWithLayout(
  buffer: Buffer
): Promise<PdfLayoutResult> {
  const pages: PdfLayoutPage[] = [];
  const errors: string[] = [];
  let doc: PdfDocumentProxyLike | null = null;

  try {
    const pdfjs = await import("pdfjs-dist");
    const assetRoot = path.join(
      process.cwd(),
      "node_modules",
      "pdfjs-dist"
    );

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl: path.join(assetRoot, "cmaps") + path.sep,
      cMapPacked: true,
      standardFontDataUrl:
        path.join(assetRoot, "standard_fonts") + path.sep,
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
    });
    doc = (await loadingTask.promise) as unknown as PdfDocumentProxyLike;

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items: RawItem[] = [];

        for (const rawItem of content.items) {
          const item = asTextItem(rawItem);
          if (!item || !item.str.trim()) continue;
          const x = item.transform[4];
          const y = item.transform[5];
          const height =
            item.height || Math.abs(item.transform[3]) || 10;
          items.push({
            str: item.str,
            x,
            y,
            width: item.width,
            height,
          });
        }

        const lines = buildLines(items);
        const twoColumns = detectTwoColumns(lines, viewport.width);
        const ordered = orderLines(lines, viewport.width, twoColumns);
        const text = linesToText(ordered);
        pages.push({
          pageNumber,
          text,
          columns: twoColumns ? 2 : 1,
          itemCount: items.length,
          lineCount: lines.length,
          quality: assessTextQuality(text),
        });
      } finally {
        page.cleanup();
      }
    }
  } catch (error) {
    errors.push(
      `座標付きPDFテキスト抽出に失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    if (doc) {
      try {
        await doc.destroy();
      } catch {
        // ignore
      }
    }
  }

  return { pages, errors };
}
