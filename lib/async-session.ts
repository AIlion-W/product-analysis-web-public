export interface AsyncSessionRun<Scope = unknown> {
  generation: number;
  scope: Scope;
  signal: AbortSignal;
}

export interface AsyncSessionGuard<Scope = unknown> {
  begin(scope: Scope): AsyncSessionRun<Scope>;
  cancel(): void;
  isCurrent(run: AsyncSessionRun<Scope>): boolean;
}

export function createAsyncSessionGuard<Scope = unknown>(): AsyncSessionGuard<Scope> {
  let generation = 0;
  let current:
    | { run: AsyncSessionRun<Scope>; controller: AbortController }
    | undefined;

  return {
    begin(scope) {
      current?.controller.abort();
      const controller = new AbortController();
      const run = {
        generation: generation += 1,
        scope,
        signal: controller.signal,
      };
      current = { run, controller };
      return run;
    },
    cancel() {
      generation += 1;
      current?.controller.abort();
      current = undefined;
    },
    isCurrent(run) {
      return current?.run === run && !run.signal.aborted;
    },
  };
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError")
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
  }
  throw new DOMException("The operation was aborted.", "AbortError");
}
