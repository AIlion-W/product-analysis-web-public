import type { AnalysisTask } from "./task-runner";
// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { isAbortError, throwIfAborted } from "../async-session.ts";
// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { toModelTaskResult, type ModelTaskApiSuccess } from "./types.ts";

function taskError(code: string, message: string, retryable: boolean): Error {
  return Object.assign(new Error(message), { code, retryable });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export async function executeAnalysisTask(task: AnalysisTask, signal?: AbortSignal) {
  throwIfAborted(signal);
  let response: Response;
  try {
    response = await fetch("/api/neigong/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task.payload),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    if (isAbortError(error)) throw error;
    throw taskError("MODEL_NETWORK", "模型服务网络请求失败。", true);
  }
  throwIfAborted(signal);

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    if (isAbortError(error)) throw error;
    throw taskError("MODEL_NETWORK", "读取模型服务响应失败。", true);
  }
  throwIfAborted(signal);

  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    body = undefined;
  }
  const value = objectValue(body);
  const validFailureEnvelope = value?.ok === false
    && typeof value.code === "string"
    && typeof value.error === "string"
    && typeof value.retryable === "boolean";
  if (validFailureEnvelope) {
    throw taskError(
      value.code as string,
      value.error as string,
      value.retryable as boolean,
    );
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw taskError(`HTTP_${response.status}`, `分析请求失败（HTTP ${response.status}）。`, retryable);
  }
  if (value?.ok !== true) throw taskError("INVALID_RESPONSE", "模型服务返回了无法解析的响应。", false);
  if (value.task !== task.task || value.requestId !== task.payload.requestId || !("result" in value)) {
    throw taskError("INVALID_RESPONSE", "模型服务返回的任务身份不匹配。", false);
  }

  return toModelTaskResult(value as unknown as ModelTaskApiSuccess);
}
