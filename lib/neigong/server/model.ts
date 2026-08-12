import type { ModelTask, ModelTaskOutputMap, ModelTaskRequest } from "../types";
// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { buildNeigongInput, getNeigongInstructions } from "./prompts.ts";
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { RESPONSE_FORMATS, validateModelTaskReferences, validateModelTaskRequest, validateModelTaskResult } from "./schemas.ts";

export const MAX_OUTPUT_TOKENS: Record<ModelTask, number> = {
  "review-taxonomy": 8_000,
  "question-topic": 8_000,
  "top20-dimensions": 10_000,
  "screenshot-metadata": 4_000,
  synthesis: 8_000,
};

export const DEFAULT_MODEL_TIMEOUT_MS = 120_000;

export class NeigongModelError extends Error {
  code: string;
  retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "NeigongModelError";
    this.code = code;
    this.retryable = retryable;
  }
}

function modelError(code: string, message: string, retryable = false): NeigongModelError {
  return new NeigongModelError(code, message, retryable);
}

function getResponsesUrl() {
  return `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
}

function getModelTimeoutMs() {
  const configured = Number(process.env.NEIGONG_MODEL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MODEL_TIMEOUT_MS;
}

function createModelRequestLifetime(parent?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("模型响应超时", "TimeoutError"));
  }, getModelTimeoutMs());
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function findRefusal(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const refusal = findRefusal(item);
      if (refusal) return refusal;
    }
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record.type === "refusal" && typeof record.refusal === "string") return record.refusal;
    if (typeof record.refusal === "string") return record.refusal;
    for (const item of Object.values(record)) {
      const refusal = findRefusal(item);
      if (refusal) return refusal;
    }
  }
  return null;
}

function extractOutputText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const response = value as Record<string, unknown>;
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  if (!Array.isArray(response.output)) return null;

  const texts: string[] = [];
  for (const output of response.output) {
    if (typeof output !== "object" || output === null) continue;
    const content = (output as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) texts.push(text);
    }
  }
  return texts.length ? texts.join("") : null;
}

export async function callNeigongModel<T extends ModelTask>(
  rawRequest: ModelTaskRequest & { task: T },
  apiKey = process.env.OPENAI_API_KEY,
  signal?: AbortSignal,
): Promise<ModelTaskOutputMap[T]> {
  const validation = validateModelTaskRequest(rawRequest);
  if (!validation.ok) throw modelError(validation.code, validation.error);
  if (!apiKey) throw modelError("MODEL_NOT_CONFIGURED", "模型服务未配置");
  const request = validation.value;
  const lifetime = createModelRequestLifetime(signal);

  try {
    let response: Response;
    try {
      response = await fetch(getResponsesUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-5.6",
          instructions: getNeigongInstructions(request.task),
          input: [{ role: "user", content: buildNeigongInput(request) }],
          text: { format: RESPONSE_FORMATS[request.task] },
          max_output_tokens: MAX_OUTPUT_TOKENS[request.task],
          store: false,
        }),
        signal: lifetime.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (lifetime.didTimeout()) throw modelError("MODEL_TIMEOUT", "模型响应超时", true);
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw modelError("MODEL_NETWORK", "模型网络错误", true);
    }

    if (!response.ok) {
      if (response.status === 401) throw modelError("MODEL_AUTH", "模型鉴权失败", false);
      if (response.status === 429) throw modelError("MODEL_RATE_LIMIT", "模型请求限流", true);
      if (response.status >= 500) throw modelError("MODEL_UPSTREAM", `模型服务错误：${response.status}`, true);
      throw modelError("MODEL_UPSTREAM", `模型请求失败：${response.status}`, false);
    }

    let apiResponse: unknown;
    try {
      apiResponse = await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (lifetime.didTimeout()) throw modelError("MODEL_TIMEOUT", "模型响应超时", true);
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw modelError("MODEL_SCHEMA_INVALID", "模型响应不是合法 JSON");
    }

    const refusal = findRefusal(apiResponse);
    if (refusal) throw modelError("MODEL_SCHEMA_INVALID", "模型拒绝输出");
    const outputText = extractOutputText(apiResponse);
    if (!outputText) throw modelError("MODEL_SCHEMA_INVALID", "模型输出为空");

    let output: unknown;
    try {
      output = JSON.parse(outputText);
    } catch {
      throw modelError("MODEL_SCHEMA_INVALID", "模型输出不是合法 JSON");
    }

    const schemaValidation = validateModelTaskResult(request.task, output);
    if (!schemaValidation.ok) throw modelError("MODEL_SCHEMA_INVALID", schemaValidation.error);
    const referenceValidation = validateModelTaskReferences(request, output);
    if (!referenceValidation.ok) throw modelError("MODEL_SCHEMA_INVALID", referenceValidation.error);
    return schemaValidation.value as ModelTaskOutputMap[T];
  } finally {
    lifetime.dispose();
  }
}
