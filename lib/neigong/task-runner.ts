import type {
  ModelTask,
  ModelTaskRequest,
  ModelTaskResult,
  ParsedProductPack,
  QuestionRow,
  ReviewRow,
  SynthesisFacts,
} from "./types";
// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { isAbortError, throwIfAborted } from "../async-session.ts";
// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { MAX_SCREENSHOT_BYTES, prepareReviewScreenshot, type PreparedReviewScreenshot } from "./image.ts";

export interface AnalysisTask {
  id: string;
  productId: string;
  task: ModelTask;
  payload: ModelTaskRequest;
}

export type QueueTaskStatus = "pending" | "running" | "succeeded" | "failed" | "excluded";

export interface QueueTaskError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface QueueTaskState {
  id: string;
  productId: string;
  task: ModelTask;
  status: QueueTaskStatus;
  attempts: number;
  error?: QueueTaskError;
}

export interface QueueState {
  tasks: Record<string, QueueTaskState>;
  results: Record<string, ModelTaskResult>;
  pending: string[];
  running: string[];
  completed: string[];
  failed: string[];
  excluded: string[];
}

export type TaskQueueAction =
  | { type: "retry"; taskId: string }
  | { type: "retry-failed" }
  | { type: "exclude-product"; productId: string }
  | { type: "progress"; state: QueueState };

export interface PrimaryTaskBuildOptions {
  preparedScreenshots?: Record<string, PreparedReviewScreenshot>;
  onScreenshotError?: (productId: string, error: unknown) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface RunTaskQueueOptions {
  concurrency?: number;
  retries: 1;
  onProgress?: (state: QueueState) => void | Promise<void>;
  initialState?: QueueState;
  signal?: AbortSignal;
}

const WEBP_DATA_URL_PREFIX = "data:image/webp;base64,";
export const TASK_QUEUE_CONCURRENCY = 4;
export const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3);

function safelyObserve<Arguments extends unknown[]>(
  observer: ((...args: Arguments) => void | Promise<void>) | undefined,
  ...args: Arguments
): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(...args)).catch(() => {});
  } catch {
    // Observers cannot change the operation they report.
  }
}

function validatedPreparedScreenshot(value: PreparedReviewScreenshot): PreparedReviewScreenshot {
  if (
    !Number.isInteger(value.width)
    || value.width <= 0
    || !Number.isInteger(value.height)
    || value.height <= 0
    || !Number.isInteger(value.bytes)
    || value.bytes <= 0
    || value.bytes > MAX_SCREENSHOT_BYTES
  ) {
    throw new Error("SCREENSHOT_TRANSPORT_LIMIT");
  }
  if (
    typeof value.dataUrl !== "string"
    || value.dataUrl.length > WEBP_DATA_URL_PREFIX.length + MAX_BASE64_CHARS
  ) {
    throw new Error("SCREENSHOT_TRANSPORT_LIMIT");
  }
  const expectedBase64Chars = 4 * Math.ceil(value.bytes / 3);
  if (
    value.dataUrl.length !== WEBP_DATA_URL_PREFIX.length + expectedBase64Chars
    || !value.dataUrl.startsWith(WEBP_DATA_URL_PREFIX)
  ) {
    throw new Error("SCREENSHOT_TRANSPORT_LIMIT");
  }
  const encoded = value.dataUrl.slice(WEBP_DATA_URL_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("SCREENSHOT_TRANSPORT_LIMIT");
  try {
    const decoded = atob(encoded);
    if (
      decoded.length !== value.bytes
      || decoded.length < 12
      || decoded.slice(0, 4) !== "RIFF"
      || decoded.slice(8, 12) !== "WEBP"
    ) {
      throw new Error("SCREENSHOT_TRANSPORT_LIMIT");
    }
  } catch {
    throw new Error("SCREENSHOT_TRANSPORT_LIMIT");
  }
  return value;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function reviewInput(row: ReviewRow) {
  return { rowId: row.rowId, initialText: row.initialText, followupText: row.followupText };
}

function questionInput(row: QuestionRow) {
  return { rowId: row.rowId, questionText: row.questionText, answer: row.answer };
}

function makeTask(
  id: string,
  productId: string,
  task: ModelTask,
  input: Record<string, unknown>,
): AnalysisTask {
  return {
    id,
    productId,
    task,
    payload: { task, requestId: id, productId, input },
  };
}

export async function buildPrimaryAnalysisTasks(
  packs: ParsedProductPack[],
  options: PrimaryTaskBuildOptions = {},
): Promise<AnalysisTask[]> {
  const tasks: AnalysisTask[] = [];

  for (const pack of packs) {
    throwIfAborted(options.signal);
    const productId = pack.product.productId;
    for (const sort of ["default", "recent"] as const) {
      const batches = chunk(pack.reviews.filter((row) => row.sort === sort), 50);
      batches.forEach((rows, index) => {
        const id = `review-taxonomy:${productId}:${sort}:${index + 1}`;
        tasks.push(makeTask(id, productId, "review-taxonomy", { rows: rows.map(reviewInput) }));
      });
    }

    chunk(pack.questions, 50).forEach((rows, index) => {
      const id = `question-topic:${productId}:${index + 1}`;
      tasks.push(makeTask(id, productId, "question-topic", { rows: rows.map(questionInput) }));
    });

    const top20 = pack.reviews
      .filter((row) => row.sort === "default")
      .sort((left, right) => left.rank - right.rank || left.rowId.localeCompare(right.rowId))
      .slice(0, 20);
    if (top20.length === 20) {
      const id = `top20-dimensions:${productId}`;
      tasks.push(makeTask(id, productId, "top20-dimensions", { rows: top20.map(reviewInput) }));
    }

    if (pack.screenshot?.status === "ready") {
      try {
        const supplied = options.preparedScreenshots?.[productId];
        const prepared = supplied === undefined
          ? await prepareReviewScreenshot(pack.screenshot.file)
          : validatedPreparedScreenshot(supplied);
        throwIfAborted(options.signal);
        const id = `screenshot-metadata:${productId}`;
        tasks.push(makeTask(id, productId, "screenshot-metadata", { ...prepared }));
      } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) throw error;
        pack.screenshot.status = "missing";
        safelyObserve(options.onScreenshotError, productId, error);
      }
    }
  }

  return tasks;
}

export function buildSynthesisTask(facts: SynthesisFacts): AnalysisTask {
  return makeTask("synthesis", "all", "synthesis", { facts });
}

function statusLists(tasks: Record<string, QueueTaskState>) {
  const pending: string[] = [];
  const running: string[] = [];
  const completed: string[] = [];
  const failed: string[] = [];
  const excluded: string[] = [];
  for (const task of Object.values(tasks)) {
    if (task.status === "pending") pending.push(task.id);
    else if (task.status === "running") running.push(task.id);
    else if (task.status === "succeeded") completed.push(task.id);
    else if (task.status === "failed") failed.push(task.id);
    else excluded.push(task.id);
  }
  return { pending, running, completed, failed, excluded };
}

function snapshot(
  tasks: Record<string, QueueTaskState>,
  results: Record<string, ModelTaskResult>,
): QueueState {
  const copiedTasks = Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, {
    ...task,
    ...(task.error ? { error: { ...task.error } } : {}),
  }]));
  return { tasks: copiedTasks, results: { ...results }, ...statusLists(copiedTasks) };
}

function initializeState(tasks: AnalysisTask[], initialState?: QueueState): QueueState {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`DUPLICATE_TASK_ID:${task.id}`);
    seen.add(task.id);
  }

  const taskStates: Record<string, QueueTaskState> = {};
  const results: Record<string, ModelTaskResult> = {};
  for (const task of tasks) {
    const previous = initialState?.tasks[task.id];
    const previousResult = initialState?.results[task.id];
    const matchingResult = previousResult?.task === task.task
      && previousResult.requestId === task.payload.requestId;
    let status: QueueTaskStatus = "pending";
    if (previous?.status === "failed" || previous?.status === "excluded") {
      status = previous.status;
    } else if (previous?.status === "succeeded" && matchingResult) {
      status = "succeeded";
    }
    taskStates[task.id] = {
      id: task.id,
      productId: task.productId,
      task: task.task,
      status,
      attempts: Number.isInteger(previous?.attempts) && previous!.attempts >= 0 ? previous!.attempts : 0,
      ...((status === "failed" || status === "excluded") && previous?.error
        ? { error: { ...previous.error } }
        : {}),
    };
    if (matchingResult && (status === "succeeded" || status === "excluded")) {
      results[task.id] = previousResult;
    }
  }
  return snapshot(taskStates, results);
}

function serializedError(error: unknown): QueueTaskError {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    code: typeof candidate.code === "string" ? candidate.code : "TASK_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: candidate.retryable === true,
  };
}

export function taskQueueReducer(state: QueueState, action: TaskQueueAction): QueueState {
  if (action.type === "progress") return action.state;

  const tasks = Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, {
    ...task,
    ...(task.error ? { error: { ...task.error } } : {}),
  }]));
  if (action.type === "retry") {
    const task = tasks[action.taskId];
    if (task?.status === "failed") {
      tasks[action.taskId] = { ...task, status: "pending" };
      delete tasks[action.taskId].error;
    }
  } else if (action.type === "retry-failed") {
    for (const [id, task] of Object.entries(tasks)) {
      if (task.status === "failed") {
        tasks[id] = { ...task, status: "pending" };
        delete tasks[id].error;
      }
    }
  } else {
    for (const [id, task] of Object.entries(tasks)) {
      if (task.productId === action.productId && task.status !== "succeeded") {
        tasks[id] = { ...task, status: "excluded" };
      }
    }
  }
  return snapshot(tasks, state.results);
}

export async function runTaskQueue(
  tasks: AnalysisTask[],
  execute: (task: AnalysisTask) => Promise<ModelTaskResult>,
  options: RunTaskQueueOptions,
): Promise<QueueState> {
  const state = initializeState(tasks, options.initialState);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const runnable = state.pending.filter((id) => tasksById.has(id));
  let cursor = 0;
  let cancelled = options.signal?.aborted === true;
  const isCancelled = () => cancelled || options.signal?.aborted === true;

  const safeEmit = () => {
    if (isCancelled()) return;
    safelyObserve(options.onProgress, structuredClone(snapshot(state.tasks, state.results)));
  };
  safeEmit();

  const worker = async () => {
    while (!isCancelled() && cursor < runnable.length) {
      const taskId = runnable[cursor];
      cursor += 1;
      const task = tasksById.get(taskId);
      if (!task || state.tasks[taskId]?.status !== "pending") continue;
      let retriesUsed = 0;

      while (!isCancelled()) {
        const current = state.tasks[taskId];
        if (current.status === "succeeded" || current.status === "excluded") break;
        state.tasks[taskId] = {
          ...current,
          status: "running",
          attempts: current.attempts + 1,
        };
        delete state.tasks[taskId].error;
        safeEmit();
        if (isCancelled()) break;

        try {
          const result = await execute(task);
          if (isCancelled()) break;
          if (state.tasks[taskId].status !== "succeeded") {
            state.results[taskId] = result;
            state.tasks[taskId] = { ...state.tasks[taskId], status: "succeeded" };
          }
          safeEmit();
          break;
        } catch (error) {
          if (options.signal?.aborted || isAbortError(error)) {
            cancelled = true;
            break;
          }
          const normalized = serializedError(error);
          if (normalized.retryable && retriesUsed < Math.min(options.retries, 1)) {
            retriesUsed += 1;
            state.tasks[taskId] = { ...state.tasks[taskId], status: "pending", error: normalized };
            safeEmit();
            continue;
          }
          state.tasks[taskId] = { ...state.tasks[taskId], status: "failed", error: normalized };
          safeEmit();
          break;
        }
      }
    }
  };

  const requestedConcurrency = Number.isFinite(options.concurrency)
    ? Math.floor(options.concurrency!)
    : TASK_QUEUE_CONCURRENCY;
  const workerCount = Math.min(
    TASK_QUEUE_CONCURRENCY,
    Math.max(1, requestedConcurrency),
    runnable.length,
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (isCancelled()) {
    for (const [id, task] of Object.entries(state.tasks)) {
      if (task.status === "running") state.tasks[id] = { ...task, status: "pending" };
    }
  }
  return snapshot(state.tasks, state.results);
}
