// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { callNeigongModel, NeigongModelError } from "../../../../lib/neigong/server/model.ts";
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { validateModelTaskRequest } from "../../../../lib/neigong/server/schemas.ts";

export const runtime = "edge";

const MAX_REQUEST_BYTES = 900 * 1024;

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function failure(code: string, error: string, retryable: boolean, status: number) {
  return jsonResponse({ ok: false, code, error, retryable }, status);
}

const MODEL_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  MODEL_NOT_CONFIGURED: "模型服务未配置",
  MODEL_AUTH: "模型鉴权失败",
  MODEL_RATE_LIMIT: "模型请求限流",
  MODEL_NETWORK: "模型网络连接失败",
  MODEL_TIMEOUT: "模型响应超时，请重试",
  MODEL_UPSTREAM: "模型服务暂时不可用",
  MODEL_SCHEMA_INVALID: "模型返回格式无效",
};

async function readLimitedBody(request: Request): Promise<string | Response> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0) return failure("INVALID_REQUEST", "Content-Length 无效", false, 400);
    if (declared > MAX_REQUEST_BYTES) return failure("REQUEST_TOO_LARGE", "请求正文超过 900KB", false, 413);
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return failure("REQUEST_TOO_LARGE", "请求正文超过 900KB", false, 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export async function POST(request: Request) {
  const bodyText = await readLimitedBody(request);
  if (bodyText instanceof Response) return bodyText;

  let value: unknown;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return failure("INVALID_JSON", "请求正文不是合法 JSON", false, 400);
  }

  const validation = validateModelTaskRequest(value);
  if (!validation.ok) return failure(validation.code, validation.error, false, 400);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return failure("MODEL_NOT_CONFIGURED", "模型服务未配置", false, 503);

  try {
    const result = await callNeigongModel(validation.value, apiKey, request.signal);
    const clientResult = validation.value.task === "synthesis"
      ? {
          findings: result.findings.map((finding) => ({
            id: finding.id,
            status: finding.status,
            evidenceIds: [...finding.evidenceIds],
          })),
        }
      : result;
    return jsonResponse({
      ok: true,
      task: validation.value.task,
      requestId: validation.value.requestId,
      result: clientResult,
    }, 200);
  } catch (error) {
    if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    if (error instanceof NeigongModelError) {
      const status = error.code === "MODEL_TIMEOUT"
        ? 504
        : error.code === "MODEL_NOT_CONFIGURED"
        ? 503
        : error.code === "MODEL_RATE_LIMIT" || error.code === "MODEL_NETWORK" || error.code === "MODEL_UPSTREAM"
          ? 503
          : 502;
      return failure(
        error.code,
        MODEL_ERROR_MESSAGES[error.code] ?? "模型调用失败",
        error.retryable,
        status,
      );
    }
    return failure("MODEL_INTERNAL", "模型调用失败", true, 500);
  }
}
