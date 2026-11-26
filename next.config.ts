import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: [
    "better-sqlite3",
    "puppeteer-core",
    "pdfjs-dist",
    "tesseract.js",
    "@napi-rs/canvas",
    "@hyzyla/pdfium",
  ],
};

export default nextConfig;
