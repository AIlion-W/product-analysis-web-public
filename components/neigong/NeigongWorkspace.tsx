"use client";

import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";

import {
  createAsyncSessionGuard,
  isAbortError,
  type AsyncSessionRun,
} from "@/lib/async-session";
import { parseProductPack } from "@/lib/neigong/excel-parser";
import { executeAnalysisTask } from "@/lib/neigong/client";
import { prepareReviewScreenshot, type PreparedReviewScreenshot } from "@/lib/neigong/image";
import { createQueueOrchestrator } from "@/lib/neigong/queue-orchestrator";
import {
  buildReportData,
  buildSynthesisFacts,
} from "@/lib/neigong/report-builder";
import { createSynthesisOrchestrator } from "@/lib/neigong/synthesis-orchestrator";
import {
  buildPrimaryAnalysisTasks,
  buildSynthesisTask,
  runTaskQueue,
  type AnalysisTask,
} from "@/lib/neigong/task-runner";
import { type ParsedProductPack, type ReportData } from "@/lib/neigong/types";
import {
  createWorkspaceState,
  hasParsedSession,
  MAX_COMPETITORS,
  workspaceReducer,
  type WorkspaceStage,
} from "@/lib/neigong/workspace-state";

import { AnalysisProgress } from "./AnalysisProgress";
import { PreflightPanel, type PreflightProduct } from "./PreflightPanel";
import { ProductPackCard, type ProductPackDraft } from "./ProductPackCard";
import { ReportDashboard } from "./ReportDashboard";

export { MAX_COMPETITORS };

export type NeigongWorkspaceProps = {
  renderReport?: (report: ReportData) => ReactNode;
};

type NavigationStage = Exclude<WorkspaceStage, "ready-for-synthesis">;

function stageStatus(stage: WorkspaceStage, item: NavigationStage): string {
  if (stage === "ready-for-synthesis") {
    if (item === "draft" || item === "preflight") return "已完成";
    if (item === "running") return "主分析完成";
    return "未开始";
  }
  const order: WorkspaceStage[] = ["draft", "preflight", "running", "report"];
  const current = order.indexOf(stage);
  const target = order.indexOf(item);
  if (target < current) return "已完成";
  if (target === current) return "当前阶段";
  return "未开始";
}

function isStageCurrent(stage: WorkspaceStage, item: NavigationStage): boolean {
  return stage === item || (stage === "ready-for-synthesis" && item === "running");
}

export function NeigongWorkspace({ renderReport }: NeigongWorkspaceProps = {}) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createWorkspaceState);
  const competitorSequence = useRef(1);
  const parseTokens = useRef<Record<string, number>>({});
  const disposed = useRef(false);
  const [analysisSession] = useState(() => createAsyncSessionGuard<string>());
  const [queueOrchestrator] = useState(() => createQueueOrchestrator(analysisSession));
  const [synthesisOrchestrator] = useState(() => createSynthesisOrchestrator());

  const hasParsedData = hasParsedSession(state);
  const hasRunningTasks = Boolean(state.queue?.pending.length || state.queue?.running.length);
  const hasUnsavedSession = hasParsedData || hasRunningTasks;

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      parseTokens.current = {};
      queueOrchestrator.cancel();
      synthesisOrchestrator.cancel();
    };
  }, [queueOrchestrator, synthesisOrchestrator]);

  useEffect(() => {
    if (!hasUnsavedSession) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedSession]);

  const runSynthesis = useCallback(async () => {
    if (state.stage !== "ready-for-synthesis" || !state.queue || state.synthesisStatus === "running") return;
    const queue = state.queue;
    const runKey = Object.values(queue.tasks)
      .map((task) => `${task.id}:${task.status}:${task.attempts}`)
      .sort()
      .join("|");
    analysisSession.cancel();
    dispatch({ type: "synthesis-start" });
    await synthesisOrchestrator.run({
      runKey,
      isDisposed: () => disposed.current,
      execute: async (signal) => {
        const excludedProducts = new Set(
          Object.values(queue.tasks)
            .filter((task) => task.status === "excluded")
            .map((task) => task.productId),
        );
        const packs = state.drafts
          .map((draft) => state.preflight[draft.product.productId]?.parsed)
          .filter((pack): pack is ParsedProductPack => pack !== undefined && !excludedProducts.has(pack.product.productId));
        const facts = buildSynthesisFacts({ packs, results: queue.results });
        const synthesisTask = buildSynthesisTask(facts);
        const synthesisResult = await executeAnalysisTask(synthesisTask, signal);
        if (synthesisResult.task !== "synthesis") throw new Error("SYNTHESIS_RESULT_MISMATCH");
        return buildReportData({
          packs,
          results: queue.results,
          synthesis: synthesisResult.output,
        });
      },
      onSuccess: (report) => dispatch({ type: "report-ready", report }),
      onFailure: (failure) => dispatch({ type: "report-failed", failure }),
    });
  }, [analysisSession, state.drafts, state.preflight, state.queue, state.stage, state.synthesisStatus, synthesisOrchestrator]);

  useEffect(() => {
    if (state.stage !== "ready-for-synthesis" || state.synthesisStatus !== "idle") return;
    void runSynthesis();
  }, [runSynthesis, state.stage, state.synthesisStatus]);

  const updateDraft = async (draft: ProductPackDraft) => {
    const productId = draft.product.productId;
    const token = (parseTokens.current[productId] ?? 0) + 1;
    parseTokens.current[productId] = token;
    dispatch({ type: "update-draft", draft });

    try {
      const parsed = await parseProductPack(draft);
      if (disposed.current || parseTokens.current[productId] !== token) return;
      let preparedScreenshot: PreparedReviewScreenshot | undefined;
      if (draft.screenshotFile && parsed.screenshot?.status === "ready") {
        try {
          preparedScreenshot = await prepareReviewScreenshot(draft.screenshotFile);
        } catch {
          if (disposed.current || parseTokens.current[productId] !== token) return;
          parsed.screenshot.status = "missing";
          parsed.warnings.push({
            code: "SCREENSHOT_TRANSPORT_LIMIT",
            message: "评价页截图无法压缩到传输限制内，截图分析将降级为 unavailable。",
          });
        }
      }
      if (disposed.current || parseTokens.current[productId] !== token) return;
      dispatch({ type: "parse-complete", productId, parsed, preparedScreenshot });
    } catch (error) {
      if (disposed.current || parseTokens.current[productId] !== token) return;
      dispatch({
        type: "parse-failed",
        productId,
        message: error instanceof Error ? error.message : "无法解析产品数据包。",
      });
    }
  };

  const addCompetitor = () => {
    const competitorCount = state.drafts.filter((draft) => draft.product.role === "competitor").length;
    if (competitorCount >= MAX_COMPETITORS) return;
    const sequence = competitorSequence.current;
    competitorSequence.current += 1;
    const productId = `competitor-${sequence}`;
    dispatch({
      type: "add-competitor",
      draft: {
        product: { productId, role: "competitor", name: `竞品 ${sequence}` },
      },
    });
  };

  const removeCompetitor = (productId: string) => {
    delete parseTokens.current[productId];
    dispatch({ type: "remove-competitor", productId });
  };

  const resumeQueue = async (
    tasks: AnalysisTask[],
    run: AsyncSessionRun<string>,
  ) => {
    const isCurrent = () => (
      !disposed.current && analysisSession.isCurrent(run)
    );
    const queue = await runTaskQueue(
      tasks,
      (task) => executeAnalysisTask(task, run.signal),
      {
        retries: 1,
        signal: run.signal,
        onProgress: (nextQueue) => {
          if (isCurrent()) dispatch({ type: "queue-progress", queue: nextQueue });
        },
      },
    );
    if (isCurrent()) dispatch({ type: "queue-finish", queue });
  };

  const startAnalysis = async () => {
    const packs = state.drafts.map((draft) => state.preflight[draft.product.productId]?.parsed);
    const ready = state.drafts.every((draft, index) => (
      Boolean(draft.product.name.trim())
      && Boolean(packs[index])
      && state.preflight[draft.product.productId]?.mappingConfirmed
      && packs[index]!.errors.length === 0
    ));
    if (!ready) return;

    synthesisOrchestrator.cancel();
    queueOrchestrator.clearExclusions();
    const run = analysisSession.begin("primary");
    const isCurrent = () => (
      !disposed.current && analysisSession.isCurrent(run)
    );
    dispatch({ type: "analysis-start" });
    try {
      const tasks = await buildPrimaryAnalysisTasks(packs as ParsedProductPack[], {
        preparedScreenshots: state.preparedScreenshots,
        signal: run.signal,
      });
      if (!isCurrent()) return;
      dispatch({ type: "analysis-tasks", tasks });
      await resumeQueue(tasks, run);
    } catch (error) {
      if (!isCurrent() || isAbortError(error)) return;
      dispatch({
        type: "analysis-failed",
        message: error instanceof Error ? error.message : "无法建立分析任务。",
      });
    }
  };

  const retryTask = async (taskId: string) => {
    if (!state.queue || state.queue.pending.length || state.queue.running.length) return;
    synthesisOrchestrator.cancel();
    await queueOrchestrator.retry({
      taskId,
      queue: state.queue,
      tasks: state.analysisTasks,
      execute: executeAnalysisTask,
      isDisposed: () => disposed.current,
      onProgress: (queue) => dispatch({ type: "queue-progress", queue }),
      onFinish: (queue) => dispatch({ type: "queue-finish", queue }),
    });
  };

  const retryFailedTasks = async () => {
    if (!state.queue || state.queue.failed.length < 2 || state.queue.pending.length || state.queue.running.length) return;
    synthesisOrchestrator.cancel();
    await queueOrchestrator.retryFailed({
      queue: state.queue,
      tasks: state.analysisTasks,
      execute: executeAnalysisTask,
      isDisposed: () => disposed.current,
      onProgress: (queue) => dispatch({ type: "queue-progress", queue }),
      onFinish: (queue) => dispatch({ type: "queue-finish", queue }),
    });
  };

  const excludeCompetitor = (productId: string) => {
    if (!state.queue) return;
    const product = state.drafts.find((draft) => draft.product.productId === productId)?.product;
    if (!product || product.role !== "competitor") return;
    synthesisOrchestrator.cancel();
    queueOrchestrator.exclude({
      productId,
      queue: state.queue,
      onFinish: (queue) => dispatch({ type: "queue-finish", queue }),
    });
  };

  const preflightProducts: PreflightProduct[] = state.drafts.map((draft) => ({
    draft,
    parsed: state.preflight[draft.product.productId]?.parsed,
    parsing: state.preflight[draft.product.productId]?.parsing ?? false,
    parseError: state.preflight[draft.product.productId]?.parseError,
    mappingConfirmed: state.preflight[draft.product.productId]?.mappingConfirmed ?? false,
  }));
  const competitorCount = state.drafts.filter((draft) => draft.product.role === "competitor").length;

  return (
    <section className="neigong-workspace" aria-label="内功问诊四阶段工作区">
      <header className="neigong-workspace-head">
        <div>
          <span>NEIGONG REVIEW DIAGNOSIS</span>
          <h1>内功问诊</h1>
          <p>产品数据只保存在当前页面内存。刷新后，当前解析结果和分析进度将丢失。</p>
        </div>
      </header>

      <ol className="neigong-stage-nav" aria-label="分析阶段">
        {([
          ["draft", "01", "上传资料"],
          ["preflight", "02", "完整性检查"],
          ["running", "03", "分批分析"],
          ["report", "04", "问诊看板"],
        ] as const).map(([key, number, label]) => (
          <li
            key={key}
            className={isStageCurrent(state.stage, key) ? "neigong-stage-current" : ""}
            aria-current={isStageCurrent(state.stage, key) ? "step" : undefined}
          >
            <span>{number}</span>
            <strong>{label}</strong>
            <small>{stageStatus(state.stage, key)}</small>
          </li>
        ))}
      </ol>

      {state.notice ? <p className="neigong-inline-error" role="alert">{state.notice}</p> : null}

      {state.stage === "draft" ? (
        <section className="neigong-stage-panel" aria-labelledby="neigong-upload-title">
          <div className="neigong-stage-heading">
            <div>
              <span>阶段 01</span>
              <h2 id="neigong-upload-title">上传资料</h2>
            </div>
            <p>每个产品固定三个槽位；文件选择后立即解析 Excel，但不会调用模型。</p>
          </div>

          <div className="neigong-product-grid">
            {state.drafts.map((draft) => (
              <ProductPackCard
                key={draft.product.productId}
                productId={draft.product.productId}
                role={draft.product.role}
                name={draft.product.name}
                files={draft}
                onChange={(next) => void updateDraft(next)}
                onRemove={draft.product.role === "competitor"
                  ? () => removeCompetitor(draft.product.productId)
                  : undefined}
              />
            ))}
          </div>

          <div className="neigong-stage-actions">
            {competitorCount < MAX_COMPETITORS ? (
              <button className="neigong-secondary-button" type="button" onClick={addCompetitor}>
                添加竞品
              </button>
            ) : <span className="neigong-limit-note">已达到最多 3 个竞品</span>}
            <button className="neigong-primary-button" type="button" onClick={() => dispatch({ type: "stage", stage: "preflight" })}>
              进入完整性检查
            </button>
          </div>
        </section>
      ) : null}

      {state.stage === "preflight" ? (
        <PreflightPanel
          products={preflightProducts}
          onMappingChange={(productId, confirmed) => dispatch({ type: "mapping", productId, confirmed })}
          onBack={() => dispatch({ type: "stage", stage: "draft" })}
          onStart={() => void startAnalysis()}
        />
      ) : null}

      {state.stage === "running" ? (
        <AnalysisProgress
          queue={state.queue}
          products={state.drafts.map((draft) => draft.product)}
          onRetry={(taskId) => void retryTask(taskId)}
          onRetryAll={() => void retryFailedTasks()}
          onExclude={excludeCompetitor}
        />
      ) : null}

      {state.stage === "ready-for-synthesis" ? (
        <section className="neigong-stage-panel" aria-labelledby="neigong-synthesis-ready-title">
          <div className="neigong-stage-heading">
            <div>
              <span>阶段 03 已完成</span>
              <h2 id="neigong-synthesis-ready-title">主分析完成，等待综合报告</h2>
            </div>
            <p>成功批次结果已保存在当前会话内存中。</p>
          </div>
          <div className="neigong-report-placeholder">
            <strong>{state.synthesisStatus === "failed" ? "综合报告生成失败" : "正在执行综合报告"}</strong>
            <p>{state.synthesisStatus === "failed" ? "主分析成功结果已保留；重试只会重新执行综合报告，不会重跑 Excel 主任务。" : "代码正在重算聚合、执行 synthesis，并校验 finding → evidence 证据链。"}</p>
            {state.synthesisStatus === "failed" ? (
              <button className="neigong-primary-button" type="button" onClick={() => void runSynthesis()}>
                重试综合报告
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {state.stage === "report" && state.report ? (
        <section className="neigong-stage-panel" aria-labelledby="neigong-report-title">
          <div className="neigong-stage-heading">
            <div>
              <span>阶段 04</span>
              <h2 id="neigong-report-title">问诊看板</h2>
            </div>
            <p>真实 ReportData 已生成。</p>
          </div>
          {renderReport ? renderReport(state.report) : (
            <ReportDashboard report={state.report} />
          )}
        </section>
      ) : null}
    </section>
  );
}
