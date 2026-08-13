// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { POST as analyze } from "../../analyze/route.ts";
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { authorizeProxyToken } from "../../../../lib/server/knowledge-context.ts";

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
  return analyze(request);
}
