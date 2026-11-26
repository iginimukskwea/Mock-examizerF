import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { COVERS_DIR } from "./db";

export const COVER_MAX_BYTES = 8 * 1024 * 1024;

export const COVER_MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export function coverUrl(filename: string): string {
  return `/api/covers/${filename}`;
}

export function detectCoverExtension(
  buffer: Buffer,
  mime: string
): string | null {
  const mimeExt = COVER_MIME_EXT[mime.toLowerCase()];
  if (!mimeExt) return null;
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
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return ".jpg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  return null;
}

export function writeCoverFile(
  buffer: Buffer,
  extension: string
): { filename: string; filePath: string; url: string } {
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  const filename = `${crypto.randomUUID()}${extension}`;
  const filePath = path.join(COVERS_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return { filename, filePath, url: coverUrl(filename) };
}

export function coverFilenameFromPath(
  coverPath: string | null | undefined
): string | null {
  const raw = (coverPath ?? "").trim();
  if (!raw) return null;

  let candidate = raw;
  if (raw.startsWith("/api/covers/")) {
    candidate = raw.slice("/api/covers/".length);
  } else if (raw.startsWith("/uploads/covers/")) {
    candidate = raw.slice("/uploads/covers/".length);
  } else if (path.isAbsolute(raw)) {
    const base = path.resolve(COVERS_DIR);
    const target = path.resolve(raw);
    if (!target.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)) {
      return null;
    }
    return path.basename(target);
  } else if (raw.includes("/") || raw.includes("\\")) {
    return null;
  }

  try {
    candidate = decodeURIComponent(candidate.split("?")[0]);
  } catch {
    return null;
  }
  if (!candidate || candidate.includes("/") || candidate.includes("\\")) {
    return null;
  }
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : null;
}

export function removeCoverFile(
  coverPath: string | null | undefined
): boolean {
  const filename = coverFilenameFromPath(coverPath);
  if (!filename) return false;
  const base = path.resolve(COVERS_DIR);
  const target = path.resolve(base, filename);
  if (!target.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)) {
    return false;
  }
  try {
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}
