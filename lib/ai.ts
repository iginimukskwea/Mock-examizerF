import { jsonrepair } from "jsonrepair";

export type AiMode = "anthropic" | "openai" | "demo";

export interface AiFile {
  kind: "image" | "pdf";
  mime: string;
  data: Buffer;
  name?: string;
}

export function aiMode(): AiMode {
  // OpenAI互換サーバーを優先する。ANTHROPIC_API_KEYのみの場合はClaudeを使う。
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "demo";
}

export function aiModeLabel(): string {
  const mode = aiMode();
  if (mode === "anthropic") return "Anthropic Claude";
  if (mode === "openai") {
    const base = (process.env.AI_BASE_URL || "https://api.openai.com/v1")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    return `OpenAI互換API（${base}）`;
  }
  return "デモモード（AI未設定）";
}

function aiTimeoutMs(): number {
  const configured = Number(process.env.AI_TIMEOUT_MS);
  const value =
    Number.isFinite(configured) && configured > 0 ? configured : 300_000;
  return Math.min(600_000, value);
}

function errorCauseCode(error: unknown): string {
  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      return String((cause as { code?: unknown }).code ?? "");
    }
  }
  return "";
}

/**
 * タイムアウト・接続拒否などを「AI未設定」と誤認させないための共通メッセージ。
 */
export function formatAiError(error: unknown): string {
  const mode = aiMode();
  const endpoint =
    mode === "openai"
      ? process.env.AI_BASE_URL || "https://api.openai.com/v1"
      : mode === "anthropic"
        ? "https://api.anthropic.com"
        : "未設定";
  const message = error instanceof Error ? error.message : String(error);
  // すでに整形済みのエラーを再ラップしない（二重表示を防ぐ）。
  if (
    /^AI(の応答がタイムアウトしました|サーバーに接続できません|呼び出しに失敗しました)/.test(
      message
    )
  ) {
    return message;
  }
  const name = error instanceof Error ? error.name : "";
  const code = errorCauseCode(error);
  const combined = `${message} ${code}`;
  const hint =
    mode === "openai"
      ? "OpenAI互換サーバーが起動しているか、AI_BASE_URL・OPENAI_API_KEY・AI_MODEL が正しいか確認してください"
      : "Anthropic API に接続できるか、ANTHROPIC_API_KEY・AI_MODEL が正しいか確認してください";

  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /aborted due to timeout|operation was aborted|timeout/i.test(combined)
  ) {
    const seconds = Math.round(aiTimeoutMs() / 1000);
    return `AIの応答がタイムアウトしました（${seconds}秒）。${hint}（接続先: ${endpoint}）。`;
  }
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|CONNECT_TIMEOUT|UND_ERR_CONNECT_TIMEOUT/i.test(
      combined
    )
  ) {
    return `AIサーバーに接続できません（接続先: ${endpoint}）。${hint}。詳細: ${message}${
      code ? ` (${code})` : ""
    }`;
  }
  if (message === "DEMO_MODE") {
    return "AIが未設定のためデモモードで処理しました。";
  }
  return `AI呼び出しに失敗しました: ${message}`;
}

const JSON_INSTRUCTION =
  "出力は必ず有効なJSONのみとし、前後に説明文やコードフェンスを付けないでください。";

function parseJsonResponse<T>(raw: string): T {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const candidates: string[] = [text];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }
  // 打ち切りや軽微なJSON崩れを修復して再解析する。
  for (const candidate of candidates) {
    try {
      return JSON.parse(jsonrepair(candidate)) as T;
    } catch {
      continue;
    }
  }
  console.error(
    "[ai] JSON parse failed. Response preview:",
    text.slice(0, 2000)
  );
  throw new Error("AIの応答をJSONとして解析できませんでした");
}

async function callAnthropic(
  system: string,
  prompt: string,
  files: AiFile[],
  maxTokens: number
): Promise<string> {
  const content: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (file.kind === "pdf") {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: file.data.toString("base64"),
        },
      });
    } else {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: file.mime,
          data: file.data.toString("base64"),
        },
      });
    }
  }
  content.push({ type: "text", text: `${prompt}\n\n${JSON_INSTRUCTION}` });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "claude-sonnet-4-5",
      max_tokens: maxTokens,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(aiTimeoutMs()),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic API エラー (${response.status}): ${body.slice(0, 500)}`
    );
  }
  const json = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (json.content ?? [])
    .filter(
      (block) => block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text as string)
    .join("\n");
}

function responseText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

interface ModelCacheEntry {
  baseUrl: string;
  apiKey: string;
  id: string;
  expiresAt: number;
}

let modelCache: ModelCacheEntry | null = null;

async function resolveOpenAIModel(
  baseUrl: string,
  apiKey: string
): Promise<string> {
  const configured = (process.env.AI_MODEL || "").trim();
  if (configured) return configured;

  if (
    modelCache &&
    modelCache.baseUrl === baseUrl &&
    modelCache.apiKey === apiKey &&
    modelCache.expiresAt > Date.now()
  ) {
    return modelCache.id;
  }

  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `AI_MODELが未設定で、モデル一覧の取得に失敗しました (${response.status}): ${body.slice(
        0,
        300
      )}。AI_MODELを設定してください。`
    );
  }
  const json = (await response.json()) as {
    data?: Array<{ id?: string }>;
  };
  const id = (json.data ?? [])
    .map((model) => model.id)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  if (!id) {
    throw new Error(
      "AI_MODELが未設定で、利用可能なモデルが見つかりません。/v1/models を確認するか AI_MODEL を設定してください。"
    );
  }
  modelCache = {
    baseUrl,
    apiKey,
    id,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  return id;
}

async function callOpenAI(
  system: string,
  prompt: string,
  files: AiFile[],
  maxTokens: number
): Promise<string> {
  const baseUrl = (
    process.env.AI_BASE_URL || "https://api.openai.com/v1"
  )
    .trim()
    .replace(/\/$/, "");
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const model = await resolveOpenAIModel(baseUrl, apiKey);

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: prompt },
  ];
  for (const file of files) {
    if (file.kind !== "image") continue;
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${file.mime};base64,${file.data.toString("base64")}`,
      },
    });
  }
  content.push({ type: "text", text: JSON_INSTRUCTION });

  const sendChat = (jsonMode: boolean) =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(aiTimeoutMs()),
    });

  let response = await sendChat(true);
  if (!response.ok) {
    const status = response.status;
    const firstBody = await response.text();
    // response_format非対応の互換サーバー向けに、一度だけJSONモードなしで再試行する。
    if (status === 400 || status === 422) {
      response = await sendChat(false);
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `OpenAI互換API エラー (${response.status}): ${body.slice(0, 500)}`
        );
      }
    } else {
      throw new Error(
        `OpenAI互換API エラー (${status}): ${firstBody.slice(0, 500)}`
      );
    }
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
        reasoning_content?: string | null;
      };
    }>;
  };
  const message = json.choices?.[0]?.message;
  const text = responseText(message?.content);
  if (!text.trim()) {
    if (message?.reasoning_content) {
      throw new Error(
        "AIがreasoningのみを返し、本文が空でした。モデル設定と応答形式を確認してください。"
      );
    }
    throw new Error(
      "AIの応答が空でした。OpenAI互換サーバーのモデル設定を確認してください。"
    );
  }
  return text;
}

export interface AiJsonArgs {
  system: string;
  prompt: string;
  files?: AiFile[];
  maxTokens?: number;
}

export async function aiJson<T>(args: AiJsonArgs): Promise<T> {
  return runAiJson<T>(args);
}

async function runAiJson<T>(args: AiJsonArgs): Promise<T> {
  const mode = aiMode();
  if (mode === "demo") {
    throw new Error("DEMO_MODE");
  }
  const maxTokens = Math.max(1, args.maxTokens ?? 8192);
  let text: string;
  try {
    text =
      mode === "anthropic"
        ? await callAnthropic(
            args.system,
            args.prompt,
            args.files ?? [],
            maxTokens
          )
        : await callOpenAI(
            args.system,
            args.prompt,
            args.files ?? [],
            maxTokens
          );
  } catch (error) {
    throw new Error(formatAiError(error));
  }
  try {
    return parseJsonResponse<T>(text);
  } catch (error) {
    throw new Error(formatAiError(error));
  }
}
