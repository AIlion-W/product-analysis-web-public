import assert from "node:assert/strict";
import test from "node:test";

test("工作区状态机提供可独立验证的 reducer", async () => {
  const stateModule = await import("../lib/neigong/workspace-state.ts").catch(() => undefined);
  assert.ok(stateModule, "workspace-state module must exist");
  assert.equal(typeof stateModule.workspaceReducer, "function");
  assert.equal(typeof stateModule.createWorkspaceState, "function");
});

function parsedPack(productId, role = "competitor") {
  return {
    product: { productId, role, name: "产品" },
    reviews: [],
    questions: [],
    sources: [],
    sourceMappings: [],
    excludedRows: [],
    errors: [],
    warnings: [],
  };
}

function settledQueue() {
  return {
    tasks: {},
    results: {},
    pending: [],
    running: [],
    completed: [],
    failed: [],
    excluded: [],
  };
}

test("主队列成功后等待综合报告，只有真实 ReportData action 才进入 report", async () => {
  const { createWorkspaceState, workspaceReducer } = await import("../lib/neigong/workspace-state.ts");
  const ready = workspaceReducer(createWorkspaceState(), { type: "queue-finish", queue: settledQueue() });

  assert.equal(ready.stage, "ready-for-synthesis");
  assert.equal(ready.report, null);

  const forcedReport = workspaceReducer(ready, { type: "stage", stage: "report" });
  assert.equal(forcedReport, ready);

  const report = { meta: { generatedAt: "2026-08-11", analysisReadiness: [] } };
  const reported = workspaceReducer(ready, { type: "report-ready", report });
  assert.equal(reported.stage, "report");
  assert.equal(reported.report, report);
});

test("报告校验失败停留综合进度态并拒绝部分正式报告", async () => {
  const { createWorkspaceState, workspaceReducer } = await import("../lib/neigong/workspace-state.ts");
  const ready = workspaceReducer(createWorkspaceState(), { type: "queue-finish", queue: settledQueue() });
  const failed = workspaceReducer(ready, {
    type: "report-failed",
    failure: { code: "REPORT_VALIDATION_FAILED", message: "UNKNOWN_EVIDENCE", retryable: false },
  });

  assert.equal(failed.stage, "ready-for-synthesis");
  assert.equal(failed.report, null);
  assert.equal(failed.synthesisStatus, "failed");
  assert.match(failed.notice, /REPORT_VALIDATION_FAILED/);

  const retrying = workspaceReducer(failed, { type: "synthesis-start" });
  assert.equal(retrying.synthesisStatus, "running");
  assert.equal(retrying.queue, ready.queue, "人工重试必须保留主队列结果");
});

test("删除竞品后旧 parse-complete 不回写且 hasParsedData 保持 false", async () => {
  const { createWorkspaceState, hasParsedSession, workspaceReducer } = await import("../lib/neigong/workspace-state.ts");
  const draft = { product: { productId: "rival", role: "competitor", name: "竞品" } };
  const added = workspaceReducer(createWorkspaceState(), { type: "add-competitor", draft });
  const removed = workspaceReducer(added, { type: "remove-competitor", productId: "rival" });

  assert.equal(hasParsedSession(removed), false);
  const staleCompletion = workspaceReducer(removed, {
    type: "parse-complete",
    productId: "rival",
    parsed: parsedPack("rival"),
  });

  assert.equal(staleCompletion, removed);
  assert.equal("rival" in staleCompletion.preflight, false);
  assert.equal(hasParsedSession(staleCompletion), false);
});

test("竞品状态机覆盖 0、1、3 和拒绝第 4 个竞品", async () => {
  const { createWorkspaceState, workspaceReducer } = await import("../lib/neigong/workspace-state.ts");
  const add = (state, index) => workspaceReducer(state, {
    type: "add-competitor",
    draft: {
      product: { productId: `rival-${index}`, role: "competitor", name: `竞品 ${index}` },
    },
  });
  const competitorCount = (state) => state.drafts.filter(({ product }) => product.role === "competitor").length;

  const zero = createWorkspaceState();
  assert.equal(competitorCount(zero), 0);
  const one = add(zero, 1);
  assert.equal(competitorCount(one), 1);
  const three = add(add(one, 2), 3);
  assert.equal(competitorCount(three), 3);
  const rejectedFourth = add(three, 4);
  assert.equal(rejectedFourth, three);
  assert.equal(competitorCount(rejectedFourth), 3);
});
