export async function downloadPdf(url: string, filename: string): Promise<void> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    let message = "PDFの生成に失敗しました";
    try {
      const json = (await response.json()) as { error?: string };
      if (json?.error) message = json.error;
    } catch {
      message = `PDFの生成に失敗しました (${response.status})`;
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

export function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "mock-exam";
}
