import type { ProductPackFiles } from "./excel-parser";
import type { PreparedReviewScreenshot } from "./image";
import type { AnalysisTask, QueueState } from "./task-runner";
import type { ParsedProductPack, ReportData } from "./types";
import type { SynthesisFailure } from "./synthesis-orchestrator";

export const MAX_COMPETITORS = 3;

export type WorkspaceStage = "draft" | "preflight" | "running" | "ready-for-synthesis" | "report";
export type ProductPackDraft = ProductPackFiles;

export type PreflightState = {
  parsed?: ParsedProductPack;
  parsing: boolean;
  parseError?: { code: string; message: string };
  mappingConfirmed: boolean;
};

export type WorkspaceState = {
  stage: WorkspaceStage;
  drafts: ProductPackDraft[];
  preflight: Record<string, PreflightState>;
  preparedScreenshots: Record<string, PreparedReviewScreenshot>;
  analysisTasks: AnalysisTask[];
  queue?: QueueState;
  report: ReportData | null;
  synthesisStatus: "idle" | "running" | "failed";
  synthesisFailure?: SynthesisFailure;
  notice?: string;
};

export type WorkspaceAction =
  | { type: "update-draft"; draft: ProductPackDraft }
  | { type: "add-competitor"; draft: ProductPackDraft }
  | { type: "remove-competitor"; productId: string }
  | {
      type: "parse-complete";
      productId: string;
      parsed: ParsedProductPack;
      preparedScreenshot?: PreparedReviewScreenshot;
    }
  | { type: "parse-failed"; productId: string; message: string }
  | { type: "mapping"; productId: string; confirmed: boolean }
  | { type: "stage"; stage: "draft" | "preflight" }
  | { type: "analysis-start" }
  | { type: "analysis-tasks"; tasks: AnalysisTask[] }
  | { type: "queue-progress"; queue: QueueState }
  | { type: "queue-finish"; queue: QueueState }
  | { type: "synthesis-start" }
  | { type: "report-ready"; report: ReportData }
  | { type: "report-failed"; failure: SynthesisFailure }
  | { type: "analysis-failed"; message: string };

function selfDraft(): ProductPackDraft {
  return {
    product: { productId: "self", role: "self", name: "我方产品" },
  };
}

export function createWorkspaceState(): WorkspaceState {
  return {
    stage: "draft",
    drafts: [selfDraft()],
    preflight: {},
    preparedScreenshots: {},
    analysisTasks: [],
    report: null,
    synthesisStatus: "idle",
  };
}

function withoutKey<Value>(record: Record<string, Value>, key: string): Record<string, Value> {
  const next = { ...record };
  delete next[key];
  return next;
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "update-draft": {
      const productId = action.draft.product.productId;
      return {
        ...state,
        drafts: state.drafts.map((draft) => draft.product.productId === productId ? action.draft : draft),
        preflight: {
          ...state.preflight,
          [productId]: { parsing: true, mappingConfirmed: false },
        },
        preparedScreenshots: withoutKey(state.preparedScreenshots, productId),
        report: null,
        notice: undefined,
      };
    }
    case "add-competitor":
      if (state.drafts.filter((draft) => draft.product.role === "competitor").length >= MAX_COMPETITORS) return state;
      return { ...state, drafts: [...state.drafts, action.draft], report: null };
    case "remove-competitor": {
      const target = state.drafts.find((draft) => draft.product.productId === action.productId);
      if (target?.product.role !== "competitor") return state;
      return {
        ...state,
        drafts: state.drafts.filter((draft) => draft.product.productId !== action.productId),
        preflight: withoutKey(state.preflight, action.productId),
        preparedScreenshots: withoutKey(state.preparedScreenshots, action.productId),
        report: null,
      };
    }
    case "parse-complete":
      if (!state.drafts.some((draft) => draft.product.productId === action.productId)) return state;
      return {
        ...state,
        preflight: {
          ...state.preflight,
          [action.productId]: {
            parsed: action.parsed,
            parsing: false,
            mappingConfirmed: false,
          },
        },
        preparedScreenshots: action.preparedScreenshot
          ? { ...state.preparedScreenshots, [action.productId]: action.preparedScreenshot }
          : withoutKey(state.preparedScreenshots, action.productId),
      };
    case "parse-failed":
      return {
        ...state,
        preflight: {
          ...state.preflight,
          [action.productId]: {
            parsing: false,
            mappingConfirmed: false,
            parseError: { code: "PARSER_FAILED", message: action.message },
          },
        },
      };
    case "mapping": {
      const current = state.preflight[action.productId];
      if (!current?.parsed || current.parsing || current.parsed.errors.length) return state;
      return {
        ...state,
        preflight: {
          ...state.preflight,
          [action.productId]: { ...current, mappingConfirmed: action.confirmed },
        },
      };
    }
    case "stage":
      if (action.stage !== "draft" && action.stage !== "preflight") return state;
      return { ...state, stage: action.stage, notice: undefined };
    case "analysis-start":
      return {
        ...state,
        stage: "running",
        analysisTasks: [],
        queue: undefined,
        report: null,
        synthesisStatus: "idle",
        synthesisFailure: undefined,
        notice: undefined,
      };
    case "analysis-tasks":
      return { ...state, analysisTasks: action.tasks };
    case "queue-progress":
      return { ...state, stage: "running", queue: action.queue };
    case "queue-finish":
      return {
        ...state,
        stage: action.queue.failed.length ? "running" : "ready-for-synthesis",
        queue: action.queue,
        synthesisStatus: action.queue.failed.length ? state.synthesisStatus : "idle",
        synthesisFailure: action.queue.failed.length ? state.synthesisFailure : undefined,
      };
    case "synthesis-start":
      if (state.stage !== "ready-for-synthesis" || state.synthesisStatus === "running") return state;
      return { ...state, synthesisStatus: "running", synthesisFailure: undefined, notice: undefined };
    case "report-ready":
      return { ...state, stage: "report", report: action.report, synthesisStatus: "idle", synthesisFailure: undefined, notice: undefined };
    case "report-failed":
      return {
        ...state,
        stage: "ready-for-synthesis",
        report: null,
        synthesisStatus: "failed",
        synthesisFailure: action.failure,
        notice: `${action.failure.code}：${action.failure.message}`,
      };
    case "analysis-failed":
      return { ...state, stage: "preflight", notice: action.message };
  }
}

export function hasParsedSession(state: WorkspaceState): boolean {
  return Object.values(state.preflight).some((entry) => Boolean(entry.parsed));
}
