// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { createAsyncSessionGuard, isAbortError, type AsyncSessionRun } from "../async-session.ts";

export type SynthesisFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export type SynthesisRunOptions<Result> = {
  runKey: string;
  execute(signal: AbortSignal): Promise<Result>;
  onSuccess(result: Result): void;
  onFailure(error: SynthesisFailure): void;
  isDisposed?: () => boolean;
};

export interface SynthesisOrchestrator {
  run<Result>(options: SynthesisRunOptions<Result>): Promise<Result | undefined>;
  cancel(): void;
}

function normalizedFailure(error: unknown): SynthesisFailure {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    code: typeof candidate.code === "string" ? candidate.code : "SYNTHESIS_FAILED",
    message: error instanceof Error ? error.message : "综合报告生成失败。",
    retryable: candidate.retryable === true,
  };
}

export function createSynthesisOrchestrator(): SynthesisOrchestrator {
  const guard = createAsyncSessionGuard<string>();
  let active: AsyncSessionRun<string> | undefined;
  let sequence = 0;

  const current = (run: AsyncSessionRun<string>, isDisposed?: () => boolean) => (
    !isDisposed?.() && active === run && guard.isCurrent(run)
  );

  return {
    async run<Result>(options: SynthesisRunOptions<Result>) {
      if (active && current(active, options.isDisposed)) return undefined;
      sequence += 1;
      const run = guard.begin(`${options.runKey}:${sequence}`);
      active = run;
      let retryUsed = false;

      while (current(run, options.isDisposed)) {
        try {
          const result = await options.execute(run.signal);
          if (!current(run, options.isDisposed)) return undefined;
          active = undefined;
          options.onSuccess(result);
          return result;
        } catch (error) {
          if (!current(run, options.isDisposed) || run.signal.aborted || isAbortError(error)) return undefined;
          const failure = normalizedFailure(error);
          if (failure.retryable && !retryUsed) {
            retryUsed = true;
            continue;
          }
          active = undefined;
          options.onFailure(failure);
          return undefined;
        }
      }
      return undefined;
    },

    cancel() {
      guard.cancel();
      active = undefined;
    },
  };
}
