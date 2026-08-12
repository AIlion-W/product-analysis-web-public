"use client";

import {
  TASK_QUEUE_CONCURRENCY,
  type QueueState,
  type QueueTaskState,
} from "@/lib/neigong/task-runner";
import type { ProductRole } from "@/lib/neigong/types";

export type ProgressProduct = {
  productId: string;
  role: ProductRole;
  name: string;
};

export type AnalysisProgressProps = {
  queue?: QueueState;
  products: ProgressProduct[];
  onRetry(taskId: string): void;
  onRetryAll(): void;
  onExclude(productId: string): void;
};

const TASK_LABELS = {
  "review-taxonomy": "评价分类",
  "question-topic": "问大家主题",
  "top20-dimensions": "前 20 六维体检",
  "screenshot-metadata": "截图元数据",
  synthesis: "综合结论",
} as const;

const STATUS_LABELS = {
  pending: "等待中",
  running: "分析中",
  succeeded: "已完成",
  failed: "失败",
  excluded: "已排除",
} as const;

function TaskRow({
  task,
  product,
  actionsEnabled,
  onRetry,
  onExclude,
}: {
  task: QueueTaskState;
  product?: ProgressProduct;
  actionsEnabled: boolean;
  onRetry(taskId: string): void;
  onExclude(productId: string): void;
}) {
  const canExclude = task.status === "failed" && product?.role === "competitor";
  return (
    <li className={`neigong-task-row neigong-task-${task.status}`}>
      <div className="neigong-task-copy">
        <span className="neigong-task-status">{STATUS_LABELS[task.status]}</span>
        <strong>{product?.name || task.productId} · {TASK_LABELS[task.task]}</strong>
        <small>批次 {task.id} · 已尝试 {task.attempts} 次</small>
        {task.error ? (
          <p>
            <code>{task.error.code}</code>：{task.error.message}
          </p>
        ) : null}
      </div>
      {task.status === "failed" && actionsEnabled ? (
        <div className="neigong-task-actions">
          <button className="neigong-secondary-button" type="button" onClick={() => onRetry(task.id)}>
            重试此批次
          </button>
          {canExclude ? (
            <button className="neigong-text-button neigong-danger-button" type="button" onClick={() => onExclude(task.productId)}>
              排除该竞品并继续
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function AnalysisProgress({ queue, products, onRetry, onRetryAll, onExclude }: AnalysisProgressProps) {
  const productById = new Map(products.map((product) => [product.productId, product]));
  const tasks = queue ? Object.values(queue.tasks) : [];
  const completed = queue?.completed.length ?? 0;
  const total = tasks.length;
  const actionsEnabled = Boolean(queue && queue.pending.length === 0 && queue.running.length === 0);

  return (
    <section className="neigong-stage-panel" aria-labelledby="neigong-progress-title">
      <div className="neigong-stage-heading">
        <div>
          <span>阶段 03</span>
          <h2 id="neigong-progress-title">分批分析</h2>
        </div>
        <p>最多 {TASK_QUEUE_CONCURRENCY} 个批次并行执行</p>
      </div>

      <div className="neigong-progress-summary" aria-live="polite" aria-atomic="true">
        <strong>{total ? `${completed} / ${total}` : "正在建立任务…"}</strong>
        <span>
          已完成批次 {completed}／{total} · 失败 {queue?.failed.length ?? 0} · 已排除 {queue?.excluded.length ?? 0}
        </span>
      </div>

      {actionsEnabled && (queue?.failed.length ?? 0) > 1 ? (
        <div className="neigong-stage-actions neigong-task-actions">
          <button className="neigong-primary-button" type="button" onClick={onRetryAll}>
            并行重试全部 {queue!.failed.length} 个失败批次
          </button>
        </div>
      ) : null}

      {tasks.length ? (
        <ul className="neigong-task-list" role={queue?.failed.length ? "alert" : undefined}>
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              product={productById.get(task.productId)}
              actionsEnabled={actionsEnabled}
              onRetry={onRetry}
              onExclude={onExclude}
            />
          ))}
        </ul>
      ) : (
        <p className="neigong-empty-state">正在解析任务批次，尚未调用模型。</p>
      )}
    </section>
  );
}
