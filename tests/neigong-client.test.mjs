import assert from "node:assert/strict";
import test from "node:test";

import { executeAnalysisTask } from "../lib/neigong/client.ts";
import { runTaskQueue } from "../lib/neigong/task-runner.ts";

function analysisTask() {
  return {
    id: "review-taxonomy:self:default:1",
    productId: "self",
    task: "review-taxonomy",
    payload: {
      task: "review-taxonomy",
      requestId: "review-taxonomy:self:default:1",
      productId: "self",
      input: { rows: [] },
    },
  };
}

function successResponse() {
  return Response.json({
    ok: true,
    task: "review-taxonomy",
    requestId: "review-taxonomy:self:default:1",
    result: { labels: [] },
  });
}

async function withFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("HTML 502 按可重试 HTTP 错误自动重试后成功", async () => {
  let calls = 0;
  const state = await withFetch(async () => {
    calls += 1;
    return calls === 1
      ? new Response("<html>bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } })
      : successResponse();
  }, () => runTaskQueue([analysisTask()], executeAnalysisTask, { concurrency: 2, retries: 1 }));

  assert.equal(calls, 2);
  assert.deepEqual(state.completed, ["review-taxonomy:self:default:1"]);
  assert.deepEqual(state.failed, []);
});

test("HTML 429 同样按可重试 HTTP 错误自动重试", async () => {
  let calls = 0;
  const state = await withFetch(async () => {
    calls += 1;
    return calls === 1
      ? new Response("rate limited", { status: 429, headers: { "Content-Type": "text/html" } })
      : successResponse();
  }, () => runTaskQueue([analysisTask()], executeAnalysisTask, { concurrency: 2, retries: 1 }));

  assert.equal(calls, 2);
  assert.deepEqual(state.completed, ["review-taxonomy:self:default:1"]);
});

test("HTML 400 不重试并保留 HTTP 身份", async () => {
  let calls = 0;
  const state = await withFetch(async () => {
    calls += 1;
    return new Response("bad request", { status: 400, headers: { "Content-Type": "text/html" } });
  }, () => runTaskQueue([analysisTask()], executeAnalysisTask, { concurrency: 2, retries: 1 }));

  assert.equal(calls, 1);
  assert.deepEqual(state.failed, ["review-taxonomy:self:default:1"]);
  assert.equal(state.tasks["review-taxonomy:self:default:1"].error.code, "HTTP_400");
  assert.equal(state.tasks["review-taxonomy:self:default:1"].error.retryable, false);
});

test("合法 failure envelope 的 code、error、retryable 优先于 HTTP 推断", async () => {
  let calls = 0;
  const state = await withFetch(async () => {
    calls += 1;
    return Response.json(
      { ok: false, code: "MODEL_POLICY", error: "拒绝处理", retryable: false },
      { status: 502 },
    );
  }, () => runTaskQueue([analysisTask()], executeAnalysisTask, { concurrency: 2, retries: 1 }));

  assert.equal(calls, 1);
  assert.equal(state.tasks["review-taxonomy:self:default:1"].error.code, "MODEL_POLICY");
  assert.equal(state.tasks["review-taxonomy:self:default:1"].error.message, "拒绝处理");
  assert.equal(state.tasks["review-taxonomy:self:default:1"].error.retryable, false);
});

test("client 将 AbortSignal 原样传给 fetch 且取消不转换为网络失败", async () => {
  const controller = new AbortController();
  await withFetch(async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    controller.abort();
    throw new DOMException("cancelled", "AbortError");
  }, async () => {
    await assert.rejects(
      executeAnalysisTask(analysisTask(), controller.signal),
      (error) => error?.name === "AbortError" && error?.code !== "MODEL_NETWORK",
    );
  });
});

test("fetch resolve 后读取正文期间取消仍保持 AbortError", async () => {
  const controller = new AbortController();
  await withFetch(async (_url, init) => ({
    ok: true,
    status: 200,
    async text() {
      assert.equal(init.signal, controller.signal);
      controller.abort();
      throw new DOMException("cancelled while reading", "AbortError");
    },
  }), async () => {
    await assert.rejects(
      executeAnalysisTask(analysisTask(), controller.signal),
      (error) => error?.name === "AbortError" && error?.code !== "MODEL_NETWORK",
    );
  });
});
