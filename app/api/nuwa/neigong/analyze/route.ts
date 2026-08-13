// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { POST as analyzeNeigong } from "../../../neigong/analyze/route.ts";
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { authorizeProxyToken } from "../../../../../lib/server/knowledge-context.ts";

export const runtime = "edge";

export async function POST(request: Request) {
  const authorization = authorizeProxyToken(
    request.headers.get("X-Product-Analysis-Token"),
  );
  if (!authorization.ok) {
    return Response.json(
      {
        ok: false,
        code: authorization.code,
        error: authorization.error,
        retryable: false,
      },
      {
        status: authorization.status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return analyzeNeigong(request);
}
