export type ProductRole = "self" | "competitor";
export type ReviewSort = "default" | "recent";
export type SourceKind = "default_reviews" | "recent_reviews" | "questions" | "review_tags";
export type CompletenessStatus = "complete" | "provisional" | "insufficient" | "missing";
export type FindingStatus = "available" | "unavailable" | "historical";
export type FindingProblemCode =
  | "F01_DISPLAY_SHARE_GAP"
  | "F02_DIMENSION_COVERAGE_GAP"
  | "F03_TOPIC_CONCENTRATION";
export type ModelTask = "review-taxonomy" | "question-topic" | "top20-dimensions" | "screenshot-metadata" | "synthesis";

export interface ReviewRow {
  rowId: string;
  sourceId: string;
  sourceRow: number;
  productId: string;
  sort: ReviewSort;
  rank: number;
  date: string;
  sku: string;
  initialText: string;
  followupText: string;
  normalizedText: string;
  typeId?: string;
  typeEvidence?: { source: "initial" | "followup"; quote: string };
}

export interface QuestionRow {
  rowId: string;
  sourceId: string;
  sourceRow: number;
  productId: string;
  rank: number;
  questionText: string;
  answer: string;
  date: string;
  normalizedText: string;
  topicId?: string;
  topicEvidence?: string;
}

export interface SourceSummary {
  sourceId: string;
  productId: string;
  kind: SourceKind;
  rowsRead: number;
  validRows: number;
  usedRows: number;
  excludedRows: number;
  excludedOverLimit: number;
  status: CompletenessStatus;
  note: string;
}

export interface SourceMapping {
  sourceId: string;
  fileName: string;
  sheetName: string;
  columns: Array<{ field: string; header: string }>;
}

export interface ParsedProductPack {
  product: { productId: string; role: ProductRole; name: string };
  reviews: ReviewRow[];
  questions: QuestionRow[];
  sources: SourceSummary[];
  sourceMappings: SourceMapping[];
  screenshot?: { file: File; sourceId: string; status: "ready" | "missing" };
  excludedRows: Array<{ rowId: string; sourceId: string; reason: string }>;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

export interface Product {
  productId: string;
  role: ProductRole;
  name: string;
}

export interface ReviewTag {
  sourceId: string;
  productId: string;
  name: string;
  count: number;
}

export interface TaxonomyAggregate {
  productId: string;
  typeId: string;
  defaultCount: number;
  defaultShare: number;
  recentCount: number;
  recentShare: number;
  difference: number;
  evidenceId: string;
}

export interface TaxonomyDefinition {
  id: string;
  name: string;
  definition: string;
}

export interface TopicAggregate {
  topicId: string;
  productId: string;
  count: number;
  share: number;
  representativeQuestionIds: string[];
  evidenceId: string;
}

export interface TopicDefinition extends TaxonomyDefinition {
  includeWhen: string;
  excludeWhen: string;
}

export interface DimensionEvidence {
  dimension: "persona" | "scene" | "painPoint" | "detail" | "effect" | "delight";
  present: boolean;
  evidence: string;
}

export interface Top20Assessment {
  reviewId: string;
  rank: number;
  dimensions: DimensionEvidence[];
  score: number;
}

export interface DimensionAggregate {
  productId: string;
  dimension: "persona" | "scene" | "painPoint" | "detail" | "effect" | "delight";
  hitCount: number;
  totalCount: number;
  coverage: number;
  evidenceId: string;
}

export interface Finding {
  findingId: string;
  id?: string;
  status: FindingStatus;
  hasProblem: boolean;
  problemCode: FindingProblemCode | null;
  title: string;
  detail: string;
  text?: string;
  evidenceIds: string[];
}

export interface Action {
  actionId: string;
  priority: "P0" | "P1" | "P2";
  action: string;
  reason: string;
  findingId?: string;
  evidenceId?: string;
  findingIds?: string[];
  evidenceIds?: string[];
}

export interface AnalysisReadiness {
  findingId: string;
  status: "available" | "unavailable";
  reason: string;
}

export interface CompletenessEvidence {
  evidenceId: string;
  productId: string;
  kind: `${ProductRole}_${SourceKind}`;
  sourceIds: string[];
  expectedRows: number;
  validRows: number;
  usedRows: number;
  excludedOverLimit: number;
  status: CompletenessStatus;
  blocking: boolean;
}

export interface ReportMeta {
  generatedAt: string;
  analysisReadiness: AnalysisReadiness[];
  completeness: CompletenessEvidence[];
  validation?: {
    valid: boolean;
    errors: Array<{ code: string; message: string }>;
  };
}

export interface ReportAggregates {
  taxonomy: TaxonomyAggregate[];
  topics: TopicAggregate[];
  dimensions: DimensionAggregate[];
  duplicateRows: Array<{ sourceId: string; rowIds: string[] }>;
  crossSortOverlap: Array<{ productId: string; rowIds: string[] }>;
}

export interface LegacyReportData {
  enabled: boolean;
  status?: "disabled";
  notice?: string;
  rowDetailStatus?: string;
  reviews?: unknown[];
  taxonomy?: unknown[];
  top20?: unknown[];
  aggregates?: Record<string, unknown>;
  note?: string;
  data?: Record<string, unknown>;
}

export interface ReportData {
  meta: ReportMeta;
  products: Product[];
  sources: SourceSummary[];
  taxonomy: TaxonomyDefinition[];
  topics: TopicDefinition[];
  reviews: ReviewRow[];
  reviewTags: ReviewTag[];
  questions: QuestionRow[];
  top20: Top20Assessment[];
  aggregates: ReportAggregates;
  findings: Finding[];
  actions: Action[];
  legacy: LegacyReportData;
  excludedRows: Array<{ rowId: string; sourceId: string; reason: string }>;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

export interface ModelTaskRequest {
  task: ModelTask;
  requestId: string;
  productId: string;
  input: Record<string, unknown>;
}

export interface ReviewTaxonomyOutput {
  labels: Array<{
    rowId: string;
    typeId: "t1" | "t2" | "t3" | "t4" | "t5" | "t6" | "t7" | "t8";
    evidenceSource: "initial" | "followup";
    evidenceQuote: string;
  }>;
}

export interface QuestionTopicOutput {
  labels: Array<{
    rowId: string;
    topicId: "q1" | "q2" | "q3" | "q4" | "q5" | "q6" | "q7" | "q8";
    topicEvidence: string;
  }>;
}

export interface Top20DimensionsOutput {
  rows: Array<{
    rowId: string;
    dimensions: Record<DimensionEvidence["dimension"], boolean>;
    evidence: Record<DimensionEvidence["dimension"], string>;
    score: number;
    note: string;
  }>;
}

export interface ScreenshotMetadataOutput {
  productName: string | null;
  reviewTotal: string | null;
  questionTotal: string | null;
  tags: Array<{ tag: string; count: number | null }>;
  completeness: "complete" | "partial" | "missing";
}

export interface SynthesisOutput {
  findings: Array<{
    id: "F01" | "F02" | "F03";
    status: "available" | "unavailable";
    evidenceIds: string[];
  }>;
}

export interface ModelTaskOutputMap {
  "review-taxonomy": ReviewTaxonomyOutput;
  "question-topic": QuestionTopicOutput;
  "top20-dimensions": Top20DimensionsOutput;
  "screenshot-metadata": ScreenshotMetadataOutput;
  synthesis: SynthesisOutput;
}

export type ModelTaskOutput<T extends ModelTask = ModelTask> = ModelTaskOutputMap[T];

export type ModelTaskApiSuccess<T extends ModelTask = ModelTask> = T extends ModelTask ? {
  ok: true;
  task: T;
  requestId: string;
  result: ModelTaskOutputMap[T];
} : never;

export type ModelTaskResult<T extends ModelTask = ModelTask> = T extends ModelTask ? {
  task: T;
  requestId: string;
  output: ModelTaskOutputMap[T];
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
} : never;

export function toModelTaskResult(success: ModelTaskApiSuccess): ModelTaskResult {
  switch (success.task) {
    case "review-taxonomy":
      return { task: success.task, requestId: success.requestId, output: success.result, errors: [], warnings: [] };
    case "question-topic":
      return { task: success.task, requestId: success.requestId, output: success.result, errors: [], warnings: [] };
    case "top20-dimensions":
      return { task: success.task, requestId: success.requestId, output: success.result, errors: [], warnings: [] };
    case "screenshot-metadata":
      return { task: success.task, requestId: success.requestId, output: success.result, errors: [], warnings: [] };
    case "synthesis":
      return { task: success.task, requestId: success.requestId, output: success.result, errors: [], warnings: [] };
  }
}

export interface SynthesisCompletenessFact {
  evidenceId: string;
  productId: string;
  kind: SourceKind;
  expectedRows: number;
  validRows: number;
  usedRows: number;
  status: CompletenessStatus;
}

export interface SynthesisReadinessFact {
  findingId: "F01" | "F02" | "F03";
  status: "available" | "unavailable";
  reason: string;
  evidenceIds: string[];
}

export interface SynthesisFacts {
  products: Product[];
  completeness: SynthesisCompletenessFact[];
  readiness: SynthesisReadinessFact[];
  aggregates: ReportAggregates;
}
