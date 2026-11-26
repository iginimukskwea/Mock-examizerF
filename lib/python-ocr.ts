import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(process.cwd(), "scripts", "python_ocr.py");
const DETECTION_TTL_MS = 5 * 60 * 1000;

export type PythonOcrEngine = "pix2text" | "rapidocr" | "paddleocr";

export interface PythonOcrDetection {
  available: boolean;
  python: string | null;
  baseArgs: string[];
  engines: PythonOcrEngine[];
  version: string | null;
  error: string | null;
  checkedAt: number;
}

export interface PythonOcrResult {
  engine: PythonOcrEngine | "none";
  texts: string[];
  errors: string[];
}

interface PythonCandidate {
  command: string;
  baseArgs: string[];
}

let detectionCache: PythonOcrDetection | null = null;

function candidates(): PythonCandidate[] {
  const defaults =
    process.platform === "win32"
      ? [
          { command: "py", baseArgs: ["-3"] },
          { command: "python", baseArgs: [] },
          { command: "python3", baseArgs: [] },
        ]
      : [
          { command: "python3", baseArgs: [] },
          { command: "python", baseArgs: [] },
        ];

  const override = (process.env.PYTHON_OCR_PYTHON || "").trim();
  if (override) {
    return [{ command: override, baseArgs: [] }, ...defaults];
  }
  return defaults;
}

async function run(
  command: string,
  args: string[],
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
}

const DETECT_SCRIPT = `
import importlib.util, json, sys

def has(name):
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False

print(json.dumps({
    "version": sys.version.split()[0],
    "pix2text": has("pix2text"),
    "rapidocr": has("rapidocr_onnxruntime"),
    "paddleocr": has("paddleocr"),
}))
`;

export async function detectPythonOcr(
  force = false
): Promise<PythonOcrDetection> {
  if (
    !force &&
    detectionCache &&
    Date.now() - detectionCache.checkedAt < DETECTION_TTL_MS
  ) {
    return detectionCache;
  }

  if (!fs.existsSync(SCRIPT_PATH)) {
    const detection: PythonOcrDetection = {
      available: false,
      python: null,
      baseArgs: [],
      engines: [],
      version: null,
      error: `Python OCRスクリプトが見つかりません: ${SCRIPT_PATH}`,
      checkedAt: Date.now(),
    };
    detectionCache = detection;
    return detection;
  }

  const errors: string[] = [];
  for (const candidate of candidates()) {
    try {
      const { stdout } = await run(
        candidate.command,
        [...candidate.baseArgs, "-c", DETECT_SCRIPT],
        6000
      );
      const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!lastLine) continue;
      const json = JSON.parse(lastLine) as {
        version?: string;
        pix2text?: boolean;
        rapidocr?: boolean;
        paddleocr?: boolean;
      };
      const engines: PythonOcrEngine[] = [];
      if (json.pix2text) engines.push("pix2text");
      if (json.rapidocr) engines.push("rapidocr");
      if (json.paddleocr) engines.push("paddleocr");
      const detection: PythonOcrDetection = {
        available: engines.length > 0,
        python: candidate.command,
        baseArgs: candidate.baseArgs,
        engines,
        version: json.version ?? null,
        error:
          engines.length > 0
            ? null
            : "Pythonは見つかりましたが、pix2text / rapidocr_onnxruntime / paddleocr が未導入です",
        checkedAt: Date.now(),
      };
      detectionCache = detection;
      return detection;
    } catch (error) {
      errors.push(
        `${candidate.command}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const detection: PythonOcrDetection = {
    available: false,
    python: null,
    baseArgs: [],
    engines: [],
    version: null,
    error: `Python OCRを利用できません。${errors.join(" / ")}`,
    checkedAt: Date.now(),
  };
  detectionCache = detection;
  return detection;
}

export async function runPythonOcr(
  imagePaths: string[],
  preferred?: PythonOcrEngine
): Promise<PythonOcrResult> {
  const emptyTexts = imagePaths.map(() => "");
  if (imagePaths.length === 0) {
    return { engine: "none", texts: [], errors: [] };
  }

  const detection = await detectPythonOcr();
  if (!detection.available || !detection.python) {
    return {
      engine: "none",
      texts: emptyTexts,
      errors: [detection.error ?? "Python OCRを利用できません"],
    };
  }

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "mef-ocr-"));
  const inputPath = path.join(temporaryDir, "input.json");
  try {
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        images: imagePaths,
        engine: preferred ?? "auto",
      }),
      "utf8"
    );

    const { stdout, stderr } = await run(
      detection.python,
      [...detection.baseArgs, SCRIPT_PATH, "--input", inputPath],
      300_000
    );
    const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (!lastLine) {
      return {
        engine: "none",
        texts: emptyTexts,
        errors: [
          `Python OCRがJSONを返しませんでした。${stderr.slice(0, 500)}`,
        ],
      };
    }
    const json = JSON.parse(lastLine) as {
      engine?: string;
      texts?: unknown[];
      errors?: unknown[];
    };
    const texts = Array.isArray(json.texts)
      ? json.texts.map((text) => String(text ?? ""))
      : [];
    while (texts.length < imagePaths.length) texts.push("");
    const engine =
      json.engine === "pix2text" ||
      json.engine === "rapidocr" ||
      json.engine === "paddleocr"
        ? json.engine
        : "none";
    return {
      engine,
      texts: texts.slice(0, imagePaths.length),
      errors: Array.isArray(json.errors)
        ? json.errors.map((error) => String(error))
        : [],
    };
  } catch (error) {
    return {
      engine: "none",
      texts: emptyTexts,
      errors: [
        `Python OCRの実行に失敗しました: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}
