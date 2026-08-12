import type {
  Action,
  CompletenessEvidence,
  CompletenessStatus,
  Finding,
  ModelTaskResult,
  ParsedProductPack,
  Product,
  QuestionRow,
  ReportAggregates,
  ReportData,
  ReviewRow,
  ReviewTag,
  SourceKind,
  SourceSummary,
  SynthesisFacts,
  SynthesisOutput,
  Top20Assessment,
} from "./types";
// Node executes this source TypeScript directly in contract tests.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { DIMENSION_LABELS, DIMENSIONS, TAXONOMY, TOPICS } from "./catalog.ts";
import {
  buildDedupAggregate,
  buildQuestionStats,
  buildSixDimensionStats,
  buildTypeStats,
  deriveFindingProblem,
  getAnalysisReadiness,
  PROBLEM_THRESHOLDS,
  selectF01TaxonomyAggregate,
  validateEvidenceGraph,
  type EvidenceGraphError,
  type FindingProblemState,
// @ts-expect-error TS5097 is a no-emit bundler restriction.
} from "./rules.ts";

export interface BuildReportCoreInput {
  packs: ParsedProductPack[];
  results: Record<string, ModelTaskResult>;
}

export interface BuildReportInput extends BuildReportCoreInput {
  synthesis: SynthesisOutput;
  generatedAt?: string;
}

export class ReportValidationError extends Error {
  readonly code = "REPORT_VALIDATION_FAILED";
  readonly validationErrors: EvidenceGraphError[];

  constructor(errors: EvidenceGraphError[]) {
    super(`${errors[0]?.code ?? "REPORT_VALIDATION_FAILED"}：${errors[0]?.message ?? "报告证据链校验失败。"}`);
    this.name = "ReportValidationError";
    this.validationErrors = errors;
  }
}

type ReportFinding = Finding & { id: string; text: string };
type ReportAction = Action & { findingIds: string[]; evidenceIds: string[] };

interface CoreData {
  products: Product[];
  sources: SourceSummary[];
  completeness: CompletenessEvidence[];
  reviews: ReviewRow[];
  questions: QuestionRow[];
  reviewTags: ReviewTag[];
  top20: Top20Assessment[];
  aggregates: ReportAggregates;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

function statusForUsedRows(usedRows: number): CompletenessStatus {
  if (usedRows === 0) return "missing";
  if (usedRows < 90) return "insufficient";
  if (usedRows < 100) return "provisional";
  return "complete";
}

function resultEntries(results: Record<string, ModelTaskResult>): ModelTaskResult[] {
  return Object.values(results).sort((left, right) => left.requestId.localeCompare(right.requestId));
}

function resultsForPacks(
  packs: ParsedProductPack[],
  results: Record<string, ModelTaskResult>,
): Record<string, ModelTaskResult> {
  const productIds = packs.map((pack) => pack.product.productId);
  return Object.fromEntries(Object.entries(results).filter(([, result]) => productIds.some((productId) => {
    const prefix = `${result.task}:${productId}`;
    return result.requestId === prefix || result.requestId.startsWith(`${prefix}:`);
  })));
}

function normalizeSources(packs: ParsedProductPack[]): SourceSummary[] {
  return packs.flatMap((pack) => pack.sources.map((source) => {
    const usedRows = source.kind === "questions"
      ? pack.questions.filter((row) => row.sourceId === source.sourceId).length
      : source.kind === "default_reviews" || source.kind === "recent_reviews"
        ? pack.reviews.filter((row) => row.sourceId === source.sourceId).length
        : 0;
    const excluded = pack.excludedRows.filter((row) => row.sourceId === source.sourceId);
    const excludedOverLimit = excluded.filter((row) => row.reason === "OVER_LIMIT").length;
    return {
      ...source,
      rowsRead: usedRows + excluded.length,
      validRows: usedRows + excludedOverLimit,
      usedRows,
      excludedRows: excluded.length,
      excludedOverLimit,
      status: statusForUsedRows(usedRows),
    };
  }));
}

function buildCompleteness(products: Product[], sources: SourceSummary[]): CompletenessEvidence[] {
  const productById = new Map(products.map((product) => [product.productId, product]));
  return sources.map((source) => {
    const product = productById.get(source.productId);
    if (!product) throw new Error(`UNKNOWN_SOURCE_PRODUCT:${source.productId}`);
    const kind = `${product.role}_${source.kind}` as CompletenessEvidence["kind"];
    return {
      evidenceId: `DATA-${source.productId}-${kind}`,
      productId: source.productId,
      kind,
      sourceIds: [source.sourceId],
      expectedRows: 100,
      validRows: source.validRows,
      usedRows: source.usedRows,
      excludedOverLimit: source.excludedOverLimit,
      status: source.status,
      blocking: source.usedRows < 90,
    };
  });
}

function mergeRows(
  packs: ParsedProductPack[],
  results: Record<string, ModelTaskResult>,
  errors: CoreData["errors"],
): { reviews: ReviewRow[]; questions: QuestionRow[]; top20: Top20Assessment[] } {
  const reviews = packs.flatMap((pack) => pack.reviews.map((row) => ({ ...row })));
  const questions = packs.flatMap((pack) => pack.questions.map((row) => ({ ...row })));
  const reviewById = new Map(reviews.map((row) => [row.rowId, row]));
  const questionById = new Map(questions.map((row) => [row.rowId, row]));
  const labelledReviews = new Set<string>();
  const labelledQuestions = new Set<string>();
  const top20: Top20Assessment[] = [];
  const top20EligibleProducts = new Set(packs
    .filter((pack) => pack.reviews.filter((row) => row.sort === "default").length >= 20)
    .map((pack) => pack.product.productId));

  for (const result of resultEntries(results)) {
    if (result.task === "review-taxonomy") {
      for (const label of result.output.labels) {
        const row = reviewById.get(label.rowId);
        if (!row || labelledReviews.has(label.rowId)) {
          errors.push({ code: "MODEL_ROW_REJECTED", message: `评价标注引用未知或重复 rowId：${label.rowId}。` });
          continue;
        }
        labelledReviews.add(label.rowId);
        row.typeId = label.typeId;
        row.typeEvidence = { source: label.evidenceSource, quote: label.evidenceQuote };
      }
    } else if (result.task === "question-topic") {
      for (const label of result.output.labels) {
        const row = questionById.get(label.rowId);
        if (!row || labelledQuestions.has(label.rowId)) {
          errors.push({ code: "MODEL_ROW_REJECTED", message: `问题标注引用未知或重复 rowId：${label.rowId}。` });
          continue;
        }
        labelledQuestions.add(label.rowId);
        row.topicId = label.topicId;
        row.topicEvidence = label.topicEvidence;
      }
    } else if (result.task === "top20-dimensions") {
      for (const assessment of result.output.rows) {
        const row = reviewById.get(assessment.rowId);
        if (!row) {
          errors.push({ code: "MODEL_ROW_REJECTED", message: `六维标注引用未知 rowId：${assessment.rowId}。` });
          continue;
        }
        if (!top20EligibleProducts.has(row.productId)) continue;
        top20.push({
          reviewId: assessment.rowId,
          rank: row.rank,
          dimensions: DIMENSIONS.map((dimension) => ({
            dimension,
            present: assessment.dimensions[dimension],
            evidence: assessment.evidence[dimension],
          })),
          score: assessment.score,
        });
      }
    }
  }
  top20.sort((left, right) => {
    const leftProduct = reviewById.get(left.reviewId)?.productId ?? "";
    const rightProduct = reviewById.get(right.reviewId)?.productId ?? "";
    return leftProduct.localeCompare(rightProduct) || left.rank - right.rank || left.reviewId.localeCompare(right.reviewId);
  });
  return { reviews, questions, top20 };
}

function mergeReviewTags(
  packs: ParsedProductPack[],
  results: Record<string, ModelTaskResult>,
  warnings: CoreData["warnings"],
): ReviewTag[] {
  const productIds = new Set(packs.map((pack) => pack.product.productId));
  const sourceByProduct = new Map(packs.map((pack) => [
    pack.product.productId,
    pack.screenshot?.sourceId ?? `${pack.product.productId}:review_tags`,
  ]));
  const tags = new Map<string, ReviewTag>();
  for (const result of resultEntries(results)) {
    if (result.task !== "screenshot-metadata") continue;
    const prefix = "screenshot-metadata:";
    const productId = result.requestId.startsWith(prefix) ? result.requestId.slice(prefix.length) : "";
    if (!productIds.has(productId)) continue;
    if (result.output.completeness !== "complete") {
      warnings.push({
        code: `SCREENSHOT_METADATA_${result.output.completeness.toUpperCase()}`,
        message: `${productId} 的截图元数据不完整：${result.output.completeness}。`,
      });
    }
    for (const tag of result.output.tags) {
      if (tag.count === null) {
        warnings.push({ code: "SCREENSHOT_TAG_COUNT_UNAVAILABLE", message: `${productId} 的截图标签「${tag.tag}」缺少可核验数量。` });
        continue;
      }
      const sourceId = sourceByProduct.get(productId)!;
      const key = `${sourceId}\u0000${tag.tag}`;
      const existing = tags.get(key);
      tags.set(key, {
        sourceId,
        productId,
        name: tag.tag,
        count: (existing?.count ?? 0) + tag.count,
      });
    }
  }
  return [...tags.values()].sort((left, right) => (
    left.productId.localeCompare(right.productId) || left.name.localeCompare(right.name)
  ));
}

function buildAggregates(reviews: ReviewRow[], questions: QuestionRow[], top20: Top20Assessment[]): ReportAggregates {
  const defaultRows = reviews.filter((row) => row.sort === "default");
  const recentRows = reviews.filter((row) => row.sort === "recent");
  const dedup = buildDedupAggregate(defaultRows, recentRows);
  return {
    taxonomy: buildTypeStats(reviews),
    topics: buildQuestionStats(questions),
    dimensions: buildSixDimensionStats(reviews, top20),
    duplicateRows: dedup.duplicateRows,
    crossSortOverlap: dedup.crossLists.map(({ productId, pairs }) => ({
      productId,
      rowIds: pairs.flatMap(({ leftRowId, rightRowId }) => [leftRowId, rightRowId]),
    })),
  };
}

function assembleCore(input: BuildReportCoreInput): CoreData {
  const relevantResults = resultsForPacks(input.packs, input.results);
  const products = input.packs.map((pack) => ({ ...pack.product }));
  const errors = [
    ...input.packs.flatMap((pack) => pack.errors.map((error) => ({ ...error }))),
    ...resultEntries(relevantResults).flatMap((result) => result.errors.map((error) => ({ ...error }))),
  ];
  const warnings = [
    ...input.packs.flatMap((pack) => pack.warnings.map((warning) => ({ ...warning }))),
    ...resultEntries(relevantResults).flatMap((result) => result.warnings.map((warning) => ({ ...warning }))),
  ];
  const sources = normalizeSources(input.packs);
  const completeness = buildCompleteness(products, sources);
  const { reviews, questions, top20 } = mergeRows(input.packs, relevantResults, errors);
  const reviewTags = mergeReviewTags(input.packs, relevantResults, warnings);
  const aggregates = buildAggregates(reviews, questions, top20);
  return { products, sources, completeness, reviews, questions, reviewTags, top20, aggregates, errors, warnings };
}

function sourceKindFromCompleteness(entry: CompletenessEvidence): SourceKind {
  return entry.kind.replace(/^(?:self|competitor)_/u, "") as SourceKind;
}

function dataEvidence(
  completeness: CompletenessEvidence[],
  findingId: "F01" | "F02" | "F03",
): string[] {
  const own = completeness.filter((entry) => entry.kind.startsWith("self_"));
  if (findingId === "F03") {
    return completeness
      .filter((entry) => (
        entry.kind === "self_questions"
        || (entry.kind === "competitor_questions" && entry.usedRows < 90)
      ))
      .map((entry) => entry.evidenceId);
  }
  const acceptedKinds = findingId === "F01"
    ? new Set(["self_default_reviews", "self_recent_reviews"])
    : new Set(["self_default_reviews"]);
  const evidence = own.filter((entry) => acceptedKinds.has(entry.kind)).map((entry) => entry.evidenceId);
  return evidence.length ? evidence : own.slice(0, 1).map((entry) => entry.evidenceId);
}

function buildReadiness(core: CoreData, packs: ParsedProductPack[]): SynthesisFacts["readiness"] {
  const readiness = getAnalysisReadiness(packs);
  const products = new Map(core.products.map((product) => [product.productId, product]));
  const questionsByProduct = new Map<string, number>();
  for (const question of core.questions) {
    questionsByProduct.set(question.productId, (questionsByProduct.get(question.productId) ?? 0) + 1);
  }
  return readiness.map((entry) => {
    let evidenceIds: string[];
    if (entry.status === "unavailable") {
      evidenceIds = dataEvidence(core.completeness, entry.findingId as "F01" | "F02" | "F03");
    } else if (entry.findingId === "F01") {
      evidenceIds = core.aggregates.taxonomy
        .filter((aggregate) => products.get(aggregate.productId)?.role === "self")
        .map((aggregate) => aggregate.evidenceId);
    } else if (entry.findingId === "F02") {
      evidenceIds = core.aggregates.dimensions
        .filter((aggregate) => products.get(aggregate.productId)?.role === "self")
        .map((aggregate) => aggregate.evidenceId);
    } else {
      evidenceIds = core.aggregates.topics
        .filter((aggregate) => (questionsByProduct.get(aggregate.productId) ?? 0) >= 90)
        .map((aggregate) => aggregate.evidenceId);
    }
    return {
      findingId: entry.findingId as "F01" | "F02" | "F03",
      status: entry.status,
      reason: entry.reason,
      evidenceIds,
    };
  });
}

export function buildSynthesisFacts(input: BuildReportCoreInput): SynthesisFacts {
  const core = assembleCore(input);
  return {
    products: core.products,
    completeness: core.completeness.map((entry) => ({
      evidenceId: entry.evidenceId,
      productId: entry.productId,
      kind: sourceKindFromCompleteness(entry),
      expectedRows: entry.expectedRows,
      validRows: entry.validRows,
      usedRows: entry.usedRows,
      status: entry.status,
    })),
    readiness: buildReadiness(core, input.packs),
    aggregates: core.aggregates,
  };
}

function allowedFamilies(facts: SynthesisFacts) {
  return {
    data: new Set(facts.completeness.map((entry) => entry.evidenceId)),
    type: new Set(facts.aggregates.taxonomy.map((entry) => entry.evidenceId)),
    dimension: new Set(facts.aggregates.dimensions.map((entry) => entry.evidenceId)),
    question: new Set(facts.aggregates.topics.map((entry) => entry.evidenceId)),
  };
}

function findingEvidenceIsValid(
  findingId: "F01" | "F02" | "F03",
  status: "available" | "unavailable",
  evidenceIds: string[],
  allowed: ReturnType<typeof allowedFamilies>,
  facts: SynthesisFacts,
): boolean {
  if (evidenceIds.length === 0 || new Set(evidenceIds).size !== evidenceIds.length) return false;
  if (status === "unavailable") return evidenceIds.every((evidenceId) => allowed.data.has(evidenceId));
  const allKnown = evidenceIds.every((evidenceId) => (
    allowed.data.has(evidenceId)
    || allowed.type.has(evidenceId)
    || allowed.dimension.has(evidenceId)
    || allowed.question.has(evidenceId)
  ));
  const required = findingId === "F01" ? allowed.type : findingId === "F02" ? allowed.dimension : allowed.question;
  if (!allKnown || !evidenceIds.some((evidenceId) => required.has(evidenceId))) return false;
  if (findingId !== "F03") return true;
  const ownProductIds = new Set(facts.products.filter((product) => product.role === "self").map((product) => product.productId));
  const ownQuestionEvidence = new Set(facts.aggregates.topics
    .filter((aggregate) => ownProductIds.has(aggregate.productId))
    .map((aggregate) => aggregate.evidenceId));
  return evidenceIds.some((evidenceId) => ownQuestionEvidence.has(evidenceId));
}

const PROBLEM_TITLES = {
  F01: "评价展示倾向问题",
  F02: "默认评价六维覆盖信号",
  F03: "问大家高频决策主题",
} as const;

const UNAVAILABLE_TITLES = {
  F01: "评价展示数据不足",
  F02: "六维诊断数据不足",
  F03: "问大家诊断数据不足",
} as const;

const NO_PROBLEM_TITLES = {
  F01: "未发现可证明的评价展示倾向问题",
  F02: "未发现可证明的六维内容问题",
  F03: "未发现可证明的问大家决策问题",
} as const;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

interface DeterministicDiagnosis extends FindingProblemState {
  text: string;
}

function deterministicDiagnosis(
  findingId: "F01" | "F02" | "F03",
  status: "available" | "unavailable",
  facts: SynthesisFacts,
  completeness: CompletenessEvidence[],
): DeterministicDiagnosis {
  const problemState = deriveFindingProblem(findingId, status, facts.products, facts.aggregates);
  const ownProductIds = new Set(facts.products.filter((product) => product.role === "self").map((product) => product.productId));
  const ownCompleteness = completeness.filter((entry) => ownProductIds.has(entry.productId));
  const usedRows = (kind: CompletenessEvidence["kind"]) => ownCompleteness.find((entry) => entry.kind === kind)?.usedRows ?? 0;

  if (findingId === "F01") {
    if (status === "unavailable") {
      return { text: `默认排序 ${usedRows("self_default_reviews")} 条、时间排序 ${usedRows("self_recent_reviews")} 条，未同时达到各 90 条门槛，无法形成正式展示倾向诊断。`, ...problemState };
    }
    const aggregate = selectF01TaxonomyAggregate(facts.products, facts.aggregates.taxonomy)!;
    const name = TAXONOMY.find((entry) => entry.id === aggregate.typeId)?.name ?? aggregate.typeId;
    const absoluteDifference = Math.abs(aggregate.difference);
    if (!problemState.hasProblem) {
      return { text: `我方「${name}」的默认与时间排序占比差绝对值为 ${percent(absoluteDifference)}，低于 ${percent(PROBLEM_THRESHOLDS.f01AbsoluteShareDifference)} 异常阈值，当前数据未形成可证明的问题。`, ...problemState };
    }
    return { text: `我方「${name}」在默认排序为 ${aggregate.defaultCount} 条（${percent(aggregate.defaultShare)}），时间排序为 ${aggregate.recentCount} 条（${percent(aggregate.recentShare)}），占比差绝对值为 ${percent(absoluteDifference)}，达到 ${percent(PROBLEM_THRESHOLDS.f01AbsoluteShareDifference)} 异常阈值，形成评价展示倾向问题。`, ...problemState };
  }

  if (findingId === "F02") {
    const count = usedRows("self_default_reviews");
    if (status === "unavailable") {
      return { text: count < 20
        ? `默认排序只有 ${count} 条，未达到 20 条明细保留门槛，不形成六维覆盖明细。`
        : `已保留默认前 20 条逐条六维明细，但默认排序总样本只有 ${count} 条，未达到 90 条正式诊断门槛。`, ...problemState };
    }
    const aggregate = facts.aggregates.dimensions
      .filter((entry) => ownProductIds.has(entry.productId))
      .sort((left, right) => left.coverage - right.coverage || left.dimension.localeCompare(right.dimension))[0];
    if (!problemState.hasProblem) {
      return { text: `默认前 20 条中，六维最低覆盖率为 ${percent(aggregate.coverage)}，不低于 ${percent(PROBLEM_THRESHOLDS.f02MinimumCoverage)} 观察线，当前数据未形成需跟进的覆盖信号。`, ...problemState };
    }
    return { text: `默认前 20 条中，「${DIMENSION_LABELS[aggregate.dimension]}」命中 ${aggregate.hitCount} 条，覆盖率 ${percent(aggregate.coverage)}，低于 ${percent(PROBLEM_THRESHOLDS.f02MinimumCoverage)} 观察线，说明样本中该类信息较少，形成评价内容覆盖信号；这不等同于产品缺陷。`, ...problemState };
  }

  if (status === "unavailable") {
    return { text: `我方问大家只有 ${usedRows("self_questions")} 条，未达到 90 条正式诊断门槛。`, ...problemState };
  }
  const eligibleProductIds = new Set(facts.readiness.find((entry) => entry.findingId === "F03")?.evidenceIds
    .map((evidenceId) => facts.aggregates.topics.find((aggregate) => aggregate.evidenceId === evidenceId)?.productId)
    .filter((productId): productId is string => Boolean(productId)) ?? []);
  const summaries = facts.products
    .filter((product) => eligibleProductIds.has(product.productId))
    .map((product) => {
      const aggregate = facts.aggregates.topics
        .filter((entry) => entry.productId === product.productId)
        .sort((left, right) => right.share - left.share || left.topicId.localeCompare(right.topicId))[0];
      const name = TOPICS.find((entry) => entry.id === aggregate.topicId)?.name ?? aggregate.topicId;
      return `${product.role === "self" ? "我方" : product.name}最集中的主题是「${name}」：${aggregate.count} 条（${percent(aggregate.share)}）`;
    });
  const competitors = facts.products.filter((product) => product.role === "competitor");
  const eligibleCompetitors = competitors.filter((product) => eligibleProductIds.has(product.productId));
  const competitorNote = competitors.length === 0
    ? "未上传竞品，本分区只做我方诊断。"
    : eligibleCompetitors.length === 0
      ? "竞品问大家均未达到 90 条，本分区只做我方诊断。"
      : `已纳入 ${eligibleCompetitors.length} 个问大家不少于 90 条的竞品。`;
  const ownAggregate = facts.aggregates.topics
    .filter((entry) => ownProductIds.has(entry.productId))
    .sort((left, right) => right.share - left.share || left.topicId.localeCompare(right.topicId))[0];
  if (!problemState.hasProblem) {
    return { text: `我方问大家最高主题占比为 ${percent(ownAggregate.share)}，低于 ${percent(PROBLEM_THRESHOLDS.f03TopicConcentration)} 集中观察线，当前未形成需跟进的高频主题信号。${competitorNote}`, ...problemState };
  }
  return { text: `${summaries.join("；")}。我方最高主题占比达到 ${percent(PROBLEM_THRESHOLDS.f03TopicConcentration)} 集中观察线，说明该主题是高频决策关注点；该数据不直接证明信息缺口。${competitorNote}`, ...problemState };
}

function findingTitle(
  findingId: "F01" | "F02" | "F03",
  status: "available" | "unavailable",
  hasProblem: boolean,
): string {
  if (status === "unavailable") return UNAVAILABLE_TITLES[findingId];
  return hasProblem ? PROBLEM_TITLES[findingId] : NO_PROBLEM_TITLES[findingId];
}

function gateFindings(
  synthesis: SynthesisOutput,
  facts: SynthesisFacts,
  completeness: CompletenessEvidence[],
  errors: CoreData["errors"],
): ReportFinding[] {
  const allowed = allowedFamilies(facts);
  const readinessById = new Map(facts.readiness.map((entry) => [entry.findingId, entry]));
  const modelById = new Map(synthesis.findings.map((finding) => [finding.id, finding]));
  return (["F01", "F02", "F03"] as const).map((findingId) => {
    const readiness = readinessById.get(findingId)!;
    const model = modelById.get(findingId);
    const valid = Boolean(
      model
      && model.status === readiness.status
      && model.evidenceIds.every((evidenceId) => readiness.evidenceIds.includes(evidenceId))
      && findingEvidenceIsValid(findingId, model.status, model.evidenceIds, allowed, facts),
    );
    let status: "available" | "unavailable";
    let evidenceIds: string[];
    if (valid && model) {
      status = model.status;
      evidenceIds = [...readiness.evidenceIds];
    } else {
      status = "unavailable";
      evidenceIds = dataEvidence(completeness, findingId);
      errors.push({ code: "SYNTHESIS_EVIDENCE_REJECTED", message: `${findingId} 的综合证据或状态无效，已降级。` });
    }
    const diagnosis = deterministicDiagnosis(findingId, status, facts, completeness);
    const title = findingTitle(findingId, status, diagnosis.hasProblem);
    return {
      findingId,
      id: findingId,
      status,
      hasProblem: diagnosis.hasProblem,
      problemCode: diagnosis.problemCode,
      title,
      detail: diagnosis.text,
      text: diagnosis.text,
      evidenceIds,
    };
  });
}

const PROBLEM_ACTION_TEMPLATES = {
  F01: { action: "校正评价展示内容结构", reason: "按评价展示证据校正内容结构" },
  F02: { action: "优化邀评问题与六维内容引导", reason: "按六维覆盖信号优化邀评问题与内容引导" },
  F03: { action: "围绕高频问题补充问答与详情页证据", reason: "按问大家高频主题补充决策信息证据" },
} as const;

const DATA_ACTION_TEMPLATES = {
  F01: { action: "补齐默认与时间排序评价数据", reason: "补齐默认与时间排序评价至诊断门槛" },
  F02: { action: "补齐默认排序评价数据", reason: "补齐默认排序评价至诊断门槛" },
  F03: { action: "补齐问大家数据", reason: "补齐问大家至诊断门槛" },
} as const;

function buildActions(
  findings: ReportFinding[],
  facts: SynthesisFacts,
): ReportAction[] {
  const competitors = facts.products.filter((product) => product.role === "competitor");
  const eligibleCompetitorIds = new Set(facts.completeness
    .filter((entry) => entry.kind === "questions" && entry.usedRows >= 90)
    .map((entry) => entry.productId));
  const actions: ReportAction[] = [];
  for (const finding of findings) {
    if (finding.status === "available" && !finding.hasProblem) continue;
    const findingId = finding.findingId as keyof typeof PROBLEM_ACTION_TEMPLATES;
    const evidenceIds = [...finding.evidenceIds];
    let template: { action: string; reason: string } = finding.status === "unavailable"
      ? DATA_ACTION_TEMPLATES[findingId]
      : PROBLEM_ACTION_TEMPLATES[findingId];
    if (
      findingId === "F03"
      && finding.status === "unavailable"
      && competitors.some((product) => !eligibleCompetitorIds.has(product.productId))
    ) {
      template = { action: "补齐我方问大家与可比竞品数据", reason: "补齐我方问大家与可比竞品至诊断门槛" };
    }
    const auditPrefix = `${findingId}｜${evidenceIds.join("、")}`;
    actions.push({
      actionId: `A${String(actions.length + 1).padStart(2, "0")}`,
      priority: finding.status === "unavailable" ? "P0" : "P1",
      action: template.action,
      reason: `${auditPrefix}：${template.reason}`,
      findingIds: [findingId],
      evidenceIds,
    });
  }
  return actions;
}

export function buildReportData(input: BuildReportInput): ReportData & {
  findings: ReportFinding[];
  actions: ReportAction[];
  meta: ReportData["meta"] & { validation: ReturnType<typeof validateEvidenceGraph> };
} {
  const core = assembleCore(input);
  const facts: SynthesisFacts = {
    products: core.products,
    completeness: core.completeness.map((entry) => ({
      evidenceId: entry.evidenceId,
      productId: entry.productId,
      kind: sourceKindFromCompleteness(entry),
      expectedRows: entry.expectedRows,
      validRows: entry.validRows,
      usedRows: entry.usedRows,
      status: entry.status,
    })),
    readiness: buildReadiness(core, input.packs),
    aggregates: core.aggregates,
  };
  const findings = gateFindings(
    input.synthesis,
    facts,
    core.completeness,
    core.errors,
  );
  const actions = buildActions(findings, facts);
  const report = {
    meta: {
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      analysisReadiness: facts.readiness.map(({ findingId, status, reason }) => ({ findingId, status, reason })),
      completeness: core.completeness,
    },
    products: core.products,
    sources: core.sources,
    taxonomy: [...TAXONOMY],
    topics: [...TOPICS],
    reviews: core.reviews,
    reviewTags: core.reviewTags,
    questions: core.questions,
    top20: core.top20,
    aggregates: core.aggregates,
    findings,
    actions,
    legacy: {
      enabled: false,
      status: "disabled" as const,
      notice: "",
      rowDetailStatus: "",
      reviews: [],
      taxonomy: [],
      top20: [],
      aggregates: {},
    },
    excludedRows: input.packs.flatMap((pack) => pack.excludedRows.map((row) => ({ ...row }))),
    errors: core.errors,
    warnings: core.warnings,
  } satisfies ReportData;
  const validation = validateEvidenceGraph(report);
  if (!validation.valid) throw new ReportValidationError(validation.errors);
  return { ...report, meta: { ...report.meta, validation } };
}
