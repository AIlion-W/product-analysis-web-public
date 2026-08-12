import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the product analysis workbench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>产品分析助手<\/title>/i);
  assert.match(html, /先看市场，再拆竞品/);
  assert.match(html, /市场分析/);
  assert.match(html, /多竞品对比分析/);
  assert.match(html, /营销文案/);
  assert.match(html, /内功问诊/);
  assert.match(html, /全链路分析/);
  assert.doesNotMatch(html, /评价区全盘分析/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/);
});
