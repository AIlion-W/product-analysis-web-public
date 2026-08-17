import type { ModelTask, ModelTaskOutputMap, ModelTaskRequest } from "../types";
// Node contract tests execute source TypeScript directly; runtime imports need extensions.
import { buildNeigongInput, getNeigongInstructions } from "./prompts.ts";
import { RESPONSE_FORMATS, validateModelTaskReferences, validateModelTaskRequest, validateModelTaskResult } from "./schemas.ts";
import type { NuwaModelRuntime } from "../../server/nuwa-model-runtime.ts";

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

function getConfiguredModel(task: ModelTask, runtime?: NuwaModelRuntime) {
  if (runtime) {
    return task === "screenshot-metadata" ? runtime.vision.model : runtime.primary.model;
  }
  if (task === "screenshot-metadata") {
    return process.env.NEIGONG_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-5.6";
  }
  return process.env.NEIGONG_MODEL || process.env.OPENAI_MODEL || "gpt-5.6";
}

function usesChatCompletions(model: string) {
  return model.startsWith("claude-");
}

function getModelUrl(model: string, runtime?: NuwaModelRuntime, task?: ModelTask) {
  const runtimeEndpoint = runtime
    ? task === "screenshot-metadata" ? runtime.vision : runtime.primary
    : undefined;
  const baseUrl = (runtimeEndpoint?.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  return `${baseUrl}/${usesChatCompletions(model) ? "chat/completions" : "responses"}`;
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

function extractChatOutputText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" && content.trim() ? content : null;
}

function unwrapJsonCodeFence(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return match ? match[1] : trimmed;
}

const DIMENSION_KEYS = ["persona", "scene", "painPoint", "detail", "effect", "delight"] as const;

function isClaudeRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findUniqueClaudeRows(
  result: Record<string, unknown>,
  matches: (row: Record<string, unknown>) => boolean,
) {
  const candidates = Object.values(result)
    .filter((value): value is unknown[] => Array.isArray(value))
    .filter((rows) => rows.length > 0 && rows.every((row) => isClaudeRow(row) && matches(row)));
  return candidates.length === 1 ? candidates[0] : null;
}

function normalizeClaudeResult(task: ModelTask, value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const result = { ...value as Record<string, unknown> };
  delete result.requestId;
  delete result.productId;
  delete result.task;
  const claudeReviewItems = findUniqueClaudeRows(result, (item) => (
    typeof item.rowId === "string"
    && typeof (item.typeId ?? item.category ?? item.tier) === "string"
    && typeof item.evidenceSource === "string"
    && typeof item.evidenceQuote === "string"
  ));
  if (task === "review-taxonomy" && !Array.isArray(result.labels) && claudeReviewItems) {
    return {
      labels: claudeReviewItems.map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          rowId: item.rowId,
          typeId: item.typeId ?? item.category ?? item.tier,
          evidenceSource: item.evidenceSource,
          evidenceQuote: item.evidenceQuote,
        };
      }),
    };
  }
  const claudeQuestionItems = findUniqueClaudeRows(result, (item) => (
    typeof item.rowId === "string"
    && typeof (item.topicId ?? item.topic) === "string"
    && typeof item.topicEvidence === "string"
  ));
  if (task === "question-topic" && !Array.isArray(result.labels) && claudeQuestionItems) {
    return {
      labels: claudeQuestionItems.map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          rowId: item.rowId,
          topicId: item.topicId ?? item.topic,
          topicEvidence: item.topicEvidence,
        };
      }),
    };
  }
  if (task === "top20-dimensions" && !Array.isArray(result.rows) && Array.isArray(result.results)) {
    return {
      rows: result.results.map((raw) => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
        const item = raw as Record<string, unknown>;
        return {
          rowId: item.rowId,
          dimensions: Object.fromEntries(DIMENSION_KEYS.map((key) => [key, item[key]])),
          evidence: Object.fromEntries(DIMENSION_KEYS.map((key) => [key, item[`${key}Evidence`]])),
          score: item.score,
          note: typeof item.note === "string" ? item.note : "",
        };
      }),
    };
  }
  return result;
}

export async function callNeigongModel<T extends ModelTask>(
  rawRequest: ModelTaskRequest & { task: T },
  apiKey = process.env.OPENAI_API_KEY,
  signal?: AbortSignal,
  runtime?: NuwaModelRuntime,
): Promise<ModelTaskOutputMap[T]> {
  const validation = validateModelTaskRequest(rawRequest);
  if (!validation.ok) throw modelError(validation.code, validation.error);
  const request = validation.value;
  const runtimeEndpoint = runtime
    ? request.task === "screenshot-metadata" ? runtime.vision : runtime.primary
    : undefined;
  const resolvedApiKey = runtimeEndpoint?.apiKey ?? apiKey;
  if (!resolvedApiKey) throw modelError("MODEL_NOT_CONFIGURED", "模型服务未配置");
  const lifetime = createModelRequestLifetime(signal);
  const model = getConfiguredModel(request.task, runtime);
  const chatCompletions = usesChatCompletions(model);
  const instructions = getNeigongInstructions(request.task);
  const input = buildNeigongInput(request);

  try {
    let response: Response;
    try {
      response = await fetch(getModelUrl(model, runtime, request.task), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resolvedApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(chatCompletions
          ? {
              model,
              messages: [
                { role: "system", content: instructions },
                {
                  role: "user",
                  content: input.map((item) => item.type === "input_text"
                    ? { type: "text", text: item.text }
                    : { type: "image_url", image_url: { url: item.image_url, detail: item.detail } }),
                },
              ],
              response_format: { type: "json_schema", json_schema: RESPONSE_FORMATS[request.task] },
              max_tokens: MAX_OUTPUT_TOKENS[request.task],
              temperature: 0,
            }
          : {
              model,
              instructions,
              input: [{ role: "user", content: input }],
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
    const outputText = chatCompletions
      ? extractChatOutputText(apiResponse)
      : extractOutputText(apiResponse);
    if (!outputText) throw modelError("MODEL_SCHEMA_INVALID", "模型输出为空");

    let output: unknown;
    try {
      const parsed = JSON.parse(chatCompletions ? unwrapJsonCodeFence(outputText) : outputText);
      output = chatCompletions ? normalizeClaudeResult(request.task, parsed) : parsed;
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
