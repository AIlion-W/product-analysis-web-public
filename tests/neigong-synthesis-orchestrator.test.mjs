import assert from "node:assert/strict";
import test from "node:test";

import { createSynthesisOrchestrator } from "../lib/neigong/synthesis-orchestrator.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function failure(code, retryable) {
  return Object.assign(new Error(code), { code, retryable });
}

test("首次 502 自动重试一次并成功", async () => {
  const orchestrator = createSynthesisOrchestrator();
  let calls = 0;
  let completed;
  await orchestrator.run({
    runKey: "queue-a",
    execute: async () => {
      calls += 1;
      if (calls === 1) throw failure("MODEL_UPSTREAM", true);
      return { report: true };
    },
    onSuccess: (value) => { completed = value; },
    onFailure: () => assert.fail("不应失败"),
  });
  assert.equal(calls, 2);
  assert.deepEqual(completed, { report: true });
});

test("两次失败后可用同一 runKey 人工重试且只重跑 synthesis", async () => {
  const orchestrator = createSynthesisOrchestrator();
  let calls = 0;
  let failed;
  const options = {
    runKey: "same-main-queue",
    execute: async () => {
      calls += 1;
      if (calls <= 2) throw failure("MODEL_UPSTREAM", true);
      return "report";
    },
    onSuccess: () => {},
    onFailure: (error) => { failed = error; },
  };
  await orchestrator.run(options);
  assert.equal(calls, 2);
  assert.equal(failed.code, "MODEL_UPSTREAM");

  let completed;
  await orchestrator.run({ ...options, onSuccess: (value) => { completed = value; } });
  assert.equal(calls, 3);
  assert.equal(completed, "report");
});

test("non-retryable 不自动重试但仍允许人工重试", async () => {
  const orchestrator = createSynthesisOrchestrator();
  let calls = 0;
  const execute = async () => {
    calls += 1;
    if (calls === 1) throw failure("MODEL_SCHEMA_INVALID", false);
    return "report";
  };
  await orchestrator.run({ runKey: "queue", execute, onSuccess: () => {}, onFailure: () => {} });
  assert.equal(calls, 1);
  await orchestrator.run({ runKey: "queue", execute, onSuccess: () => {}, onFailure: () => {} });
  assert.equal(calls, 2);
});

test("重复点击不并发，切换取消后 stale 结果不回写", async () => {
  const orchestrator = createSynthesisOrchestrator();
  const pending = deferred();
  let successes = 0;
  let failures = 0;
  const options = {
    runKey: "queue",
    execute: async (signal) => {
      assert.equal(signal.aborted, false);
      return pending.promise;
    },
    onSuccess: () => { successes += 1; },
    onFailure: () => { failures += 1; },
  };
  const first = orchestrator.run(options);
  const duplicate = await orchestrator.run(options);
  assert.equal(duplicate, undefined);
  orchestrator.cancel();
  pending.resolve("stale-report");
  await first;
  assert.equal(successes, 0);
  assert.equal(failures, 0);
});
