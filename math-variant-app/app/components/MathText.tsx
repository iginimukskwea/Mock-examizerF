"use client";

import katex from "katex";
import { useMemo } from "react";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderExpression(expression: string, display: boolean): string {
  try {
    return katex.renderToString(expression, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
  } catch {
    return `<code>${escapeHtml(expression)}</code>`;
  }
}

interface MathTextProps {
  text: string;
  className?: string;
}

export function MathText({ text, className = "" }: MathTextProps) {
  const html = useMemo(() => {
    const source = String(text ?? "");
    const parts = source.split(
      /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/g
    );

    return parts
      .map((part) => {
        if (!part) return "";

        if (part.startsWith("$$") && part.endsWith("$$") && part.length > 4) {
          return renderExpression(part.slice(2, -2), true);
        }
        if (part.startsWith("$") && part.endsWith("$") && part.length > 2) {
          return renderExpression(part.slice(1, -1), false);
        }
        if (part.startsWith("\\[") && part.endsWith("\\]")) {
          return renderExpression(part.slice(2, -2), true);
        }
        if (part.startsWith("\\(") && part.endsWith("\\)")) {
          return renderExpression(part.slice(2, -2), false);
        }

        return escapeHtml(part).replace(/\n/g, "<br/>");
      })
      .join("");
  }, [text]);

  if (!text || !text.trim()) return null;

  return (
    <div
      className={`math-text ${className}`.trim()}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
