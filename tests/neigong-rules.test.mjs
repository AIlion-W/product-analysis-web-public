import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDedupAggregate,
  buildQuestionStats,
  buildSixDimensionStats,
  buildTypeStats,
  getAnalysisReadiness,
  selectF01TaxonomyAggregate,
  validateEvidenceGraph,
} from "../lib/neigong/rules.ts";
import { TAXONOMY, TOPICS } from "../lib/neigong/catalog.ts";
import { createValidNeigongReport } from "./helpers/neigong-report-fixture.mjs";

function review(rowId, initialText, options = {}) {
  return {
    rowId,
    sourceId: options.sourceId ?? "own:default_reviews",
    sourceRow: options.sourceRow ?? 2,
    productId: options.productId ?? "own",
    sort: options.sort ?? "default",
    rank: options.rank ?? 1,
    date: "2026-08-10",
    sku: "",
    initialText,
    followupText: "",
    normalizedText: initialText,
    ...options,
  };
}

function question(rowId, questionText, options = {}) {
  return {
    rowId,
    sourceId: options.sourceId ?? "own:questions",
    sourceRow: options.sourceRow ?? 2,
    productId: options.productId ?? "own",
    rank: options.rank ?? 1,
    questionText,
    answer: "有",
    date: "2026-08-10",
    normalizedText: questionText,
    ...options,
  };
}

test("F01 选择我方最大绝对差并按 typeId 稳定打破并列", () => {
  const products = [
    { productId: "own", role: "self", name: "我方" },
    { productId: "rival", role: "competitor", name: "竞品" },
  ];
  const aggregate = (productId, typeId, difference) => ({ productId, typeId, difference });
  assert.equal(selectF01TaxonomyAggregate(products, [
    aggregate("own", "t1", 0),
    aggregate("own", "t2", -0.2),
    aggregate("rival", "t3", 0.9),
  ]).typeId, "t2");
  assert.equal(selectF01TaxonomyAggregate(products, [
    aggregate("own", "t3", -0.2),
    aggregate("own", "t2", 0.2),
  ]).typeId, "t2");
});

function report(overrides = {}) {
  const reviews = overrides.reviews ?? [];
  const questions = overrides.questions ?? [];
  const top20 = overrides.top20 ?? [];
  const canonicalAggregates = {
    taxonomy: buildTypeStats(reviews),
    topics: buildQuestionStats(questions),
    dimensions: buildSixDimensionStats(reviews, top20),
    duplicateRows: [],
    crossSortOverlap: [],
  };
  return {
    reviews,
    questions,
    top20,
    taxonomy: TAXONOMY,
    topics: TOPICS,
    aggregates: canonicalAggregates,
    findings: [],
    actions: [],
    ...overrides,
    aggregates: overrides.aggregates ?? canonicalAggregates,
  };
}

test("默认与时间表按一对一多重集匹配", () => {
  const result = buildDedupAggregate(
    [review("d1", "相同"), review("d2", "相同"), review("d3", "不同")],
    [review("r1", "相同", { sort: "recent", sourceId: "own:recent_reviews" }), review("r2", "别的", { sort: "recent", sourceId: "own:recent_reviews" })],
  );

  assert.equal(result.crossLists[0].overlapRows, 1);
  assert.deepEqual(result.crossLists[0].pairs, [{ leftRowId: "d1", rightRowId: "r1" }]);
});

test("单表重复组按 NFKC、Unicode 空白精确归并且保留 emoji", () => {
  const result = buildDedupAggregate(
    [review("d1", "Ａ　好\u2003🙂"), review("d2", "A 好🙂"), review("d3", "A好😐")],
    [],
  );

  assert.deepEqual(result.duplicateRows, [{ sourceId: "own:default_reviews", rowIds: ["d1", "d2"] }]);
});

test("分类和问题聚合只计算合法的 t1-t8 与 q1-q8 单选标注", () => {
  const typeStats = buildTypeStats([
    review("r1", "有效", { typeId: "t1" }),
    review("r2", "无效", { typeId: "bad" }),
  ]);
  const questionStats = buildQuestionStats([
    question("q1", "有效", { topicId: "q1" }),
    question("q2", "无效", { topicId: "bad" }),
  ]);

  assert.equal(typeStats.find((stat) => stat.typeId === "t1").defaultCount, 1);
  assert.equal(typeStats.find((stat) => stat.typeId === "t1").evidenceId, "AGG-TYPE-own-t1");
  assert.equal(typeStats.find((stat) => stat.typeId === "t2").defaultCount, 0);
  assert.equal(questionStats.find((stat) => stat.topicId === "q1").count, 1);
  assert.equal(questionStats.find((stat) => stat.topicId === "q1").evidenceId, "AGG-QUESTION-own-q1");
});

test("六维聚合从逐条 Top20 重新计算", () => {
  const reviews = Array.from({ length: 20 }, (_, index) => review(`r${index + 1}`, `评价 ${index + 1}`, { rank: index + 1 }));
  const stats = buildSixDimensionStats(
    reviews,
    reviews.map((row) => ({ reviewId: row.rowId, rank: row.rank, score: 1, dimensions: [{ dimension: "scene", present: true, evidence: "通勤" }] })),
  );

  assert.deepEqual(stats.find((stat) => stat.dimension === "scene"), {
    productId: "own",
    dimension: "scene",
    hitCount: 20,
    totalCount: 20,
    coverage: 1,
    evidenceId: "AGG-SIX-own-scene",
  });
});

test("readiness 严格执行 90 条门禁及 F02 20 条保留边界", () => {
  const pack = (role, defaults, recent, questions) => ({
    product: { productId: role === "self" ? "own" : "other", role, name: role },
    reviews: [
      ...Array.from({ length: defaults }, (_, i) => review(`d${role}${i}`, "评价", { sort: "default", productId: role === "self" ? "own" : "other" })),
      ...Array.from({ length: recent }, (_, i) => review(`r${role}${i}`, "评价", { sort: "recent", productId: role === "self" ? "own" : "other" })),
    ],
    questions: Array.from({ length: questions }, (_, i) => question(`q${role}${i}`, "问题", { productId: role === "self" ? "own" : "other" })),
  });

  assert.equal(getAnalysisReadiness([pack("self", 89, 90, 90)])[0].status, "unavailable");
  assert.equal(getAnalysisReadiness([pack("self", 20, 90, 90)])[1].status, "unavailable");
  assert.equal(getAnalysisReadiness([pack("self", 90, 90, 90), pack("competitor", 1, 1, 89)])[2].status, "available");
  assert.equal(getAnalysisReadiness([pack("self", 90, 90, 89)])[2].status, "unavailable");
});

test("90 条 finding 可用、89 条不可用，F02 按 20/89/90 分界", () => {
  const availability = (count) => getAnalysisReadiness([{
    product: { productId: "own", role: "self", name: "我方" },
    reviews: Array.from({ length: count }, (_, i) => review(`d${i}`, "评价")),
    questions: [],
  }]);

  assert.equal(availability(20)[1].status, "unavailable");
  assert.equal(availability(89)[1].status, "unavailable");
  assert.equal(availability(90)[1].status, "available");
});

test("断链 action 不能通过验证", () => {
  const validation = validateEvidenceGraph(report({
    findings: [{ findingId: "F01", status: "available", title: "", detail: "", evidenceIds: ["AGG-MISSING"] }],
    actions: [{ priority: "P0", findingIds: ["F01"], evidenceIds: ["AGG-MISSING"], reason: "F01｜AGG-MISSING：补内容" }],
  }));

  assert.equal(validation.valid, false);
  assert.match(validation.errors[0].code, /UNKNOWN_EVIDENCE/);
});

test("证据图兼容 finding 的 id 字段并将 action 原因绑定到它的证据", () => {
  const validation = validateEvidenceGraph(report({
    reviews: [review("r1", "好", { typeId: "t1" })],
    findings: [{ id: "F01", status: "available", evidenceIds: ["AGG-TYPE-own-t1"] }],
    actions: [{ priority: "P0", findingIds: ["F01"], evidenceIds: ["AGG-TYPE-own-t1"], reason: "F01｜AGG-TYPE-own-t1：补内容" }],
  }));

  assert.equal(validation.valid, true);
});

test("聚合证据必须是完整且一一对应的 canonical report.aggregates 节点", () => {
  const reviews = [review("r1", "好", { typeId: "t1" })];
  const expected = report({ reviews }).aggregates;
  const invalidAggregates = [
    { ...expected, taxonomy: undefined },
    { ...expected, taxonomy: [] },
    { ...expected, taxonomy: expected.taxonomy.slice(0, 7) },
    { ...expected, taxonomy: [...expected.taxonomy, expected.taxonomy[0]] },
    { ...expected, taxonomy: [...expected.taxonomy, { ...expected.taxonomy[0], typeId: "t9", evidenceId: "AGG-TYPE-own-t9" }] },
  ];

  for (const aggregates of invalidAggregates) {
    const validation = validateEvidenceGraph(report({ reviews, aggregates }));
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "AGGREGATE_MISMATCH"));
  }
});

test("action 必须强制绑定 finding、其自身证据和完全一致的 reason", () => {
  const reviews = [review("r1", "好", { typeId: "t1" })];
  const findings = [{ findingId: "F01", evidenceIds: ["AGG-TYPE-own-t1"] }];
  const cases = [
    { findingId: "F01", reason: "F01｜AGG-TYPE-own-t1" },
    { evidenceId: "AGG-TYPE-own-t1", reason: "F01｜AGG-TYPE-own-t1" },
    { findingId: "F01", evidenceId: "AGG-TYPE-own-t2", reason: "F01｜AGG-TYPE-own-t2" },
  ];

  for (const action of cases) {
    const validation = validateEvidenceGraph(report({ reviews, findings, actions: [action] }));
    assert.equal(validation.valid, false);
  }
});

test("evidenceId 分隔符注入不能冒充多个合法证据", () => {
  const reviews = [review("r1", "好", { typeId: "t1" })];
  const injected = "AGG-TYPE-own-t1｜AGG-TYPE-own-t2";
  const validation = validateEvidenceGraph(report({
    reviews,
    findings: [{ findingId: "F01", evidenceIds: [injected] }],
    actions: [{ findingId: "F01", evidenceId: injected, reason: `F01｜${injected}` }],
  }));

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "UNKNOWN_EVIDENCE"));
});

test("P0 action 可完整反查到 finding、聚合 evidence 和原始 Excel 行", () => {
  const full = createValidNeigongReport();
  const finding = full.findings.find((item) => item.findingId === "F01");
  assert.ok(finding);
  const evidenceId = finding.evidenceIds.find((id) => id.startsWith("AGG-TYPE-"));
  assert.ok(evidenceId);
  full.actions = [{
    actionId: "A01",
    priority: "P0",
    action: "修正评价结构",
    reason: `F01｜${evidenceId}：修正评价结构`,
    findingId: "F01",
    evidenceId,
  }];

  const aggregate = full.aggregates.taxonomy.find((item) => item.evidenceId === evidenceId);
  const rawRows = full.reviews.filter((row) => (
    row.productId === aggregate?.productId && row.typeId === aggregate?.typeId
  ));
  const source = full.sources.find((item) => item.sourceId === rawRows[0]?.sourceId);

  assert.equal(validateEvidenceGraph(full).valid, true);
  assert.equal(full.actions[0].findingId, finding.findingId);
  assert.equal(full.actions[0].evidenceId, aggregate.evidenceId);
  assert.ok(rawRows.length > 0);
  assert.ok(Number.isInteger(rawRows[0].sourceRow));
  assert.equal(source.productId, rawRows[0].productId);
});

test("F03 拒绝 questions 少于 90 条的竞品证据", () => {
  const ownQuestions = Array.from({ length: 90 }, (_, index) => question(`own-${index}`, "我方问题", { topicId: "q1" }));
  const otherQuestions = Array.from({ length: 89 }, (_, index) => question(`other-${index}`, "竞品问题", { productId: "other", sourceId: "other:questions", topicId: "q1" }));
  const findings = [{ findingId: "F03", evidenceIds: ["AGG-QUESTION-other-q1"] }];
  const validation = validateEvidenceGraph(report({
    questions: [...ownQuestions, ...otherQuestions],
    products: [{ productId: "own", role: "self", name: "我方" }, { productId: "other", role: "competitor", name: "竞品" }],
    findings,
    actions: [{ findingId: "F03", evidenceId: "AGG-QUESTION-other-q1", reason: "F03｜AGG-QUESTION-other-q1" }],
  }));

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "INELIGIBLE_COMPETITOR_EVIDENCE"));
});

test("Top20 拒绝重复、未知六维、非 default 和超出前 20 的评价", () => {
  const cases = [
    { reviews: [review("r1", "好")], top20: [{ reviewId: "r1", rank: 1, score: 1, dimensions: [] }, { reviewId: "r1", rank: 1, score: 1, dimensions: [] }], code: "DUPLICATE_MODEL_ROW" },
    { reviews: [review("r1", "好")], top20: [{ reviewId: "r1", rank: 1, score: 1, dimensions: [{ dimension: "unknown", present: true, evidence: "x" }] }], code: "INVALID_DIMENSION" },
    { reviews: [review("r1", "好", { sort: "recent" })], top20: [{ reviewId: "r1", rank: 1, score: 1, dimensions: [] }], code: "INVALID_TOP20_REVIEW" },
    { reviews: [review("r1", "好", { rank: 21 })], top20: [{ reviewId: "r1", rank: 21, score: 1, dimensions: [] }], code: "INVALID_TOP20_REVIEW" },
  ];

  for (const { reviews, top20, code } of cases) {
    const validation = validateEvidenceGraph(report({ reviews, top20 }));
    assert.ok(validation.errors.some((error) => error.code === code));
  }
});

test("finding 与 action 的双协议冲突、缺失和重复 ID 必须失败", () => {
  const validation = validateEvidenceGraph(report({
    findings: [
      { findingId: "F01", id: "F02", evidenceIds: [] },
      { evidenceIds: [] },
      { findingId: "F03", evidenceIds: [] },
      { findingId: "F03", evidenceIds: [] },
    ],
    actions: [
      { findingId: "F01", findingIds: ["F02"], evidenceId: "AGG-X", evidenceIds: ["AGG-Y"], reason: "F01 F02 AGG-X AGG-Y" },
    ],
  }));

  for (const code of ["CONFLICTING_FINDING_ID", "MISSING_FINDING_ID", "DUPLICATE_FINDING_ID", "CONFLICTING_ACTION_REFERENCE"]) {
    assert.ok(validation.errors.some((error) => error.code === code));
  }
});

test("canonical 聚合拒绝数值比例漂移和错误 evidenceId", () => {
  const reviews = [review("r1", "好", { typeId: "t1" })];
  const expected = report({ reviews }).aggregates;
  const invalidAggregates = [
    { ...expected, taxonomy: expected.taxonomy.map((stat, index) => index === 0 ? { ...stat, defaultCount: 2 } : stat) },
    { ...expected, taxonomy: expected.taxonomy.map((stat, index) => index === 0 ? { ...stat, defaultShare: 0.5 } : stat) },
    { ...expected, taxonomy: expected.taxonomy.map((stat, index) => index === 0 ? { ...stat, evidenceId: "AGG-TYPE-own-bad" } : stat) },
  ];

  for (const aggregates of invalidAggregates) {
    const validation = validateEvidenceGraph(report({ reviews, aggregates }));
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "AGGREGATE_MISMATCH"));
  }
});

test("零行时允许空 canonical 聚合但不产生可引用证据", () => {
  const empty = report();
  assert.equal(validateEvidenceGraph(empty).valid, true);

  const forged = validateEvidenceGraph(report({
    findings: [{ findingId: "F01", evidenceIds: ["AGG-TYPE-own-t1"] }],
    actions: [{ findingId: "F01", evidenceId: "AGG-TYPE-own-t1", reason: "F01｜AGG-TYPE-own-t1" }],
  }));
  assert.equal(forged.valid, false);
  assert.ok(forged.errors.some((error) => error.code === "UNKNOWN_EVIDENCE"));
});

test("F03 只允许合格产品的问题聚合证据", () => {
  const reviews = Array.from({ length: 20 }, (_, index) => review(`r${index + 1}`, `评价 ${index + 1}`, { typeId: "t1", rank: index + 1 }));
  const top20 = reviews.map((row) => ({ reviewId: row.rowId, rank: row.rank, score: 1, dimensions: [{ dimension: "scene", present: true, evidence: "通勤" }] }));
  const questions = Array.from({ length: 90 }, (_, index) => question(`q${index}`, "问题", { topicId: "q1" }));
  for (const evidenceId of ["AGG-TYPE-own-t1", "AGG-SIX-own-scene"]) {
    const validation = validateEvidenceGraph(report({
      reviews,
      top20,
      questions,
      products: [{ productId: "own", role: "self", name: "我方" }],
      findings: [{ findingId: "F03", evidenceIds: [evidenceId] }],
      actions: [{ findingId: "F03", evidenceId, reason: `F03｜${evidenceId}` }],
    }));
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "INVALID_F03_EVIDENCE"));
  }
});

test("顶层 taxonomy/topics 必须与固定目录精确一致", () => {
  const missing = validateEvidenceGraph(report({ taxonomy: TAXONOMY.slice(1) }));
  const drifted = validateEvidenceGraph(report({ topics: TOPICS.map((topic, index) => index === 0 ? { ...topic, name: "漂移" } : topic) }));
  const duplicate = validateEvidenceGraph(report({ taxonomy: [...TAXONOMY.slice(0, 7), TAXONOMY[0]] }));

  for (const validation of [missing, drifted, duplicate]) {
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "CATALOG_MISMATCH"));
  }
});

test("证据图拒绝重复 rowId、未知模型 rowId、错误标注和超过 8 条 action", () => {
  const validation = validateEvidenceGraph(report({
    reviews: [review("same", "好", { typeId: "t9" }), review("same", "好")],
    top20: [{ reviewId: "missing", rank: 1, score: 0, dimensions: [] }],
    questions: [question("q1", "问题", { topicId: "q9" })],
    actions: Array.from({ length: 9 }, (_, i) => ({ actionId: `A${i}`, priority: "P0", findingId: "F01", evidenceId: "AGG-X", reason: "F01 AGG-X" })),
  }));

  assert.deepEqual(validation.errors.map((error) => error.code), [
    "DUPLICATE_ROW_ID",
    "UNKNOWN_MODEL_ROW",
    "INVALID_TYPE_ID",
    "INVALID_TOPIC_ID",
    "TOO_MANY_ACTIONS",
    "UNKNOWN_FINDING",
    "DUPLICATE_FINDING_ACTION",
  ]);
});
