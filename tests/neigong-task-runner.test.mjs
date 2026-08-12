import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrimaryAnalysisTasks,
  buildSynthesisTask,
  runTaskQueue,
  taskQueueReducer,
} from "../lib/neigong/task-runner.ts";
import {
  MAX_SCREENSHOT_BYTES,
  prepareReviewScreenshot,
} from "../lib/neigong/image.ts";

function analysisTask(id, productId = "own") {
  return {
    id,
    productId,
    task: "review-taxonomy",
    payload: {
      task: "review-taxonomy",
      requestId: id,
      productId,
      input: { rows: [{ rowId: `${id}-r1`, initialText: "有效", followupText: "" }] },
    },
  };
}

function success(task) {
  return {
    task: task.task,
    requestId: task.payload.requestId,
    output: { labels: [] },
    errors: [],
    warnings: [],
  };
}

function retryableError(message = "temporary") {
  return Object.assign(new Error(message), { code: "MODEL_UPSTREAM", retryable: true });
}

function terminalError(message = "invalid") {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST", retryable: false });
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function review(productId, sort, rank) {
  return {
    rowId: `${productId}-${sort}-${rank}`,
    sourceId: `${productId}-${sort}`,
    sourceRow: rank + 1,
    productId,
    sort,
    rank,
    date: "",
    sku: "",
    initialText: `评价 ${rank}`,
    followupText: "",
    normalizedText: `评价${rank}`,
  };
}

function question(productId, rank) {
  return {
    rowId: `${productId}-question-${rank}`,
    sourceId: `${productId}-questions`,
    sourceRow: rank + 1,
    productId,
    rank,
    questionText: `问题 ${rank}`,
    answer: `回答 ${rank}`,
    date: "",
    normalizedText: `问题${rank}`,
  };
}

function productPack(productId, screenshotFile, defaultCount = 55) {
  return {
    product: { productId, role: "self", name: "我方" },
    reviews: [
      ...Array.from({ length: defaultCount }, (_, index) => review(productId, "default", index + 1)),
      ...Array.from({ length: 51 }, (_, index) => review(productId, "recent", index + 1)),
    ],
    questions: Array.from({ length: 51 }, (_, index) => question(productId, index + 1)),
    sources: [],
    screenshot: { file: screenshotFile, sourceId: `${productId}-review-tags`, status: "ready" },
    excludedRows: [],
    errors: [],
    warnings: [],
  };
}

function preparedScreenshot(byteLength = 12, overrides = {}) {
  const bytes = new Uint8Array(byteLength);
  if (byteLength >= 12) {
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  }
  return {
    dataUrl: `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`,
    width: 100,
    height: 200,
    bytes: byteLength,
    ...overrides,
  };
}

function synthesisFacts() {
  return {
    products: [{ productId: "own", role: "self", name: "我方" }],
    completeness: [{
      evidenceId: "DATA-own-default",
      productId: "own",
      kind: "default_reviews",
      expectedRows: 100,
      validRows: 100,
      usedRows: 100,
      status: "complete",
    }],
    readiness: ["F01", "F02", "F03"].map((findingId) => ({
      findingId,
      status: "unavailable",
      reason: "测试资料不足",
      evidenceIds: ["DATA-own-default"],
    })),
    aggregates: { taxonomy: [], topics: [], dimensions: [], duplicateRows: [], crossSortOverlap: [] },
  };
}

test("主队列默认并发四个任务且每个失败任务只自动重试一次", async () => {
  let active = 0;
  let peak = 0;
  const attempts = new Map();
  const tasks = Array.from({ length: 5 }, (_, index) => analysisTask(`t${index + 1}`));

  const result = await runTaskQueue(tasks, async (task) => {
    active += 1;
    peak = Math.max(peak, active);
    attempts.set(task.id, (attempts.get(task.id) ?? 0) + 1);
    await tick();
    active -= 1;
    if (task.id === "t3" && attempts.get(task.id) === 1) throw retryableError();
    return success(task);
  }, { retries: 1 });

  assert.equal(peak, 4);
  assert.equal(attempts.get("t3"), 2);
  assert.equal(result.failed.length, 0);
  assert.equal(result.completed.length, 5);
});

test("显式传入过高并发时仍最多同时执行四个模型任务", async () => {
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => analysisTask(`cap-${index + 1}`));

  const result = await runTaskQueue(tasks, async (task) => {
    active += 1;
    peak = Math.max(peak, active);
    await tick();
    active -= 1;
    return success(task);
  }, { concurrency: 99, retries: 1 });

  assert.equal(peak, 4);
  assert.equal(result.completed.length, 8);
});

test("abort 后不调度剩余任务、不重试、不发 observer 且不记为 failed", async () => {
  const controller = new AbortController();
  const gates = [];
  const started = [];
  const observations = [];
  const tasks = [analysisTask("abort-1"), analysisTask("abort-2"), analysisTask("never-start")];

  const queuePromise = runTaskQueue(tasks, async (task) => {
    started.push(task.id);
    if (task.id === "never-start") return success(task);
    await new Promise((resolve) => gates.push(resolve));
    if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError");
    return success(task);
  }, {
    concurrency: 2,
    retries: 1,
    signal: controller.signal,
    onProgress: (state) => observations.push(state),
  });

  while (started.length < 2) await tick();
  const observationsBeforeAbort = observations.length;
  controller.abort();
  for (const resolve of gates) resolve();
  const result = await queuePromise;

  assert.deepEqual(started, ["abort-1", "abort-2"]);
  assert.equal(observations.length, observationsBeforeAbort);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.running, []);
  assert.equal(result.tasks["never-start"].status, "pending");
});

test("abort 与 retryable error 同时发生时不自动重试也不标失败", async () => {
  const controller = new AbortController();
  let executions = 0;
  const result = await runTaskQueue([analysisTask("abort-retry")], async () => {
    executions += 1;
    controller.abort();
    throw retryableError();
  }, { concurrency: 2, retries: 1, signal: controller.signal });

  assert.equal(executions, 1);
  assert.deepEqual(result.failed, []);
  assert.equal(result.tasks["abort-retry"].status, "pending");
});

test("任务构建在已取消会话中静默中止且不启动截图处理", async () => {
  const controller = new AbortController();
  const pack = productPack(
    "cancelled-build",
    new File(["x"], "review.png", { type: "image/png" }),
  );
  controller.abort();

  await assert.rejects(
    buildPrimaryAnalysisTasks([pack], { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(pack.screenshot.status, "ready");
});

test("进度 observer 在 running 快照中取消时不得启动该任务", async () => {
  const controller = new AbortController();
  let executions = 0;
  const result = await runTaskQueue([analysisTask("observer-abort")], async (task) => {
    executions += 1;
    return success(task);
  }, {
    concurrency: 2,
    retries: 1,
    signal: controller.signal,
    onProgress: (state) => {
      if (state.running.length) controller.abort();
    },
  });

  assert.equal(executions, 0);
  assert.deepEqual(result.running, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.tasks["observer-abort"].status, "pending");
});

test("不可重试错误不二次调用，自动重试后仍失败进入 failed", async () => {
  const attempts = new Map();
  const tasks = [analysisTask("terminal"), analysisTask("retryable")];

  const result = await runTaskQueue(tasks, async (task) => {
    attempts.set(task.id, (attempts.get(task.id) ?? 0) + 1);
    if (task.id === "terminal") throw terminalError();
    throw retryableError();
  }, { concurrency: 2, retries: 1 });

  assert.equal(attempts.get("terminal"), 1);
  assert.equal(attempts.get("retryable"), 2);
  assert.deepEqual(result.failed, ["terminal", "retryable"]);
  assert.deepEqual(result.tasks.terminal.error, {
    code: "INVALID_REQUEST",
    message: "invalid",
    retryable: false,
  });
});

test("人工 retry 只重跑指定失败任务且成功结果不会被覆盖", async () => {
  const tasks = [analysisTask("done"), analysisTask("failed"), analysisTask("untouched")];
  const first = await runTaskQueue(tasks, async (task) => {
    if (task.id === "failed") throw terminalError();
    return success(task);
  }, { concurrency: 2, retries: 1 });
  const doneResult = first.results.done;

  const retrySuccess = taskQueueReducer(first, { type: "retry", taskId: "done" });
  assert.equal(retrySuccess.tasks.done.status, "succeeded");
  const retried = taskQueueReducer(retrySuccess, { type: "retry", taskId: "failed" });
  const rerunIds = [];
  const second = await runTaskQueue(tasks, async (task) => {
    rerunIds.push(task.id);
    return success(task);
  }, { concurrency: 2, retries: 1, initialState: retried });

  assert.deepEqual(rerunIds, ["failed"]);
  assert.equal(second.results.done, doneResult);
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.completed, ["done", "failed", "untouched"]);
});

test("批量 retry 把全部失败任务重新入队且保留成功结果", async () => {
  const tasks = [analysisTask("done"), analysisTask("failed-1"), analysisTask("failed-2")];
  const first = await runTaskQueue(tasks, async (task) => {
    if (task.id !== "done") throw terminalError();
    return success(task);
  }, { concurrency: 2, retries: 1 });
  const doneResult = first.results.done;

  const retried = taskQueueReducer(first, { type: "retry-failed" });

  assert.deepEqual(retried.pending, ["failed-1", "failed-2"]);
  assert.deepEqual(retried.failed, []);
  assert.equal(retried.tasks.done.status, "succeeded");
  assert.equal(retried.results.done, doneResult);
});

test("编排器把全部失败任务按四路并行重试且不重跑成功任务", async () => {
  const { createQueueOrchestrator } = await import("../lib/neigong/queue-orchestrator.ts");
  const tasks = [analysisTask("done"), ...Array.from({ length: 6 }, (_, index) => analysisTask(`failed-${index + 1}`))];
  const first = await runTaskQueue(tasks, async (task) => {
    if (task.id !== "done") throw terminalError();
    return success(task);
  }, { concurrency: 2, retries: 1 });
  const doneResult = first.results.done;
  let active = 0;
  let peak = 0;
  const executed = [];
  let finished;

  await createQueueOrchestrator().retryFailed({
    queue: first,
    tasks,
    execute: async (task) => {
      executed.push(task.id);
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return success(task);
    },
    onProgress() {},
    onFinish: (queue) => { finished = queue; },
  });

  assert.equal(peak, 4);
  assert.deepEqual(executed.sort(), Array.from({ length: 6 }, (_, index) => `failed-${index + 1}`));
  assert.equal(finished.results.done, doneResult);
  assert.deepEqual(finished.failed, []);
});

test("批量 retry 运行中重复点击不会启动第二组请求", async () => {
  const { createQueueOrchestrator } = await import("../lib/neigong/queue-orchestrator.ts");
  const tasks = [analysisTask("failed")];
  const first = await runTaskQueue(tasks, async () => { throw terminalError(); }, {
    concurrency: 2,
    retries: 1,
  });
  const gate = deferred();
  const started = deferred();
  let executions = 0;
  const orchestrator = createQueueOrchestrator();
  const options = {
    queue: first,
    tasks,
    execute: async (task) => {
      executions += 1;
      started.resolve();
      await gate.promise;
      return success(task);
    },
    onProgress() {},
    onFinish() {},
  };

  const firstRetry = orchestrator.retryFailed(options);
  await started.promise;
  const duplicate = await orchestrator.retryFailed(options);
  assert.equal(duplicate, undefined);
  assert.equal(executions, 1);
  gate.resolve();
  await firstRetry;
  assert.equal(executions, 1);
});

test("批量 retry 不会从陈旧队列重新执行已排除竞品", async () => {
  const { createQueueOrchestrator } = await import("../lib/neigong/queue-orchestrator.ts");
  const tasks = [analysisTask("own-failed", "own"), analysisTask("rival-failed", "rival")];
  const failed = await runTaskQueue(tasks, async () => { throw terminalError(); }, {
    concurrency: 2,
    retries: 1,
  });
  const orchestrator = createQueueOrchestrator();
  orchestrator.exclude({ productId: "rival", queue: failed, onFinish() {} });
  const executed = [];

  await orchestrator.retryFailed({
    queue: failed,
    tasks,
    execute: async (task) => {
      executed.push(task.id);
      return success(task);
    },
    onProgress() {},
    onFinish() {},
  });

  assert.deepEqual(executed, ["own-failed"]);
});

test("同一任务重复完成保持第一次成功结果且不会再次执行", async () => {
  const task = analysisTask("once");
  const first = await runTaskQueue([task], async (item) => success(item), {
    concurrency: 2,
    retries: 1,
  });
  const original = first.results.once;
  let executions = 0;
  const second = await runTaskQueue([task], async (item) => {
    executions += 1;
    return { ...success(item), output: { labels: [{ rowId: "tampered" }] } };
  }, { concurrency: 2, retries: 1, initialState: first });

  assert.equal(executions, 0);
  assert.equal(second.results.once, original);
  assert.deepEqual(second.completed, ["once"]);
});

test("人工重试与竞品排除无论先后都以排除为终态", async () => {
  const task = analysisTask("rival-failed", "rival");
  const failed = await runTaskQueue([task], async () => { throw terminalError(); }, {
    concurrency: 2,
    retries: 1,
  });

  const retryThenExclude = taskQueueReducer(
    taskQueueReducer(failed, { type: "retry", taskId: task.id }),
    { type: "exclude-product", productId: "rival" },
  );
  const excludeThenRetry = taskQueueReducer(
    taskQueueReducer(failed, { type: "exclude-product", productId: "rival" }),
    { type: "retry", taskId: task.id },
  );

  assert.equal(retryThenExclude.tasks[task.id].status, "excluded");
  assert.equal(excludeThenRetry.tasks[task.id].status, "excluded");
  assert.deepEqual(retryThenExclude.excluded, [task.id]);
  assert.deepEqual(excludeThenRetry.excluded, [task.id]);
});

test("真实 retry 编排在 exclude 前后竞态中取消旧 run 且不触发综合", async () => {
  const { createQueueOrchestrator } = await import("../lib/neigong/queue-orchestrator.ts");
  const tasks = [
    analysisTask("rival-retry", "rival"),
    analysisTask("rival-other", "rival"),
    analysisTask("own-failed", "own"),
  ];
  const failed = await runTaskQueue(tasks, async () => { throw terminalError(); }, {
    concurrency: 2,
    retries: 1,
  });

  const retryGate = deferred();
  const retryStarted = deferred();
  let retrySignal;
  let uiQueue = failed;
  let synthesisStarts = 0;
  let staleFinishes = 0;
  const orchestrator = createQueueOrchestrator();
  const finish = (queue) => {
    uiQueue = queue;
    if (queue.failed.length === 0) synthesisStarts += 1;
  };

  const retryPromise = orchestrator.retry({
    taskId: "rival-retry",
    queue: uiQueue,
    tasks,
    execute: async (task, signal) => {
      retrySignal = signal;
      retryStarted.resolve();
      await retryGate.promise;
      return success(task);
    },
    onProgress: (queue) => { uiQueue = queue; },
    onFinish: (queue) => {
      staleFinishes += 1;
      finish(queue);
    },
  });

  await retryStarted.promise;
  const excluded = orchestrator.exclude({ productId: "rival", queue: uiQueue, onFinish: finish });
  assert.equal(retrySignal.aborted, true);
  assert.deepEqual(excluded.excluded.sort(), ["rival-other", "rival-retry"]);
  assert.deepEqual(excluded.failed, ["own-failed"]);
  retryGate.resolve();
  await retryPromise;

  assert.deepEqual(uiQueue.excluded.sort(), ["rival-other", "rival-retry"]);
  assert.deepEqual(uiQueue.failed, ["own-failed"]);
  assert.equal(staleFinishes, 0);
  assert.equal(synthesisStarts, 0);

  let ownExecutions = 0;
  await orchestrator.retry({
    taskId: "own-failed",
    queue: uiQueue,
    tasks,
    execute: async (task) => {
      ownExecutions += 1;
      return success(task);
    },
    onProgress: (queue) => { uiQueue = queue; },
    onFinish: finish,
  });
  assert.equal(ownExecutions, 1);
  assert.equal(uiQueue.tasks["own-failed"].status, "succeeded");
  assert.equal(synthesisStarts, 1);

  const reverse = createQueueOrchestrator();
  let reverseQueue = failed;
  let reverseExecutions = 0;
  reverse.exclude({ productId: "rival", queue: reverseQueue, onFinish: (queue) => { reverseQueue = queue; } });
  await reverse.retry({
    taskId: "rival-retry",
    queue: failed,
    tasks,
    execute: async (task) => {
      reverseExecutions += 1;
      return success(task);
    },
    onProgress: (queue) => { reverseQueue = queue; },
    onFinish: (queue) => { reverseQueue = queue; },
  });
  assert.equal(reverseExecutions, 0);
  assert.deepEqual(reverseQueue.excluded.sort(), ["rival-other", "rival-retry"]);
  assert.deepEqual(reverseQueue.failed, ["own-failed"]);
});

test("onProgress 同步异常与 retryable 标记均不得改变执行次数或队列结果", async () => {
  for (const observerError of [new Error("observer"), retryableError("observer retryable")]) {
    let executions = 0;
    let observations = 0;
    const result = await runTaskQueue([analysisTask("observed")], async (task) => {
      executions += 1;
      return success(task);
    }, {
      concurrency: 2,
      retries: 1,
      onProgress: () => {
        observations += 1;
        throw observerError;
      },
    });

    assert.equal(executions, 1);
    assert.ok(observations >= 2);
    assert.deepEqual(result.completed, ["observed"]);
    assert.deepEqual(result.failed, []);
  }
});

test("异步拒绝的进度与截图观察器不会产生 unhandledRejection 或改变主流程", async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let executions = 0;

  try {
    const queue = await runTaskQueue([analysisTask("async-observer")], async (task) => {
      executions += 1;
      return success(task);
    }, {
      concurrency: 2,
      retries: 1,
      onProgress: async () => {
        throw new Error("async progress observer");
      },
    });
    const pack = productPack("own", new File(["x"], "review.gif", { type: "image/gif" }));
    const tasks = await buildPrimaryAnalysisTasks([pack], {
      onScreenshotError: async () => {
        throw new Error("async screenshot observer");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(executions, 1);
    assert.deepEqual(queue.completed, ["async-observer"]);
    assert.deepEqual(queue.failed, []);
    assert.equal(pack.screenshot.status, "missing");
    assert.equal(tasks.some((task) => task.task === "review-taxonomy"), true);
    assert.equal(tasks.some((task) => task.task === "screenshot-metadata"), false);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("onProgress 收到与内部隔离的快照且历史快照不随迁移改变", async () => {
  const histories = [];
  let executions = 0;
  const result = await runTaskQueue([analysisTask("snapshot")], async (task) => {
    executions += 1;
    return success(task);
  }, {
    concurrency: 2,
    retries: 1,
    onProgress: (state) => {
      histories.push(state);
      if (histories.length === 1) {
        state.tasks.snapshot.status = "excluded";
        state.pending.splice(0);
        state.results.injected = success(analysisTask("injected"));
      }
    },
  });

  assert.equal(executions, 1);
  assert.equal(result.tasks.snapshot.status, "succeeded");
  assert.equal("injected" in result.results, false);
  assert.equal(histories[1].tasks.snapshot.status, "running");
  assert.deepEqual(histories[1].running, ["snapshot"]);
  assert.deepEqual(histories[1].results, {});
  assert.equal(histories.at(-1).tasks.snapshot.status, "succeeded");
  assert.deepEqual(histories.at(-1).completed, ["snapshot"]);
});

test("initialState 丢弃陈旧项并只保留身份匹配的成功结果", async () => {
  const ids = ["running", "no-result", "wrong-task", "wrong-request", "valid", "failed", "excluded"];
  const tasks = ids.map((id) => analysisTask(id, `current-${id}`));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const taskStates = Object.fromEntries(ids.map((id) => [id, {
    id,
    productId: `stale-${id}`,
    task: "question-topic",
    status: id === "running"
      ? "running"
      : id === "failed" || id === "excluded"
        ? id
        : "succeeded",
    attempts: 3,
  }]));
  taskStates.stale = {
    id: "stale",
    productId: "stale",
    task: "review-taxonomy",
    status: "succeeded",
    attempts: 1,
  };
  const results = {
    "wrong-task": { ...success(byId.get("wrong-task")), task: "question-topic" },
    "wrong-request": { ...success(byId.get("wrong-request")), requestId: "old-request" },
    valid: success(byId.get("valid")),
    excluded: success(byId.get("excluded")),
    stale: success(analysisTask("stale")),
  };
  const initialState = {
    tasks: taskStates,
    results,
    pending: [],
    running: ["running"],
    completed: ["no-result", "wrong-task", "wrong-request", "valid", "stale"],
    failed: ["failed"],
    excluded: ["excluded"],
  };
  const executed = [];

  const state = await runTaskQueue(tasks, async (task) => {
    executed.push(task.id);
    return success(task);
  }, { concurrency: 2, retries: 1, initialState });

  assert.deepEqual(executed, ["running", "no-result", "wrong-task", "wrong-request"]);
  assert.equal("stale" in state.tasks, false);
  assert.equal("stale" in state.results, false);
  assert.deepEqual(state.failed, ["failed"]);
  assert.deepEqual(state.excluded, ["excluded"]);
  assert.equal(state.tasks.valid.status, "succeeded");
  assert.equal(state.tasks.failed.productId, "current-failed");
  assert.equal(state.tasks.failed.task, "review-taxonomy");
  assert.equal(state.tasks.excluded.productId, "current-excluded");
  assert.equal(state.results.valid, results.valid);
});

test("exclude-product 只排除目标竞品未成功任务且成功任务保持完成", async () => {
  const tasks = [analysisTask("own-1", "own"), analysisTask("rival-1", "rival"), analysisTask("rival-2", "rival")];
  const partial = await runTaskQueue(tasks, async (task) => {
    if (task.id === "rival-2") throw terminalError();
    return success(task);
  }, { concurrency: 2, retries: 1 });
  const excluded = taskQueueReducer(partial, { type: "exclude-product", productId: "rival" });

  assert.equal(excluded.tasks["own-1"].status, "succeeded");
  assert.equal(excluded.tasks["rival-1"].status, "succeeded");
  assert.equal(excluded.tasks["rival-2"].status, "excluded");
  assert.deepEqual(Object.keys(excluded.results), ["own-1", "rival-1"]);
  assert.deepEqual(excluded.completed, ["own-1", "rival-1"]);
  assert.deepEqual(excluded.excluded, ["rival-2"]);
  assert.doesNotThrow(() => JSON.stringify(excluded));
});

test("主任务每 50 行分批，前 20 拆成两组 10 条并行且不预建 synthesis", async () => {
  const screenshotFile = new File([new Uint8Array([1])], "review.png", { type: "image/png" });
  const prepared = preparedScreenshot();
  const tasks = await buildPrimaryAnalysisTasks([productPack("own", screenshotFile)], {
    preparedScreenshots: { own: prepared },
  });

  const taxonomy = tasks.filter((task) => task.task === "review-taxonomy");
  const questions = tasks.filter((task) => task.task === "question-topic");
  const top20 = tasks.filter((task) => task.task === "top20-dimensions");
  const screenshots = tasks.filter((task) => task.task === "screenshot-metadata");
  assert.deepEqual(taxonomy.map((task) => task.payload.input.rows.length), [50, 5, 50, 1]);
  assert.deepEqual(questions.map((task) => task.payload.input.rows.length), [50, 1]);
  assert.equal(top20.length, 2);
  assert.deepEqual(top20.map((task) => task.payload.input.rows.map((row) => row.rowId)), [
    Array.from({ length: 10 }, (_, index) => `own-default-${index + 1}`),
    Array.from({ length: 10 }, (_, index) => `own-default-${index + 11}`),
  ]);
  assert.equal(screenshots.length, 1);
  assert.deepEqual(screenshots[0].payload.input, prepared);
  assert.equal(tasks.some((task) => task.task === "synthesis"), false);

  const facts = synthesisFacts();
  const synthesis = buildSynthesisTask(facts);
  assert.equal(synthesis.task, "synthesis");
  assert.equal(synthesis.id, "synthesis");
  assert.equal(synthesis.payload.input.facts, facts);
});

test("默认评价不足 20 条不创建六维任务，达到 20 条才创建", async () => {
  const under = productPack("under", undefined, 19);
  const boundary = productPack("boundary", undefined, 20);
  delete under.screenshot;
  delete boundary.screenshot;

  const underTasks = await buildPrimaryAnalysisTasks([under]);
  const boundaryTasks = await buildPrimaryAnalysisTasks([boundary]);

  assert.equal(underTasks.some(({ task }) => task === "top20-dimensions"), false);
  assert.equal(boundaryTasks.filter(({ task }) => task === "top20-dimensions").length, 2);
});

test("截图超出传输能力时降级为 missing 且不阻断 Excel 主任务", async () => {
  const pack = productPack("own", new File(["x"], "review.gif", { type: "image/gif" }));
  const screenshotErrors = [];
  const tasks = await buildPrimaryAnalysisTasks([pack], {
    onScreenshotError: (productId, error) => screenshotErrors.push({ productId, error }),
  });

  assert.equal(pack.screenshot.status, "missing");
  assert.equal(tasks.some((task) => task.task === "review-taxonomy"), true);
  assert.equal(tasks.some((task) => task.task === "screenshot-metadata"), false);
  assert.equal(screenshotErrors.length, 1);
  assert.equal(screenshotErrors[0].productId, "own");
  assert.equal(screenshotErrors[0].error.message, "SCREENSHOT_TRANSPORT_LIMIT");
});

test("截图错误观察器抛错也必须保持 missing 并返回 Excel 主任务", async () => {
  const pack = productPack("own", new File(["x"], "review.gif", { type: "image/gif" }));
  const tasks = await buildPrimaryAnalysisTasks([pack], {
    onScreenshotError: () => {
      throw new Error("observer failed");
    },
  });

  assert.equal(pack.screenshot.status, "missing");
  assert.equal(tasks.some((task) => task.task === "review-taxonomy"), true);
  assert.equal(tasks.some((task) => task.task === "screenshot-metadata"), false);
});

test("prepared screenshot 的非法、超限和字段不一致输入全部安全降级", async () => {
  const cases = [
    preparedScreenshot(2 * 1024 * 1024),
    { ...preparedScreenshot(), dataUrl: "data:image/webp;base64,%%%" },
    preparedScreenshot(12, { bytes: 13 }),
    preparedScreenshot(12, { width: 0 }),
    preparedScreenshot(12, { height: 1.5 }),
  ];

  for (const [index, prepared] of cases.entries()) {
    const productId = `prepared-${index}`;
    const pack = productPack(productId, new File(["x"], "review.png", { type: "image/png" }));
    const errors = [];
    const tasks = await buildPrimaryAnalysisTasks([pack], {
      preparedScreenshots: { [productId]: prepared },
      onScreenshotError: (_id, error) => errors.push(error),
    });

    assert.equal(pack.screenshot.status, "missing");
    assert.equal(tasks.some((task) => task.task === "screenshot-metadata"), false);
    assert.equal(tasks.some((task) => task.task === "review-taxonomy"), true);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "SCREENSHOT_TRANSPORT_LIMIT");
  }
});

test("prepared screenshot 超长 Data URL 在正则和 atob 前立即拒绝", async () => {
  const originalAtob = globalThis.atob;
  let atobCalls = 0;
  globalThis.atob = (value) => {
    atobCalls += 1;
    return originalAtob(value);
  };
  const pack = productPack("oversized-data-url", new File(["x"], "review.png", { type: "image/png" }));
  const errors = [];

  try {
    const tasks = await buildPrimaryAnalysisTasks([pack], {
      preparedScreenshots: {
        "oversized-data-url": {
          dataUrl: `data:image/webp;base64,${"A".repeat(4 * 1024 * 1024)}`,
          width: 100,
          height: 100,
          bytes: 12,
        },
      },
      onScreenshotError: (_productId, error) => errors.push(error),
    });

    assert.equal(atobCalls, 0);
    assert.equal(pack.screenshot.status, "missing");
    assert.equal(tasks.some((task) => task.task === "screenshot-metadata"), false);
    assert.equal(tasks.some((task) => task.task === "review-taxonomy"), true);
    assert.equal(errors.length, 1);
  } finally {
    globalThis.atob = originalAtob;
  }
});

test("截图压缩按尺寸和质量顺序尝试并在 560KB 内返回 WebP Data URL", async () => {
  const originalDocument = globalThis.document;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const attempts = [];
  let closed = false;
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return { fillRect() {}, drawImage() {}, set fillStyle(_value) {} };
    },
    toBlob(callback, type, quality) {
      attempts.push({ width: this.width, height: this.height, type, quality });
      const size = this.width === 1500 && quality === 0.82 ? 100 : MAX_SCREENSHOT_BYTES + 1;
      callback(new Blob([new Uint8Array(size)], { type: "image/webp" }));
    },
  };
  globalThis.document = { createElement: () => canvas };
  globalThis.createImageBitmap = async () => ({ width: 2400, height: 1200, close: () => { closed = true; } });

  try {
    const result = await prepareReviewScreenshot(new File([new Uint8Array([1])], "review.png", { type: "image/png" }));
    assert.equal(result.width, 1500);
    assert.equal(result.height, 750);
    assert.equal(result.bytes, 100);
    assert.match(result.dataUrl, /^data:image\/webp;base64,/);
    assert.deepEqual(attempts.map(({ width, quality }) => [width, quality]), [
      [1800, 0.82], [1800, 0.68], [1800, 0.54], [1800, 0.42], [1500, 0.82],
    ]);
    assert.equal(closed, true);
  } finally {
    globalThis.document = originalDocument;
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});

test("不支持的截图类型明确失败且不会进入 Canvas", async () => {
  await assert.rejects(
    prepareReviewScreenshot(new File(["x"], "review.gif", { type: "image/gif" })),
    (error) => error instanceof Error && error.message === "SCREENSHOT_TRANSPORT_LIMIT",
  );
});
