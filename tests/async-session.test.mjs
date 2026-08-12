import assert from "node:assert/strict";
import test from "node:test";

import { createAsyncSessionGuard } from "../lib/async-session.ts";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("新会话会取消旧会话并拒绝旧异步结果回写", async () => {
  const guard = createAsyncSessionGuard();
  const market = guard.begin("market");
  const pending = deferred();
  const writes = [];
  const staleCompletion = pending.promise.then((value) => {
    if (guard.isCurrent(market)) writes.push(value);
  });

  const review = guard.begin("review");
  assert.equal(market.signal.aborted, true);
  assert.equal(guard.isCurrent(market), false);
  assert.equal(guard.isCurrent(review), true);

  const buyer = guard.begin("buyer");
  assert.equal(review.signal.aborted, true);
  assert.equal(guard.isCurrent(review), false);
  assert.equal(guard.isCurrent(buyer), true);

  pending.resolve("旧市场结果");
  await staleCompletion;
  assert.deepEqual(writes, []);
});

test("切换模块或卸载使当前 generation 失效且 cancel 可重复调用", () => {
  const guard = createAsyncSessionGuard();
  const run = guard.begin("review");

  guard.cancel();
  guard.cancel();

  assert.equal(run.signal.aborted, true);
  assert.equal(guard.isCurrent(run), false);
});
