// Node contract tests execute source TypeScript directly; runtime imports need extensions.
import {
  createAsyncSessionGuard,
  type AsyncSessionGuard,
  type AsyncSessionRun,
} from "../async-session.ts";
// Node contract tests execute source TypeScript directly; runtime imports need extensions.
import {
  runTaskQueue,
  taskQueueReducer,
  type AnalysisTask,
  type QueueState,
} from "./task-runner.ts";
import type { ModelTaskResult } from "./types";

type QueueObserver = (queue: QueueState) => void;

export interface RetryQueueOptions {
  taskId: string;
  queue: QueueState;
  tasks: AnalysisTask[];
  execute(task: AnalysisTask, signal: AbortSignal): Promise<ModelTaskResult>;
  onProgress: QueueObserver;
  onFinish: QueueObserver;
  isDisposed?: () => boolean;
}

export interface ExcludeProductOptions {
  productId: string;
  queue: QueueState;
  onFinish: QueueObserver;
}

export type RetryFailedQueueOptions = Omit<RetryQueueOptions, "taskId">;

export interface QueueOrchestrator {
  retry(options: RetryQueueOptions): Promise<QueueState | undefined>;
  retryFailed(options: RetryFailedQueueOptions): Promise<QueueState | undefined>;
  exclude(options: ExcludeProductOptions): QueueState;
  clearExclusions(): void;
  cancel(): void;
}

export function createQueueOrchestrator(
  guard: AsyncSessionGuard<string> = createAsyncSessionGuard<string>(),
): QueueOrchestrator {
  const excludedProducts = new Set<string>();
  let activeRetry: { run: AsyncSessionRun<string>; baseQueue: QueueState } | undefined;

  const isCurrent = (run: AsyncSessionRun<string>, isDisposed?: () => boolean) => (
    !isDisposed?.() && guard.isCurrent(run) && activeRetry?.run === run
  );

  const runRetry = async (
    options: RetryFailedQueueOptions,
    retried: QueueState,
    runKey: string,
  ): Promise<QueueState | undefined> => {
    if (activeRetry || retried.pending.length === 0) return undefined;
    const run = guard.begin(runKey);
    activeRetry = { run, baseQueue: options.queue };
    if (isCurrent(run, options.isDisposed)) options.onProgress(retried);

    const queue = await runTaskQueue(
      options.tasks,
      (item) => options.execute(item, run.signal),
      {
        retries: 1,
        signal: run.signal,
        initialState: retried,
        onProgress: (nextQueue) => {
          if (isCurrent(run, options.isDisposed)) options.onProgress(nextQueue);
        },
      },
    );
    if (!isCurrent(run, options.isDisposed)) return undefined;
    activeRetry = undefined;
    options.onFinish(queue);
    return queue;
  };

  return {
    async retry(options) {
      const task = options.queue.tasks[options.taskId];
      if (!task || task.status !== "failed" || excludedProducts.has(task.productId)) return undefined;
      const retried = taskQueueReducer(options.queue, { type: "retry", taskId: options.taskId });
      return runRetry(options, retried, `retry:${options.taskId}`);
    },

    async retryFailed(options) {
      const hasEligibleFailure = options.queue.failed.some((taskId) => {
        const task = options.queue.tasks[taskId];
        return task?.status === "failed" && !excludedProducts.has(task.productId);
      });
      if (!hasEligibleFailure) return undefined;
      let retried = taskQueueReducer(options.queue, { type: "retry-failed" });
      for (const productId of excludedProducts) {
        retried = taskQueueReducer(retried, { type: "exclude-product", productId });
      }
      return runRetry(options, retried, "retry:failed");
    },

    exclude(options) {
      const sourceQueue = activeRetry?.baseQueue ?? options.queue;
      excludedProducts.add(options.productId);
      guard.cancel();
      activeRetry = undefined;
      const queue = taskQueueReducer(sourceQueue, {
        type: "exclude-product",
        productId: options.productId,
      });
      options.onFinish(queue);
      return queue;
    },

    clearExclusions() {
      excludedProducts.clear();
    },

    cancel() {
      guard.cancel();
      activeRetry = undefined;
    },
  };
}
