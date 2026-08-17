// Node contract tests execute source TypeScript directly; runtime imports need extensions.
import { handleAnalyze } from "../../analyze/route.ts";
import { authorizeProxyToken } from "../../../../lib/server/knowledge-context.ts";
import { readNuwaModelRuntime } from "../../../../lib/server/nuwa-model-runtime.ts";

export const runtime = "edge";

export async function POST(request: Request) {
  const authorization = authorizeProxyToken(
    request.headers.get("X-Product-Analysis-Token"),
  );
  if (!authorization.ok) {
    return Response.json(
      { error: authorization.error, code: authorization.code },
      {
        status: authorization.status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  const runtime = readNuwaModelRuntime(request.headers);
  if (!runtime.ok) {
    return Response.json(
      { error: runtime.error, code: runtime.code },
      { status: runtime.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return handleAnalyze(request, runtime.value);
}
