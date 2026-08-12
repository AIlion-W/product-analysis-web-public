import type {
  AnalysisReadiness,
  CompletenessEvidence,
  DimensionAggregate,
  FindingProblemCode,
  ParsedProductPack,
  Product,
  QuestionRow,
  ReportAggregates,
  ReportData,
  ReviewRow,
  TaxonomyAggregate,
  Top20Assessment,
  TopicAggregate,
} from "./types";
// Node runs the source TypeScript directly in the rule tests, so the extension is required at runtime.
// @ts-expect-error TS5097 is a no-emit bundler restriction, not a runtime incompatibility.
import { TAXONOMY, TOPICS } from "./catalog.ts";

const TYPE_ID_LIST = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"] as const;
const TOPIC_ID_LIST = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"] as const;
const DIMENSION_LIST = ["persona", "scene", "painPoint", "detail", "effect", "delight"] as const;
const TYPE_IDS = new Set<string>(TYPE_ID_LIST);
const TOPIC_IDS = new Set<string>(TOPIC_ID_LIST);

type EvidenceId = `AGG-${string}`;

export interface ExactMatchPair {
  leftRowId: string;
  rightRowId: string;
}

export interface DedupAggregate {
  duplicateRows: Array<{ sourceId: string; rowIds: string[] }>;
  crossLists: Array<{
    productId: string;
    leftSourceIds: string[];
    rightSourceIds: string[];
    overlapRows: number;
    pairs: ExactMatchPair[];
  }>;
}

export type TypeStat = TaxonomyAggregate & { productId: string; evidenceId: EvidenceId };
export type QuestionStat = TopicAggregate & { evidenceId: EvidenceId };
export type SixDimensionStat = DimensionAggregate & { productId: string; evidenceId: EvidenceId };

export interface EvidenceGraphError {
  code:
    | "DUPLICATE_ROW_ID"
    | "UNKNOWN_MODEL_ROW"
    | "INVALID_TYPE_ID"
    | "INVALID_TOPIC_ID"
    | "UNKNOWN_EVIDENCE"
    | "UNKNOWN_FINDING"
    | "REASON_FINDING_MISMATCH"
    | "REASON_EVIDENCE_MISMATCH"
    | "TOO_MANY_ACTIONS"
    | "AGGREGATE_MISMATCH"
    | "MISSING_ACTION_FINDING"
    | "MISSING_ACTION_EVIDENCE"
    | "EVIDENCE_NOT_IN_FINDING"
    | "INELIGIBLE_COMPETITOR_EVIDENCE"
    | "DUPLICATE_MODEL_ROW"
    | "INVALID_DIMENSION"
    | "INVALID_TOP20_REVIEW"
    | "CONFLICTING_FINDING_ID"
    | "MISSING_FINDING_ID"
    | "DUPLICATE_FINDING_ID"
    | "CONFLICTING_ACTION_REFERENCE"
    | "INVALID_F03_EVIDENCE"
    | "CATALOG_MISMATCH"
    | "COMPLETENESS_MISMATCH"
    | "INVALID_FINDING_EVIDENCE"
    | "READINESS_MISMATCH"
    | "DIAGNOSIS_MISMATCH"
    | "DUPLICATE_FINDING_ACTION"
    | "MISSING_REQUIRED_SOURCE"
    | "SOURCE_ANCHOR_MISMATCH";
  message: string;
}

export interface EvidenceGraphValidation {
  valid: boolean;
  errors: EvidenceGraphError[];
}

type LooseAction = {
  actionId?: string;
  findingId?: string;
  findingIds?: string[];
  evidenceId?: string;
  evidenceIds?: string[];
  reason?: string;
};

type LooseFinding = {
  findingId?: string;
  id?: string;
  status?: string;
  hasProblem?: boolean;
  problemCode?: string | null;
  evidenceIds?: string[];
};

type LooseReport = Omit<Partial<ReportData>, "actions" | "findings" | "aggregates"> & {
  actions?: LooseAction[];
  findings?: LooseFinding[];
  aggregates?: Partial<ReportData["aggregates"]>;
  dimensions?: unknown[];
};

export const PROBLEM_THRESHOLDS = {
  f01AbsoluteShareDifference: 0.1,
  f02MinimumCoverage: 0.6,
  f03TopicConcentration: 0.3,
} as const;

export interface FindingProblemState {
  hasProblem: boolean;
  problemCode: FindingProblemCode | null;
}

export function selectF01TaxonomyAggregate(
  products: Product[],
  aggregates: ReportAggregates["taxonomy"],
): ReportAggregates["taxonomy"][number] | undefined {
  const ownProductIds = new Set(
    products.filter((product) => product.role === "self").map((product) => product.productId),
  );
  return aggregates
    .filter((entry) => ownProductIds.has(entry.productId))
    .sort((left, right) => (
      Math.abs(right.difference) - Math.abs(left.difference)
      || left.typeId.localeCompare(right.typeId)
      || left.productId.localeCompare(right.productId)
    ))[0];
}

export function deriveFindingProblem(
  findingId: "F01" | "F02" | "F03",
  status: "available" | "unavailable",
  products: Product[],
  aggregates: Pick<ReportAggregates, "taxonomy" | "topics" | "dimensions">,
): FindingProblemState {
  if (status === "unavailable") return { hasProblem: false, problemCode: null };
  const ownProductIds = new Set(products.filter((product) => product.role === "self").map((product) => product.productId));

  if (findingId === "F01") {
    const maximumDifference = Math.abs(selectF01TaxonomyAggregate(products, aggregates.taxonomy)?.difference ?? 0);
    return maximumDifference >= PROBLEM_THRESHOLDS.f01AbsoluteShareDifference
      ? { hasProblem: true, problemCode: "F01_DISPLAY_SHARE_GAP" }
      : { hasProblem: false, problemCode: null };
  }

  if (findingId === "F02") {
    const coverages = aggregates.dimensions
      .filter((entry) => ownProductIds.has(entry.productId))
      .map((entry) => entry.coverage);
    return coverages.length > 0 && Math.min(...coverages) < PROBLEM_THRESHOLDS.f02MinimumCoverage
      ? { hasProblem: true, problemCode: "F02_DIMENSION_COVERAGE_GAP" }
      : { hasProblem: false, problemCode: null };
  }

  const maximumShare = Math.max(0, ...aggregates.topics
    .filter((entry) => ownProductIds.has(entry.productId))
    .map((entry) => entry.share));
  return maximumShare >= PROBLEM_THRESHOLDS.f03TopicConcentration
    ? { hasProblem: true, problemCode: "F03_TOPIC_CONCENTRATION" }
    : { hasProblem: false, problemCode: null };
}

function normalizedKey(row: Pick<ReviewRow, "initialText" | "normalizedText">): string {
  // Re-normalize here so caller-provided model data cannot alter exact-dedup identity.
  return row.normalizedText.normalize("NFKC").replace(/\s/gu, "");
}

function sortedProductIds(rows: Array<Pick<ReviewRow | QuestionRow, "productId">>): string[] {
  return [...new Set(rows.map(({ productId }) => productId))].sort((left, right) => left.localeCompare(right));
}

function groupsBySource(rows: ReviewRow[]): Array<{ sourceId: string; rows: ReviewRow[] }> {
  const groups = new Map<string, ReviewRow[]>();
  for (const row of rows) groups.set(row.sourceId, [...(groups.get(row.sourceId) ?? []), row]);
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceId, sourceRows]) => ({ sourceId, rows: sourceRows }));
}

function duplicateGroups(rows: ReviewRow[]): Array<{ sourceId: string; rowIds: string[] }> {
  return groupsBySource(rows).flatMap(({ sourceId, rows: sourceRows }) => {
    const byText = new Map<string, string[]>();
    for (const row of sourceRows) {
      const key = normalizedKey(row);
      byText.set(key, [...(byText.get(key) ?? []), row.rowId]);
    }
    return [...byText.values()].filter((rowIds) => rowIds.length > 1).map((rowIds) => ({ sourceId, rowIds }));
  });
}

/** Pairs each left occurrence with at most one equal right occurrence in input order. */
export function matchExactMultiset(left: ReviewRow[], right: ReviewRow[]): ExactMatchPair[] {
  const queues = new Map<string, ReviewRow[]>();
  for (const row of right) {
    const key = normalizedKey(row);
    queues.set(key, [...(queues.get(key) ?? []), row]);
  }

  const pairs: ExactMatchPair[] = [];
  for (const row of left) {
    const match = queues.get(normalizedKey(row))?.shift();
    if (match) pairs.push({ leftRowId: row.rowId, rightRowId: match.rowId });
  }
  return pairs;
}

/** Builds all duplicate counts directly from review rows; no model summary is read. */
export function buildDedupAggregate(left: ReviewRow[], right: ReviewRow[]): DedupAggregate {
  const combined = [...left, ...right];
  const productIds = sortedProductIds(combined);
  return {
    duplicateRows: duplicateGroups(combined),
    crossLists: productIds.map((productId) => {
      const leftRows = left.filter((row) => row.productId === productId);
      const rightRows = right.filter((row) => row.productId === productId);
      const pairs = matchExactMultiset(leftRows, rightRows);
      return {
        productId,
        leftSourceIds: [...new Set(leftRows.map(({ sourceId }) => sourceId))],
        rightSourceIds: [...new Set(rightRows.map(({ sourceId }) => sourceId))],
        overlapRows: pairs.length,
        pairs,
      };
    }),
  };
}

function roundedShare(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Generates all t1–t8 buckets per product from individual review labels. */
export function buildTypeStats(reviews: ReviewRow[]): TypeStat[] {
  return sortedProductIds(reviews).flatMap((productId) => {
    const productReviews = reviews.filter((review) => review.productId === productId);
    const defaultRows = productReviews.filter((review) => review.sort === "default");
    const recentRows = productReviews.filter((review) => review.sort === "recent");
    return TYPE_ID_LIST.map((typeId) => {
      const defaultCount = defaultRows.filter((review) => review.typeId === typeId).length;
      const recentCount = recentRows.filter((review) => review.typeId === typeId).length;
      const defaultShare = roundedShare(defaultCount, defaultRows.length);
      const recentShare = roundedShare(recentCount, recentRows.length);
      return {
        productId,
        typeId,
        defaultCount,
        defaultShare,
        recentCount,
        recentShare,
        difference: recentShare - defaultShare,
        evidenceId: `AGG-TYPE-${productId}-${typeId}`,
      };
    });
  });
}

/** Generates all q1–q8 buckets per product from individual question labels. */
export function buildQuestionStats(questions: QuestionRow[]): QuestionStat[] {
  return sortedProductIds(questions).flatMap((productId) => {
    const productQuestions = questions.filter((question) => question.productId === productId);
    return TOPIC_ID_LIST.map((topicId) => {
      const matching = productQuestions.filter((question) => question.topicId === topicId);
      return {
        productId,
        topicId,
        count: matching.length,
        share: roundedShare(matching.length, productQuestions.length),
        representativeQuestionIds: [...matching]
          .sort((left, right) => left.rank - right.rank || left.rowId.localeCompare(right.rowId))
          .slice(0, 3)
          .map(({ rowId }) => rowId),
        evidenceId: `AGG-QUESTION-${productId}-${topicId}`,
      };
    });
  });
}

/** Recomputes each six-dimension hit rate from individual Top20 labels. */
export function buildSixDimensionStats(
  reviews: ReviewRow[],
  assessments: Top20Assessment[],
): SixDimensionStat[] {
  const reviewById = new Map(reviews.map((review) => [review.rowId, review]));
  const assessmentsByProduct = new Map<string, Top20Assessment[]>();
  for (const assessment of assessments) {
    const productId = reviewById.get(assessment.reviewId)?.productId;
    if (productId) assessmentsByProduct.set(productId, [...(assessmentsByProduct.get(productId) ?? []), assessment]);
  }

  const eligibleProductIds = sortedProductIds(reviews).filter((productId) => (
    reviews.filter((review) => review.productId === productId && review.sort === "default").length >= 20
  ));
  return eligibleProductIds.flatMap((productId) => {
    const productAssessments = assessmentsByProduct.get(productId) ?? [];
    return DIMENSION_LIST.map((dimension) => {
      const hitCount = productAssessments.filter((assessment) =>
        assessment.dimensions.some((entry) => entry.dimension === dimension && entry.present),
      ).length;
      return {
        productId,
        dimension,
        hitCount,
        totalCount: productAssessments.length,
        coverage: roundedShare(hitCount, productAssessments.length),
        evidenceId: `AGG-SIX-${productId}-${dimension}`,
      };
    });
  });
}

/** Applies the fixed F01/F02/F03 gates to rows that survived parser preflight. */
export function getAnalysisReadiness(packs: Pick<ParsedProductPack, "product" | "reviews" | "questions">[]): AnalysisReadiness[] {
  const ownPacks = packs.filter((pack) => pack.product.role === "self");
  const ownReviews = ownPacks.flatMap((pack) => pack.reviews);
  const ownQuestions = ownPacks.flatMap((pack) => pack.questions);
  const ownDefault = ownReviews.filter((review) => review.sort === "default").length;
  const ownRecent = ownReviews.filter((review) => review.sort === "recent").length;
  const eligibleCompetitors = packs.filter(
    (pack) => pack.product.role === "competitor" && pack.questions.length >= 90,
  ).length;

  return [
    {
      findingId: "F01",
      status: ownDefault >= 90 && ownRecent >= 90 ? "available" : "unavailable",
      reason: `我方默认排序 ${ownDefault} 条、时间排序 ${ownRecent} 条；F01 两表均需至少 90 条。`,
    },
    {
      findingId: "F02",
      status: ownDefault >= 90 ? "available" : "unavailable",
      reason: ownDefault >= 90
        ? `我方默认排序 ${ownDefault} 条；F02 可正式聚合。`
        : ownDefault >= 20
          ? `我方默认排序 ${ownDefault} 条；F02 仅保留逐条结果，不能正式聚合。`
          : `我方默认排序 ${ownDefault} 条；F02 未达到逐条保留的 20 条边界。`,
    },
    {
      findingId: "F03",
      status: ownQuestions.length >= 90 ? "available" : "unavailable",
      reason: ownQuestions.length >= 90
        ? `我方问题 ${ownQuestions.length} 条；F03 可用，纳入 ${eligibleCompetitors} 个问题不少于 90 条的竞品。`
        : `我方问题 ${ownQuestions.length} 条；F03 需至少 90 条。`,
    },
  ];
}

function rowIdsAreUnique(reviews: ReviewRow[], questions: QuestionRow[], errors: EvidenceGraphError[]): void {
  const rowIds = new Set<string>();
  for (const row of [...reviews, ...questions]) {
    if (rowIds.has(row.rowId)) {
      errors.push({ code: "DUPLICATE_ROW_ID", message: `rowId 重复：${row.rowId}。` });
      return;
    }
    rowIds.add(row.rowId);
  }
}

function addAggregateMismatch(errors: EvidenceGraphError[], detail: string): void {
  errors.push({ code: "AGGREGATE_MISMATCH", message: `聚合与逐条明细不一致：${detail}。` });
}

interface ValidatedEvidence {
  evidenceId: string;
  productId: string;
  family: "type" | "question" | "dimension" | "data";
}

function completenessMismatch(errors: EvidenceGraphError[], detail: string): void {
  errors.push({ code: "COMPLETENESS_MISMATCH", message: `完整性证据与来源不一致：${detail}。` });
}

function sameStringList(left: unknown, right: string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function completenessStatusFor(usedRows: number) {
  if (usedRows === 0) return "missing";
  if (usedRows < 90) return "insufficient";
  if (usedRows < 100) return "provisional";
  return "complete";
}

function validateCompletenessEvidence(
  input: LooseReport,
  errors: EvidenceGraphError[],
): Map<string, ValidatedEvidence> {
  const sources = input.sources ?? [];
  const actual = input.meta?.completeness;
  const products = input.products ?? [];
  if (sources.length === 0 && actual === undefined && products.length === 0) return new Map();
  if (!Array.isArray(actual)) {
    completenessMismatch(errors, "缺少 meta.completeness");
    return new Map();
  }

  const productById = new Map(products.map((product) => [product.productId, product]));
  const expectedByEvidenceId = new Map<string, CompletenessEvidence>();
  const sourceIds = new Set<string>();
  const sourceById = new Map<string, (typeof sources)[number]>();
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) {
      completenessMismatch(errors, `sourceId 重复 ${source.sourceId}`);
      errors.push({ code: "SOURCE_ANCHOR_MISMATCH", message: `sourceId 不唯一：${source.sourceId}。` });
      continue;
    }
    sourceIds.add(source.sourceId);
    sourceById.set(source.sourceId, source);
  }
  for (const product of products) {
    for (const kind of ["default_reviews", "recent_reviews", "questions"] as const) {
      const matching = sources.filter((source) => source.productId === product.productId && source.kind === kind);
      if (matching.length !== 1) {
        errors.push({
          code: "MISSING_REQUIRED_SOURCE",
          message: `产品 ${product.productId} 必须有且只有一个 ${kind} 来源。`,
        });
      }
    }
  }
  for (const row of input.reviews ?? []) {
    const source = sourceById.get(row.sourceId);
    const expectedKind = `${row.sort}_reviews`;
    if (!source || source.productId !== row.productId || source.kind !== expectedKind) {
      errors.push({ code: "SOURCE_ANCHOR_MISMATCH", message: `评价 ${row.rowId} 的 sourceId 与产品或类型不匹配。` });
    }
  }
  for (const row of input.questions ?? []) {
    const source = sourceById.get(row.sourceId);
    if (!source || source.productId !== row.productId || source.kind !== "questions") {
      errors.push({ code: "SOURCE_ANCHOR_MISMATCH", message: `问题 ${row.rowId} 的 sourceId 与产品或类型不匹配。` });
    }
  }
  for (const row of input.excludedRows ?? []) {
    if (!sourceById.has(row.sourceId)) {
      errors.push({ code: "SOURCE_ANCHOR_MISMATCH", message: `排除行 ${row.rowId} 引用未知 sourceId。` });
    }
  }

  for (const source of sources) {
    const product = productById.get(source.productId);
    if (!product) {
      completenessMismatch(errors, `来源引用未知产品 ${source.productId}`);
      continue;
    }
    const sourceRows = source.kind === "questions"
      ? (input.questions ?? []).filter((row) => row.sourceId === source.sourceId)
      : source.kind === "default_reviews" || source.kind === "recent_reviews"
        ? (input.reviews ?? []).filter((row) => row.sourceId === source.sourceId)
        : [];
    const excluded = (input.excludedRows ?? []).filter((row) => row.sourceId === source.sourceId);
    const excludedOverLimit = excluded.filter((row) => row.reason === "OVER_LIMIT").length;
    const usedRows = sourceRows.length;
    const validRows = usedRows + excludedOverLimit;
    const status = completenessStatusFor(usedRows);
    if (
      sourceRows.some((row) => row.productId !== source.productId)
      || source.rowsRead !== usedRows + excluded.length
      || source.validRows !== validRows
      || source.usedRows !== usedRows
      || source.excludedRows !== excluded.length
      || source.excludedOverLimit !== excludedOverLimit
      || source.status !== status
    ) {
      completenessMismatch(errors, `来源计数无法由逐条数据复算 ${source.sourceId}`);
      continue;
    }
    const kind = `${product.role}_${source.kind}` as CompletenessEvidence["kind"];
    const evidenceId = `DATA-${source.productId}-${kind}`;
    if (expectedByEvidenceId.has(evidenceId)) {
      completenessMismatch(errors, `产品与来源类型重复 ${source.productId}:${source.kind}`);
      continue;
    }
    expectedByEvidenceId.set(evidenceId, {
      evidenceId,
      productId: source.productId,
      kind,
      sourceIds: [source.sourceId],
      expectedRows: 100,
      validRows,
      usedRows,
      excludedOverLimit,
      status,
      blocking: usedRows < 90,
    });
  }

  if (actual.length !== expectedByEvidenceId.size) {
    completenessMismatch(errors, "证据项数量不完整、重复或有额外项");
  }
  const validated = new Map<string, ValidatedEvidence>();
  const seen = new Set<string>();
  for (const candidate of actual) {
    if (!candidate || typeof candidate !== "object") {
      completenessMismatch(errors, "存在非对象证据项");
      continue;
    }
    if (seen.has(candidate.evidenceId)) {
      completenessMismatch(errors, `evidenceId 重复 ${candidate.evidenceId}`);
      continue;
    }
    seen.add(candidate.evidenceId);
    const expected = expectedByEvidenceId.get(candidate.evidenceId);
    if (
      !expected
      || candidate.productId !== expected.productId
      || candidate.kind !== expected.kind
      || !sameStringList(candidate.sourceIds, expected.sourceIds)
      || candidate.expectedRows !== expected.expectedRows
      || candidate.validRows !== expected.validRows
      || candidate.usedRows !== expected.usedRows
      || candidate.excludedOverLimit !== expected.excludedOverLimit
      || candidate.status !== expected.status
      || candidate.blocking !== expected.blocking
    ) {
      completenessMismatch(errors, candidate.evidenceId || "未知 evidenceId");
      continue;
    }
    validated.set(candidate.evidenceId, {
      evidenceId: candidate.evidenceId,
      productId: candidate.productId,
      family: "data",
    });
  }
  for (const evidenceId of expectedByEvidenceId.keys()) {
    if (!seen.has(evidenceId)) completenessMismatch(errors, `缺少 ${evidenceId}`);
  }
  return validated;
}

function validateCanonicalStats(
  actual: unknown,
  expected: object[],
  key: (entry: Record<string, unknown>) => string,
  fields: string[],
  family: ValidatedEvidence["family"],
  errors: EvidenceGraphError[],
): Map<string, ValidatedEvidence> {
  const validated = new Map<string, ValidatedEvidence>();
  if (!Array.isArray(actual)) {
    addAggregateMismatch(errors, "缺少 canonical 聚合数组");
    return validated;
  }
  const expectedByKey = new Map(expected.map((entry) => {
    const typed = entry as Record<string, unknown>;
    return [key(typed), typed];
  }));
  if (actual.length !== expected.length) addAggregateMismatch(errors, "聚合项数量不完整或有额外项");
  const actualKeys = new Set<string>();
  for (const entry of actual) {
    if (!entry || typeof entry !== "object") {
      addAggregateMismatch(errors, "存在非对象聚合项");
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const candidateKey = key(candidate);
    const expectedEntry = expectedByKey.get(candidateKey);
    if (actualKeys.has(candidateKey)) {
      addAggregateMismatch(errors, `重复聚合键 ${candidateKey}`);
      continue;
    }
    actualKeys.add(candidateKey);
    if (!expectedEntry || fields.some((field) => !sameAggregateValue(candidate[field], expectedEntry[field])) || candidate.evidenceId !== expectedEntry.evidenceId) {
      addAggregateMismatch(errors, candidateKey);
      continue;
    }
    validated.set(candidate.evidenceId as string, {
      evidenceId: candidate.evidenceId as string,
      productId: candidate.productId as string,
      family,
    });
  }
  for (const expectedKey of expectedByKey.keys()) {
    if (!actualKeys.has(expectedKey)) addAggregateMismatch(errors, `缺少聚合键 ${expectedKey}`);
  }
  return validated;
}

function sameAggregateValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameAggregateValue(value, right[index]));
  }
  return left === right;
}

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function validateCatalog(actual: unknown, expected: readonly object[], name: string, errors: EvidenceGraphError[]): void {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    errors.push({ code: "CATALOG_MISMATCH", message: `${name} 目录缺失、重复或数量不一致。` });
    return;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const entry = actual[index];
    if (!entry || typeof entry !== "object" || !sameRecord(entry as Record<string, unknown>, expected[index] as Record<string, unknown>)) {
      errors.push({ code: "CATALOG_MISMATCH", message: `${name} 目录第 ${index + 1} 项与固定目录不一致。` });
      return;
    }
  }
}

function actionReferenceList(
  action: LooseAction,
  plural: "findingIds" | "evidenceIds",
  singular: "findingId" | "evidenceId",
  errors: EvidenceGraphError[],
): string[] {
  const singularValue = action[singular];
  const pluralValue = action[plural];
  const singularRefs = typeof singularValue === "string" ? [singularValue] : [];
  const pluralRefs = Array.isArray(pluralValue) ? pluralValue.filter((value): value is string => typeof value === "string") : [];
  if (singularValue !== undefined && pluralValue !== undefined && !sameStrings(singularRefs, pluralRefs)) {
    errors.push({ code: "CONFLICTING_ACTION_REFERENCE", message: `行动 ${singular} 与 ${plural} 冲突。` });
  }
  return pluralValue !== undefined ? pluralRefs : singularRefs;
}

function reasonReferences(reason: string, kind: "finding" | "evidence"): string[] {
  const pattern = kind === "finding" ? /\bF\d+\b/gu : /\b(?:AGG|DATA)-[A-Za-z0-9:_-]+\b/gu;
  return [...new Set(reason.match(pattern) ?? [])].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return [...new Set(left)].sort().join("\u0000") === [...new Set(right)].sort().join("\u0000");
}

function validateReadiness(
  input: LooseReport,
  findings: Array<{
    findingId: string;
    status?: string;
    hasProblem?: boolean;
    problemCode?: string | null;
  }>,
  canonicalAggregates: Pick<ReportAggregates, "taxonomy" | "topics" | "dimensions">,
  errors: EvidenceGraphError[],
): void {
  const products = input.products ?? [];
  if (products.length === 0) return;
  const expected = getAnalysisReadiness(products.map((product) => ({
    product,
    reviews: (input.reviews ?? []).filter((review) => review.productId === product.productId),
    questions: (input.questions ?? []).filter((question) => question.productId === product.productId),
  })));
  const actual = input.meta?.analysisReadiness;
  if (!Array.isArray(actual)) {
    errors.push({ code: "READINESS_MISMATCH", message: "缺少可由逐条数据复算的 analysisReadiness。" });
    return;
  }
  const actualById = new Map(actual.map((entry) => [entry.findingId, entry]));
  if (actual.length !== expected.length || actualById.size !== expected.length) {
    errors.push({ code: "READINESS_MISMATCH", message: "analysisReadiness 缺失、重复或存在额外项。" });
  }
  const findingById = new Map(findings.map((finding) => [finding.findingId, finding]));
  for (const expectedEntry of expected) {
    const findingId = expectedEntry.findingId as "F01" | "F02" | "F03";
    const actualEntry = actualById.get(expectedEntry.findingId);
    if (!actualEntry || actualEntry.status !== expectedEntry.status || actualEntry.reason !== expectedEntry.reason) {
      errors.push({ code: "READINESS_MISMATCH", message: `${expectedEntry.findingId} readiness 无法由逐条数据复算。` });
    }
    const finding = findingById.get(expectedEntry.findingId);
    if (!finding || finding.status !== expectedEntry.status) {
      errors.push({ code: "READINESS_MISMATCH", message: `${expectedEntry.findingId} finding status 与复算 readiness 不一致。` });
    }
    const expectedProblem = deriveFindingProblem(
      findingId,
      expectedEntry.status,
      products,
      canonicalAggregates,
    );
    if (
      !finding
      || finding.hasProblem !== expectedProblem.hasProblem
      || finding.problemCode !== expectedProblem.problemCode
    ) {
      errors.push({
        code: "DIAGNOSIS_MISMATCH",
        message: `${expectedEntry.findingId} hasProblem/problemCode 无法由逐条数据复算。`,
      });
    }
  }
}

/**
 * Validates only data that can be recomputed from supplied row-level evidence.
 * It deliberately ignores any model-reported totals.
 */
export function validateEvidenceGraph(input: LooseReport): EvidenceGraphValidation {
  const errors: EvidenceGraphError[] = [];
  const reviews = input.reviews ?? [];
  const questions = input.questions ?? [];
  const top20 = input.top20 ?? [];
  const findings: Array<{
    findingId: string;
    status?: string;
    hasProblem?: boolean;
    problemCode?: string | null;
    evidenceIds: string[];
  }> = [];
  const findingIds = new Set<string>();
  for (const finding of input.findings ?? []) {
    if (finding.findingId !== undefined && finding.id !== undefined && finding.findingId !== finding.id) {
      errors.push({ code: "CONFLICTING_FINDING_ID", message: "findingId 与 id 冲突。" });
      continue;
    }
    const findingId = finding.findingId ?? finding.id;
    if (typeof findingId !== "string" || !findingId) {
      errors.push({ code: "MISSING_FINDING_ID", message: "发现缺少 findingId。" });
      continue;
    }
    if (findingIds.has(findingId)) {
      errors.push({ code: "DUPLICATE_FINDING_ID", message: `发现 ID 重复：${findingId}。` });
      continue;
    }
    findingIds.add(findingId);
    findings.push({
      findingId,
      status: finding.status,
      hasProblem: finding.hasProblem,
      problemCode: finding.problemCode,
      evidenceIds: finding.evidenceIds ?? [],
    });
  }
  const actions = input.actions ?? [];

  rowIdsAreUnique(reviews, questions, errors);
  validateCatalog(input.taxonomy, TAXONOMY, "taxonomy", errors);
  validateCatalog(input.topics, TOPICS, "topics", errors);

  const reviewById = new Map(reviews.map((review) => [review.rowId, review]));
  const assessedReviewIds = new Set<string>();
  for (const assessment of top20) {
    const review = reviewById.get(assessment.reviewId);
    if (!review) {
      errors.push({ code: "UNKNOWN_MODEL_ROW", message: `Top20 标注引用了不存在的评价：${assessment.reviewId}。` });
      continue;
    }
    if (assessedReviewIds.has(assessment.reviewId)) {
      errors.push({ code: "DUPLICATE_MODEL_ROW", message: `Top20 标注重复引用评价：${assessment.reviewId}。` });
    }
    assessedReviewIds.add(assessment.reviewId);
    if (review.sort !== "default" || review.rank < 1 || review.rank > 20 || assessment.rank < 1 || assessment.rank > 20) {
      errors.push({ code: "INVALID_TOP20_REVIEW", message: `Top20 必须引用默认排序的前 20 条评价：${assessment.reviewId}。` });
    }
    if (assessment.dimensions.some((entry) => !DIMENSION_LIST.includes(entry.dimension))) {
      errors.push({ code: "INVALID_DIMENSION", message: `Top20 含有未知六维标签：${assessment.reviewId}。` });
    }
  }
  if ((input.products ?? []).length > 0) {
    for (const product of input.products ?? []) {
      const defaultCount = reviews.filter((review) => review.productId === product.productId && review.sort === "default").length;
      const assessmentCount = top20.filter((assessment) => reviewById.get(assessment.reviewId)?.productId === product.productId).length;
      const expectedCount = defaultCount >= 20 ? 20 : 0;
      if (assessmentCount !== expectedCount) {
        errors.push({
          code: "INVALID_TOP20_REVIEW",
          message: `产品 ${product.productId} 默认评价 ${defaultCount} 条时必须保留 ${expectedCount} 条六维明细。`,
        });
      }
    }
  }
  for (const review of reviews) {
    if (review.typeId !== undefined && !TYPE_IDS.has(review.typeId)) {
      errors.push({ code: "INVALID_TYPE_ID", message: `评价 ${review.rowId} 的 typeId 不在 t1–t8：${review.typeId}。` });
      break;
    }
  }
  for (const question of questions) {
    if (question.topicId !== undefined && !TOPIC_IDS.has(question.topicId)) {
      errors.push({ code: "INVALID_TOPIC_ID", message: `问题 ${question.rowId} 的 topicId 不在 q1–q8：${question.topicId}。` });
      break;
    }
  }

  const typeStats = buildTypeStats(reviews);
  const questionStats = buildQuestionStats(questions);
  const sixStats = buildSixDimensionStats(reviews, top20);
  const typeEvidence = validateCanonicalStats(input.aggregates?.taxonomy, typeStats, (entry) => `${entry.productId ?? ""}:${entry.typeId}`, ["defaultCount", "defaultShare", "recentCount", "recentShare", "difference"], "type", errors);
  const questionEvidence = validateCanonicalStats(input.aggregates?.topics, questionStats, (entry) => `${entry.productId ?? ""}:${entry.topicId}`, ["count", "share", "representativeQuestionIds"], "question", errors);
  const dimensionEvidence = validateCanonicalStats(input.aggregates?.dimensions, sixStats, (entry) => `${entry.productId ?? ""}:${entry.dimension}`, ["hitCount", "totalCount", "coverage"], "dimension", errors);
  const completenessEvidence = validateCompletenessEvidence(input, errors);
  validateReadiness(input, findings, {
    taxonomy: typeStats,
    topics: questionStats,
    dimensions: sixStats,
  }, errors);
  const evidence = new Map<string, ValidatedEvidence>([
    ...completenessEvidence,
    ...typeEvidence,
    ...questionEvidence,
    ...dimensionEvidence,
  ]);

  const productById = new Map((input.products ?? []).map((product) => [product.productId, product]));
  const questionCountByProduct = new Map<string, number>();
  for (const question of questions) {
    questionCountByProduct.set(question.productId, (questionCountByProduct.get(question.productId) ?? 0) + 1);
  }
  for (const finding of findings) {
    const findingEvidence = finding.evidenceIds
      .map((evidenceId) => evidence.get(evidenceId))
      .filter((entry): entry is ValidatedEvidence => Boolean(entry));
    for (const evidenceId of finding.evidenceIds) {
      const node = evidence.get(evidenceId);
      if (!node) {
        errors.push({ code: "UNKNOWN_EVIDENCE", message: `发现 ${finding.findingId} 引用了不存在的证据：${evidenceId}。` });
        break;
      }
      if (finding.findingId === "F03") {
        if (node.family === "data") continue;
        if (node.family !== "question") {
          errors.push({ code: "INVALID_F03_EVIDENCE", message: `F03 只能使用问题聚合证据：${evidenceId}。` });
          continue;
        }
        const product = productById.get(node.productId);
        if (!product || questionCountByProduct.get(node.productId)! < 90 || (product.role !== "self" && product.role !== "competitor")) {
          errors.push({ code: "INELIGIBLE_COMPETITOR_EVIDENCE", message: `F03 不可使用问题数不足 90 条的产品证据：${evidenceId}。` });
        }
      }
    }
    if (finding.status === "unavailable") {
      if (!findingEvidence.some((entry) => entry.family === "data") || findingEvidence.some((entry) => entry.family !== "data")) {
        errors.push({
          code: "INVALID_FINDING_EVIDENCE",
          message: `不可用发现 ${finding.findingId} 必须且只能引用 DATA 完整性证据。`,
        });
      }
    } else if (finding.status === "available") {
      const requiredFamily = finding.findingId === "F01"
        ? "type"
        : finding.findingId === "F02"
          ? "dimension"
          : finding.findingId === "F03"
            ? "question"
            : undefined;
      if (requiredFamily && !findingEvidence.some((entry) => entry.family === requiredFamily)) {
        errors.push({
          code: "INVALID_FINDING_EVIDENCE",
          message: `可用发现 ${finding.findingId} 缺少 ${requiredFamily} 聚合证据。`,
        });
      }
      if (
        finding.findingId === "F03"
        && !findingEvidence.some((entry) => entry.family === "question" && productById.get(entry.productId)?.role === "self")
      ) {
        errors.push({
          code: "INVALID_FINDING_EVIDENCE",
          message: "可用发现 F03 必须引用至少一项我方问题聚合证据。",
        });
      }
    }
  }

  if (actions.length > 8) errors.push({ code: "TOO_MANY_ACTIONS", message: `行动数量为 ${actions.length}，最多只能有 8 条。` });
  const findingById = new Map(findings.map((finding) => [finding.findingId, finding]));
  const reportedMissingFindings = new Set<string>();
  const actionCountByFinding = new Map<string, number>();
  const reportedDuplicateFindingActions = new Set<string>();
  for (const action of actions) {
    const actionFindingIds = actionReferenceList(action, "findingIds", "findingId", errors);
    const actionEvidenceIds = actionReferenceList(action, "evidenceIds", "evidenceId", errors);
    for (const findingId of new Set(actionFindingIds)) {
      const count = (actionCountByFinding.get(findingId) ?? 0) + 1;
      actionCountByFinding.set(findingId, count);
      if (count > 1 && !reportedDuplicateFindingActions.has(findingId)) {
        errors.push({
          code: "DUPLICATE_FINDING_ACTION",
          message: `同一 finding 最多只能有一条行动：${findingId}。`,
        });
        reportedDuplicateFindingActions.add(findingId);
      }
    }
    if (actionFindingIds.length === 0) {
      errors.push({ code: "MISSING_ACTION_FINDING", message: "行动必须引用至少一个 finding。" });
    }
    if (actionEvidenceIds.length === 0) {
      errors.push({ code: "MISSING_ACTION_EVIDENCE", message: "行动必须引用至少一个 evidence。" });
    }
    if (actionFindingIds.length === 0 || actionEvidenceIds.length === 0) continue;
    const missingFinding = actionFindingIds.find((findingId) => !findingById.has(findingId));
    if (missingFinding) {
      if (!reportedMissingFindings.has(missingFinding)) {
        errors.push({ code: "UNKNOWN_FINDING", message: `行动引用了不存在的发现：${missingFinding}。` });
        reportedMissingFindings.add(missingFinding);
      }
      continue;
    }
    if (actionEvidenceIds.some((evidenceId) => !evidence.has(evidenceId))) {
      errors.push({ code: "UNKNOWN_EVIDENCE", message: "行动引用了不存在的证据。" });
      continue;
    }
    const findingEvidenceIds = new Set(actionFindingIds.flatMap((findingId) => findingById.get(findingId)?.evidenceIds ?? []));
    if (actionEvidenceIds.some((evidenceId) => !findingEvidenceIds.has(evidenceId))) {
      errors.push({ code: "EVIDENCE_NOT_IN_FINDING", message: "行动证据不属于其引用 finding 的 evidenceIds。" });
      continue;
    }
    const reason = action.reason ?? "";
    if (!sameStrings(reasonReferences(reason, "finding"), actionFindingIds)) {
      errors.push({ code: "REASON_FINDING_MISMATCH", message: "行动原因中的 findingId 与引用不一致。" });
    }
    if (!sameStrings(reasonReferences(reason, "evidence"), actionEvidenceIds)) {
      errors.push({ code: "REASON_EVIDENCE_MISMATCH", message: "行动原因中的 evidenceId 与引用不一致。" });
    }
  }

  return { valid: errors.length === 0, errors };
}
