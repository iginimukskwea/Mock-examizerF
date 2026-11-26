import fs from "node:fs";
import path from "node:path";
import katex from "katex";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let cachedKatexCss: string | null = null;

export function getKatexCss(): string {
  if (cachedKatexCss) return cachedKatexCss;
  const cssPath = path.join(process.cwd(), "node_modules", "katex", "dist", "katex.min.css");
  let css = fs.readFileSync(cssPath, "utf8");
  css = css.replace(
    /,\s*url\(['"]?fonts\/[^)'"]+\.(?:woff|ttf)['"]?\)\s*format\(['"](?:woff|truetype)['"]\)/g,
    ""
  );
  css = css.replace(/url\(['"]?fonts\/([^)'"]+)['"]?\)/g, (match, file: string) => {
    try {
      const fontPath = path.join(path.dirname(cssPath), "fonts", file);
      const data = fs.readFileSync(fontPath);
      const ext = path.extname(file).toLowerCase();
      const mime =
        ext === ".woff2" ? "font/woff2" : ext === ".woff" ? "font/woff" : "font/ttf";
      return `url(data:${mime};base64,${data.toString("base64")})`;
    } catch {
      return match;
    }
  });
  cachedKatexCss = css;
  return css;
}

export function renderRich(text: string): string {
  const source = String(text ?? "");
  const parts = source.split(
    /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/g
  );
  return parts
    .map((part) => {
      if (!part) return "";
      let expression: string | null = null;
      let display = false;
      if (part.startsWith("$$") && part.endsWith("$$") && part.length > 4) {
        expression = part.slice(2, -2);
        display = true;
      } else if (part.startsWith("$") && part.endsWith("$") && part.length > 2) {
        expression = part.slice(1, -1);
      } else if (part.startsWith("\\[") && part.endsWith("\\]")) {
        expression = part.slice(2, -2);
        display = true;
      } else if (part.startsWith("\\(") && part.endsWith("\\)")) {
        expression = part.slice(2, -2);
      }

      if (expression !== null) {
        try {
          return katex.renderToString(expression, {
            displayMode: display,
            throwOnError: false,
            strict: "ignore",
            trust: false,
          });
        } catch {
          return escapeHtml(part);
        }
      }
      return escapeHtml(part).replace(/\n/g, "<br/>");
    })
    .join("");
}
