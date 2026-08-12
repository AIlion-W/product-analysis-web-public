import assert from "node:assert/strict";
import test from "node:test";

import { TAXONOMY, TOPICS } from "../lib/neigong/catalog.ts";
import {
  buildReportData,
  buildSynthesisFacts,
} from "../lib/neigong/report-builder.ts";
import { validateEvidenceGraph } from "../lib/neigong/rules.ts";
import { getNeigongInstructions } from "../lib/neigong/server/prompts.ts";

const DIMENSIONS = ["persona", "scene", "painPoint", "detail", "effect", "delight"];

function rowId(productId, kind, rank) {
  return `${productId}-${kind}-${rank}`;
}

function review(productId, sort, rank) {
  const text = `${productId}-${sort}-评价-${rank}`;
  return {
    rowId: rowId(productId, sort, rank),
    sourceId: `${productId}:${sort}_reviews`,
    sourceRow: rank + 1,
    productId,
    sort,
    rank,
    date: "2026-08-11",
    sku: "",
    initialText: text,
    followupText: "",
    normalizedText: text,
  };
}

function question(productId, rank) {
  const text = `${productId}-问题-${rank}`;
  return {
    rowId: rowId(productId, "question", rank),
    sourceId: `${productId}:questions`,
    sourceRow: rank + 1,
    productId,
    rank,
    questionText: text,
    answer: "回答",
    date: "2026-08-11",
    normalizedText: text,
  };
}

function statusFor(count) {
  if (count === 0) return "missing";
  if (count < 90) return "insufficient";
  if (count < 100) return "provisional";
  return "complete";
}

function source(productId, kind, count, excludedOverLimit = 0) {
  return {
    sourceId: `${productId}:${kind}`,
    productId,
    kind,
    rowsRead: count + excludedOverLimit,
    validRows: count + excludedOverLimit,
    usedRows: count,
    excludedRows: excludedOverLimit,
    excludedOverLimit,
    status: statusFor(count),
    note: "fixture",
  };
}

function pack({
  productId,
  role,
  defaults = 100,
  recent = 100,
  questions = 100,
  screenshot = "ready",
  errors = [],
  warnings = [],
  excludedRows = [],
}) {
  return {
    product: { productId, role, name: role === "self" ? "我方产品" : productId },
    reviews: [
      ...Array.from({ length: defaults }, (_, index) => review(productId, "default", index + 1)),
      ...Array.from({ length: recent }, (_, index) => review(productId, "recent", index + 1)),
    ],
    questions: Array.from({ length: questions }, (_, index) => question(productId, index + 1)),
    sources: [
      source(productId, "default_reviews", defaults),
      source(productId, "recent_reviews", recent),
      source(productId, "questions", questions),
    ],
    sourceMappings: [],
    ...(screenshot === "ready"
      ? { screenshot: { sourceId: `${productId}:review_tags`, status: "ready", file: new File(["x"], `${productId}.png`, { type: "image/png" }) } }
      : {}),
    excludedRows,
    errors,
    warnings: screenshot === "missing"
      ? [...warnings, { code: "MISSING_SCREENSHOT_FILE", message: "缺少评价标签截图。" }]
      : warnings,
  };
}

function result(task, requestId, output, overrides = {}) {
  return { task, requestId, output, errors: [], warnings: [], ...overrides };
}

function resultsFor(packs, { screenshots = true } = {}) {
  const results = {};
  for (const item of packs) {
    const productId = item.product.productId;
    const reviewLabels = item.reviews.map((row, index) => ({
      rowId: row.rowId,
      typeId: index % 3 === 0 ? "t2" : "t1",
      evidenceSource: "initial",
      evidenceQuote: row.initialText,
    }));
    const questionLabels = item.questions.map((row) => ({
      rowId: row.rowId,
      topicId: "q1",
      topicEvidence: row.questionText,
    }));
    const top20Rows = item.reviews
      .filter((row) => row.sort === "default")
      .slice(0, 20)
      .map((row, index) => ({
        rowId: row.rowId,
        dimensions: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, dimension === "effect" || (dimension === "painPoint" && index < 5)])),
        evidence: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, dimension === "effect" || (dimension === "painPoint" && index < 5) ? row.initialText : ""])),
        score: index < 5 ? 2 : 1,
        note: "",
      }));

    results[`review-taxonomy:${productId}:all`] = result(
      "review-taxonomy",
      `review-taxonomy:${productId}:all`,
      { labels: reviewLabels },
    );
    results[`question-topic:${productId}:all`] = result(
      "question-topic",
      `question-topic:${productId}:all`,
      { labels: questionLabels },
    );
    if (top20Rows.length) {
      results[`top20-dimensions:${productId}`] = result(
        "top20-dimensions",
        `top20-dimensions:${productId}`,
        { rows: top20Rows },
      );
    }
    if (screenshots && item.screenshot?.status === "ready") {
      results[`screenshot-metadata:${productId}`] = result(
        "screenshot-metadata",
        `screenshot-metadata:${productId}`,
        {
          productName: item.product.name,
          reviewTotal: "1万+",
          questionTotal: "100+",
          tags: [{ tag: "去屑", count: 37 }],
          completeness: "complete",
        },
      );
    }
  }
  return results;
}

function synthesisFor(facts, overrides = {}) {
  const findings = facts.readiness.map((readiness) => ({
    id: readiness.findingId,
    status: readiness.status,
    evidenceIds: readiness.evidenceIds,
  }));
  return {
    findings,
    ...overrides,
  };
}

function fixture(options = {}) {
  const own = pack({
    productId: "own",
    role: "self",
    defaults: options.ownDefault ?? 100,
    recent: options.ownRecent ?? 100,
    questions: options.ownQuestions ?? 100,
    screenshot: options.ownScreenshot ?? "ready",
    errors: options.errors ?? [],
    warnings: options.warnings ?? [],
    excludedRows: options.excludedRows ?? [],
  });
  const competitors = options.competitors === undefined
    ? [pack({ productId: "rival", role: "competitor" })]
    : options.competitors;
  const packs = [own, ...competitors];
  const results = resultsFor(packs, { screenshots: options.screenshots !== false });
  const facts = buildSynthesisFacts({ packs, results });
  return {
    packs,
    results,
    synthesis: synthesisFor(facts, options.synthesisOverrides),
    generatedAt: "2026-08-11T00:00:00.000Z",
  };
}

test("89 条默认评价保留逐条结果但 F02 unavailable", () => {
  const report = buildReportData(fixture({ ownDefault: 89, ownRecent: 100, ownQuestions: 100 }));

  assert.equal(report.meta.completeness.find(({ kind }) => kind === "self_default_reviews").status, "insufficient");
  assert.equal(report.findings.find(({ id }) => id === "F02").status, "unavailable");
  assert.match(report.findings.find(({ id }) => id === "F02").evidenceIds[0], /^DATA-/);
  assert.equal(report.top20.length >= 20, true);
  assert.equal(report.meta.validation.valid, true);
});

test("无竞品时 F03 明说只有我方诊断", () => {
  const report = buildReportData(fixture({ competitors: [] }));

  assert.match(report.findings.find(({ id }) => id === "F03").text, /未上传竞品/);
});

test("即使绕过 API 夹带模型自由文本也不能进入正式报告", () => {
  const input = fixture({ competitors: [] });
  input.synthesis.findings = input.synthesis.findings.map((finding) => ({
    ...finding,
    title: "领先优势 999 条",
    text: "我方有 999 条评价，整体更好且优势明显。",
  }));
  input.synthesis.actions = [{ action: "放大领先优势 999 倍", reason: "因为整体更好 999%" }];
  const report = buildReportData(input);
  const prose = JSON.stringify({ findings: report.findings, actions: report.actions });

  assert.doesNotMatch(prose, /999|优势|领先|更好/);
  assert.match(report.findings.find(({ id }) => id === "F01").text, /默认排序|时间排序/);
});

test("正式 action 只用代码模板，安全文本、动作绕过词和零宽字符均不进入报告", () => {
  const input = fixture({ competitors: [] });
  input.synthesis.actions = [
    { priority: "P0", action: "无害文本也不能进入", reason: "自由原因不能进入", findingIds: ["F01"] },
    { priority: "P1", action: "放大冠\u200B军表现", reason: "维持更\u200B佳结论", findingIds: ["F02"] },
    { priority: "P2", action: "风险为零\u200B且继续领\u200B先", reason: "No.999 优\u200B势", findingIds: ["F03"] },
  ];

  const report = buildReportData(input);
  assert.deepEqual(report.actions.map(({ action }) => action), [
    "优化邀评问题与六维内容引导",
    "围绕高频问题补充问答与详情页证据",
  ]);
  const prose = JSON.stringify(report.actions).replace(/[\u200B-\u200D\uFEFF]/gu, "");
  assert.doesNotMatch(prose, /无害文本|自由原因|冠军|更佳|领先|优势|999/);
  assert.ok(report.actions.every(({ reason }) => /^(?:F01|F02|F03)｜(?:AGG|DATA)-/.test(reason)));
});

test("synthesis prompt 同样禁止模型生成数字结论和优势总结", () => {
  const instructions = getNeigongInstructions("synthesis");

  assert.match(instructions, /只能返回 id、status、evidenceIds/);
  assert.match(instructions, /禁止返回 title、text、action、reason/);
  assert.match(instructions, /不得输出优势、领先、更好或亮点总结/);
});

test("F02 仅在每产品默认评价至少 20 条时保留六维明细，90 条才 available", () => {
  const cases = [
    { count: 19, top20: 0, dimensions: 0, status: "unavailable" },
    { count: 20, top20: 20, dimensions: 6, status: "unavailable" },
    { count: 89, top20: 20, dimensions: 6, status: "unavailable" },
    { count: 90, top20: 20, dimensions: 6, status: "available" },
  ];

  for (const expected of cases) {
    const report = buildReportData(fixture({ ownDefault: expected.count, competitors: [] }));
    assert.equal(report.top20.length, expected.top20, `default=${expected.count}`);
    assert.equal(report.aggregates.dimensions.filter(({ productId }) => productId === "own").length, expected.dimensions, `default=${expected.count}`);
    assert.equal(report.findings.find(({ id }) => id === "F02").status, expected.status, `default=${expected.count}`);
  }
});

test("F01 全部类型占比差为零时不制造诊断问题", () => {
  const input = fixture({ competitors: [] });
  const reviewResult = input.results["review-taxonomy:own:all"];
  reviewResult.output = {
    labels: reviewResult.output.labels.map((label) => ({ ...label, typeId: "t1" })),
  };

  const report = buildReportData(input);
  const finding = report.findings.find(({ id }) => id === "F01");
  assert.equal(finding.status, "available");
  assert.equal(finding.hasProblem, false);
  assert.equal(finding.problemCode, null);
  assert.equal(finding.title, "未发现可证明的评价展示倾向问题");
  assert.match(finding.text, /当前数据未形成可证明的问题/);
  assert.doesNotMatch(finding.text, /差异最大的诊断问题/);
  assert.equal(report.actions.some(({ findingIds }) => findingIds.includes("F01")), false);
});

test("F02 六维全部百分之百覆盖时不称为内容缺口", () => {
  const input = fixture({ competitors: [] });
  const top20Result = input.results["top20-dimensions:own"];
  top20Result.output = {
    rows: top20Result.output.rows.map((row) => ({
      ...row,
      dimensions: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, true])),
      evidence: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, row.rowId])),
      score: 6,
    })),
  };

  const report = buildReportData(input);
  const finding = report.findings.find(({ id }) => id === "F02");
  assert.equal(finding.status, "available");
  assert.equal(finding.hasProblem, false);
  assert.equal(finding.problemCode, null);
  assert.equal(finding.title, "未发现可证明的六维内容问题");
  assert.match(finding.text, /当前数据未形成需跟进的覆盖信号/);
  assert.doesNotMatch(finding.text, /内容缺口/);
  assert.equal(report.actions.some(({ findingIds }) => findingIds.includes("F02")), false);
});

test("F02 与 F03 的关注线只形成运营信号，不夸大为已证明的业务缺口", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  const f02 = report.findings.find(({ id }) => id === "F02");
  const f03 = report.findings.find(({ id }) => id === "F03");
  const f02Action = report.actions.find(({ findingIds }) => findingIds.includes("F02"));
  const f03Action = report.actions.find(({ findingIds }) => findingIds.includes("F03"));

  assert.equal(f02.title, "默认评价六维覆盖信号");
  assert.match(f02.text, /观察线.*评价内容覆盖信号.*不等同于产品缺陷/);
  assert.doesNotMatch(f02.text, /形成六维内容缺口/);
  assert.equal(f02Action.action, "优化邀评问题与六维内容引导");
  assert.match(f02Action.reason, /按六维覆盖信号优化邀评问题与内容引导/);

  assert.equal(f03.title, "问大家高频决策主题");
  assert.match(f03.text, /集中观察线.*高频决策关注点.*不直接证明信息缺口/);
  assert.doesNotMatch(f03.text, /形成购买决策信息缺口/);
  assert.equal(f03Action.action, "围绕高频问题补充问答与详情页证据");
  assert.match(f03Action.reason, /按问大家高频主题补充决策信息证据/);
});

test("截图 missing 降级但不阻断报告，原始错误、警告和排除行不丢失", () => {
  const excluded = [{ rowId: "own-default-101", sourceId: "own:default_reviews", reason: "OVER_LIMIT" }];
  const report = buildReportData(fixture({
    ownScreenshot: "missing",
    screenshots: false,
    errors: [{ code: "SOURCE_NOTE", message: "保留错误" }],
    warnings: [{ code: "SOURCE_WARNING", message: "保留警告" }],
    excludedRows: excluded,
  }));

  assert.deepEqual(report.reviewTags, []);
  assert.ok(report.errors.some(({ code }) => code === "SOURCE_NOTE"));
  assert.ok(report.warnings.some(({ code }) => code === "SOURCE_WARNING"));
  assert.ok(report.warnings.some(({ code }) => code === "MISSING_SCREENSHOT_FILE"));
  assert.deepEqual(report.excludedRows, excluded);
  assert.equal(report.legacy.enabled, false);
});

test("F03 排除问题不足的单个竞品但保留其他合格竞品", () => {
  const weak = pack({ productId: "weak", role: "competitor", questions: 89 });
  const strong = pack({ productId: "strong", role: "competitor", questions: 100 });
  const input = fixture({ competitors: [weak, strong] });
  const report = buildReportData(input);
  const f03 = report.findings.find(({ id }) => id === "F03");

  assert.ok(report.products.some(({ productId }) => productId === "weak"));
  assert.ok(report.products.some(({ productId }) => productId === "strong"));
  assert.equal(f03.evidenceIds.some((id) => id.includes("weak")), false);
  assert.equal(f03.evidenceIds.some((id) => id.includes("strong")), true);
});

test("已上传竞品但问大家全部不合格时只做我方诊断", () => {
  const weak = pack({ productId: "weak", role: "competitor", questions: 89 });
  const report = buildReportData(fixture({ competitors: [weak] }));
  const finding = report.findings.find(({ id }) => id === "F03");

  assert.match(finding.text, /竞品问大家均未达到 90 条，本分区只做我方诊断/);
  assert.equal(finding.evidenceIds.some((evidenceId) => evidenceId.includes("weak")), false);
});

test("F03 问题主题均匀分布时不制造决策信息缺口", () => {
  const input = fixture({ competitors: [] });
  const questionResult = input.results["question-topic:own:all"];
  questionResult.output = {
    labels: questionResult.output.labels.map((label, index) => ({ ...label, topicId: `q${(index % 8) + 1}` })),
  };

  const report = buildReportData(input);
  const finding = report.findings.find(({ id }) => id === "F03");
  assert.equal(finding.status, "available");
  assert.equal(finding.hasProblem, false);
  assert.equal(finding.problemCode, null);
  assert.equal(finding.title, "未发现可证明的问大家决策问题");
  assert.match(finding.text, /最高主题占比.*低于 30\.0%.*当前未形成需跟进的高频主题信号/);
  assert.doesNotMatch(finding.text, /形成购买决策信息缺口/);
  assert.equal(report.actions.some(({ findingIds }) => findingIds.includes("F03")), false);
});

test("三个 unavailable finding 使用中性标题且只生成对应补数据 action", () => {
  const report = buildReportData(fixture({ competitors: [], ownDefault: 19, ownRecent: 89, ownQuestions: 89 }));

  assert.deepEqual(report.findings.map(({ id, status, hasProblem, problemCode, title }) => ({ id, status, hasProblem, problemCode, title })), [
    { id: "F01", status: "unavailable", hasProblem: false, problemCode: null, title: "评价展示数据不足" },
    { id: "F02", status: "unavailable", hasProblem: false, problemCode: null, title: "六维诊断数据不足" },
    { id: "F03", status: "unavailable", hasProblem: false, problemCode: null, title: "问大家诊断数据不足" },
  ]);
  assert.deepEqual(report.actions.map(({ action, priority, findingIds }) => ({ action, priority, findingIds })), [
    { action: "补齐默认与时间排序评价数据", priority: "P0", findingIds: ["F01"] },
    { action: "补齐默认排序评价数据", priority: "P0", findingIds: ["F02"] },
    { action: "补齐问大家数据", priority: "P0", findingIds: ["F03"] },
  ]);
});

test("F03 unavailable 且已上传竞品均不合格时补齐我方与可比竞品数据", () => {
  const weak = pack({ productId: "weak", role: "competitor", questions: 89 });
  const report = buildReportData(fixture({ competitors: [weak], ownQuestions: 89 }));
  const finding = report.findings.find(({ id }) => id === "F03");
  const action = report.actions.find(({ findingIds }) => findingIds.includes("F03"));

  assert.deepEqual(finding.evidenceIds, ["DATA-own-self_questions", "DATA-weak-competitor_questions"]);
  assert.equal(action.action, "补齐我方问大家与可比竞品数据");
  assert.equal(action.priority, "P0");
  assert.deepEqual(action.evidenceIds, finding.evidenceIds);
  assert.match(action.reason, /DATA-own-self_questions.*DATA-weak-competitor_questions/);
});

test("F03 unavailable 只补我方时不引用已合格竞品 DATA", () => {
  const strong = pack({ productId: "strong", role: "competitor", questions: 100 });
  const report = buildReportData(fixture({ competitors: [strong], ownQuestions: 89 }));
  const finding = report.findings.find(({ id }) => id === "F03");
  const action = report.actions.find(({ findingIds }) => findingIds.includes("F03"));

  assert.deepEqual(finding.evidenceIds, ["DATA-own-self_questions"]);
  assert.equal(action.action, "补齐问大家数据");
  assert.deepEqual(action.evidenceIds, finding.evidenceIds);
});

test("达到异常阈值的 available finding 才标记 problemCode 并生成整改 action", () => {
  const input = fixture({ competitors: [] });
  const reviewResult = input.results["review-taxonomy:own:all"];
  reviewResult.output = {
    labels: reviewResult.output.labels.map((label) => ({
      ...label,
      typeId: label.rowId.includes("-default-") ? "t1" : "t2",
    })),
  };
  const report = buildReportData(input);
  const finding = report.findings.find(({ id }) => id === "F01");

  assert.equal(finding.status, "available");
  assert.equal(finding.hasProblem, true);
  assert.equal(finding.problemCode, "F01_DISPLAY_SHARE_GAP");
  assert.equal(finding.title, "评价展示倾向问题");
  assert.deepEqual(report.actions.filter(({ findingIds }) => findingIds.includes("F01")).map(({ action }) => action), ["校正评价展示内容结构"]);
});

test("即使绕过 API 夹带模型 action 也不影响代码每个 finding 最多生成一条 action", () => {
  const input = fixture({ competitors: [] });
  input.synthesis.actions = Array.from({ length: 40 }, () => ({
    priority: "P0",
    action: "重复自由文本",
    reason: "重复自由原因",
    findingIds: ["F02"],
  }));
  const report = buildReportData(input);

  assert.equal(report.actions.length, 2);
  assert.deepEqual(report.actions.map(({ findingIds }) => findingIds), [["F02"], ["F03"]]);
  assert.equal(new Set(report.actions.map(({ findingIds }) => findingIds[0])).size, report.actions.length);
});

test("聚合数值从逐条标签重算且 actions 由 finding 状态确定性生成", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  const ownT2 = report.aggregates.taxonomy.find(({ productId, typeId }) => productId === "own" && typeId === "t2");

  assert.equal(ownT2.defaultCount, 34);
  assert.equal(ownT2.recentCount, 33);
  assert.equal(report.actions.length, 2);
  assert.equal(report.legacy.enabled, false);
});

test("synthesis 非法证据降级后仍因 readiness 不一致而失败关闭", () => {
  const input = fixture({ competitors: [] });
  input.synthesis.findings = input.synthesis.findings.map((finding) => finding.id === "F01"
    ? { ...finding, evidenceIds: ["DATA-own-self_default_reviews"] }
    : finding);

  assert.throws(
    () => buildReportData(input),
    (error) => error.code === "REPORT_VALIDATION_FAILED" && error.validationErrors.some(({ code }) => code === "READINESS_MISMATCH"),
  );
});

test("DATA completeness 必须与 sources 一一对账，拒绝伪造、重复、漂移和未知 source", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  const completeness = report.meta.completeness;
  const mutations = [
    { ...report, meta: { ...report.meta, completeness: [...completeness, completeness[0]] } },
    { ...report, meta: { ...report.meta, completeness: completeness.map((entry, index) => index === 0 ? { ...entry, evidenceId: "DATA-forged" } : entry) } },
    { ...report, meta: { ...report.meta, completeness: completeness.map((entry, index) => index === 0 ? { ...entry, usedRows: entry.usedRows - 1 } : entry) } },
    { ...report, meta: { ...report.meta, completeness: completeness.map((entry, index) => index === 0 ? { ...entry, sourceIds: ["unknown:source"] } : entry) } },
  ];

  for (const mutation of mutations) {
    const validation = validateEvidenceGraph(mutation);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(({ code }) => code === "COMPLETENESS_MISMATCH"));
  }
});

test("同时篡改 source 与 completeness 也不能伪造使用行数", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  const target = report.sources[0];
  const forgedSources = report.sources.map((sourceEntry) => sourceEntry.sourceId === target.sourceId
    ? { ...sourceEntry, usedRows: 1, validRows: 1, status: "insufficient" }
    : sourceEntry);
  const forgedCompleteness = report.meta.completeness.map((entry) => entry.sourceIds.includes(target.sourceId)
    ? { ...entry, usedRows: 1, validRows: 1, status: "insufficient", blocking: true }
    : entry);
  const validation = validateEvidenceGraph({
    ...report,
    sources: forgedSources,
    meta: { ...report.meta, completeness: forgedCompleteness },
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(({ code }) => code === "COMPLETENESS_MISMATCH"));
});

test("已排除产品的陈旧成功结果不会污染当前报告", () => {
  const full = fixture();
  const packs = full.packs.filter((item) => item.product.role === "self");
  const facts = buildSynthesisFacts({ packs, results: full.results });
  const report = buildReportData({
    packs,
    results: full.results,
    synthesis: synthesisFor(facts),
    generatedAt: full.generatedAt,
  });

  assert.deepEqual(report.products.map(({ productId }) => productId), ["own"]);
  assert.equal(report.errors.some(({ code }) => code === "MODEL_ROW_REJECTED"), false);
});

test("finding family 门禁拒绝 available 仅 DATA 和 unavailable 无 DATA", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  const availableOnlyData = {
    ...report,
    findings: report.findings.map((finding) => finding.id === "F01"
      ? { ...finding, status: "available", evidenceIds: [report.meta.completeness[0].evidenceId] }
      : finding),
    actions: [],
  };
  const unavailableWithoutData = {
    ...report,
    findings: report.findings.map((finding) => finding.id === "F02"
      ? { ...finding, status: "unavailable", evidenceIds: [report.aggregates.dimensions[0].evidenceId] }
      : finding),
    actions: [],
  };

  assert.ok(validateEvidenceGraph(availableOnlyData).errors.some(({ code }) => code === "INVALID_FINDING_EVIDENCE"));
  assert.ok(validateEvidenceGraph(unavailableWithoutData).errors.some(({ code }) => code === "INVALID_FINDING_EVIDENCE"));
});

test("F03 available 必须引用我方问题聚合，竞品证据不能单独冒充", () => {
  const report = buildReportData(fixture());
  const ownEvidence = report.aggregates.topics.filter(({ productId }) => productId === "own").map(({ evidenceId }) => evidenceId);
  const rivalEvidence = report.aggregates.topics.filter(({ productId }) => productId === "rival").map(({ evidenceId }) => evidenceId);
  const f03 = report.findings.find(({ id }) => id === "F03");

  assert.ok(f03.evidenceIds.some((id) => ownEvidence.includes(id)));
  assert.ok(f03.evidenceIds.some((id) => rivalEvidence.includes(id)));
  const validation = validateEvidenceGraph({
    ...report,
    findings: report.findings.map((finding) => finding.id === "F03"
      ? { ...finding, evidenceIds: rivalEvidence }
      : finding),
    actions: [],
  });
  assert.ok(validation.errors.some(({ code }) => code === "INVALID_FINDING_EVIDENCE"));
});

test("最终门禁从 rows 重算 readiness 并拒绝 meta 或 finding status 漂移", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  const metaDrift = {
    ...report,
    meta: {
      ...report.meta,
      analysisReadiness: report.meta.analysisReadiness.map((entry) => entry.findingId === "F01"
        ? { ...entry, status: "unavailable" }
        : entry),
    },
    actions: [],
  };
  const findingDrift = {
    ...report,
    findings: report.findings.map((finding) => finding.id === "F01"
      ? { ...finding, status: "unavailable", evidenceIds: [report.meta.completeness[0].evidenceId] }
      : finding),
    actions: [],
  };

  assert.ok(validateEvidenceGraph(metaDrift).errors.some(({ code }) => code === "READINESS_MISMATCH"));
  assert.ok(validateEvidenceGraph(findingDrift).errors.some(({ code }) => code === "READINESS_MISMATCH"));
});

test("最终门禁从 canonical 聚合独立重算 hasProblem 和 problemCode", () => {
  const unavailable = buildReportData(fixture({ competitors: [], ownDefault: 19, ownRecent: 89, ownQuestions: 89 }));
  const noProblemInput = fixture({ competitors: [] });
  noProblemInput.results["review-taxonomy:own:all"].output = {
    labels: noProblemInput.results["review-taxonomy:own:all"].output.labels.map((label) => ({ ...label, typeId: "t1" })),
  };
  const noProblem = buildReportData(noProblemInput);
  const problemInput = fixture({ competitors: [] });
  problemInput.results["review-taxonomy:own:all"].output = {
    labels: problemInput.results["review-taxonomy:own:all"].output.labels.map((label) => ({
      ...label,
      typeId: label.rowId.includes("-default-") ? "t1" : "t2",
    })),
  };
  const hasProblem = buildReportData(problemInput);
  const mutateF01 = (report, patch) => ({
    ...report,
    findings: report.findings.map((finding) => finding.id === "F01" ? { ...finding, ...patch } : finding),
    actions: [],
  });
  const attacks = [
    mutateF01(unavailable, { hasProblem: true, problemCode: "F01_DISPLAY_SHARE_GAP" }),
    mutateF01(unavailable, { hasProblem: false, problemCode: "F01_DISPLAY_SHARE_GAP" }),
    mutateF01(noProblem, { hasProblem: true, problemCode: "F01_DISPLAY_SHARE_GAP" }),
    mutateF01(hasProblem, { hasProblem: false, problemCode: null }),
    mutateF01(hasProblem, { hasProblem: true, problemCode: "F02_DIMENSION_COVERAGE_GAP" }),
  ];

  assert.equal(validateEvidenceGraph(unavailable).valid, true);
  assert.equal(validateEvidenceGraph(noProblem).valid, true);
  assert.equal(validateEvidenceGraph(hasProblem).valid, true);
  for (const attack of attacks) {
    const validation = validateEvidenceGraph(attack);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(({ code }) => code === "DIAGNOSIS_MISMATCH"));
  }
});

test("最终门禁拒绝同一 finding 的重复 action", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  const duplicated = {
    ...report,
    actions: [...report.actions, { ...report.actions[0], actionId: "A99" }],
  };
  const validation = validateEvidenceGraph(duplicated);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(({ code }) => code === "DUPLICATE_FINDING_ACTION"));
});

test("每个产品必须保留 review sources，不能同时清空 sources 与 completeness", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  const validation = validateEvidenceGraph({
    ...report,
    sources: [],
    meta: { ...report.meta, completeness: [] },
    actions: [],
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(({ code }) => code === "MISSING_REQUIRED_SOURCE"));
});

test("问大家为零行也必须保留唯一 questions source 和 completeness", () => {
  const report = buildReportData(fixture({ competitors: [], ownQuestions: 0 }));
  assert.ok(report.sources.some(({ productId, kind }) => productId === "own" && kind === "questions"));
  assert.ok(report.meta.completeness.some(({ productId, kind, usedRows }) => productId === "own" && kind === "self_questions" && usedRows === 0));

  const validation = validateEvidenceGraph({
    ...report,
    sources: report.sources.filter(({ kind }) => kind !== "questions"),
    meta: {
      ...report.meta,
      completeness: report.meta.completeness.filter(({ kind }) => kind !== "self_questions"),
    },
    actions: [],
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(({ code }) => code === "MISSING_REQUIRED_SOURCE"));
});

test("逐条与排除行 sourceId 必须存在并匹配 product 和 kind", () => {
  const report = buildReportData(fixture({
    competitors: [],
    excludedRows: [{ rowId: "own:default_reviews:101", sourceId: "own:default_reviews", reason: "OVER_LIMIT" }],
  }));
  const mutations = [
    { ...report, reviews: report.reviews.map((row, index) => index === 0 ? { ...row, sourceId: "unknown:source" } : row), actions: [] },
    { ...report, reviews: report.reviews.map((row, index) => index === 0 ? { ...row, sourceId: "own:recent_reviews" } : row), actions: [] },
    { ...report, questions: report.questions.map((row, index) => index === 0 ? { ...row, sourceId: "own:default_reviews" } : row), actions: [] },
    { ...report, excludedRows: report.excludedRows.map((row) => ({ ...row, sourceId: "unknown:source" })), actions: [] },
  ];

  for (const mutation of mutations) {
    const validation = validateEvidenceGraph(mutation);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(({ code }) => code === "SOURCE_ANCHOR_MISMATCH"));
  }
});

test("截图 partial/missing 写 warning，重复标签按产品与名称合并", () => {
  for (const completeness of ["partial", "missing"]) {
    const input = fixture({ competitors: [] });
    const screenshot = input.results["screenshot-metadata:own"];
    screenshot.output = {
      ...screenshot.output,
      completeness,
      tags: [{ tag: "去屑", count: 12 }, { tag: "去屑", count: 8 }],
    };
    const report = buildReportData(input);

    assert.deepEqual(report.reviewTags, [{ sourceId: "own:review_tags", productId: "own", name: "去屑", count: 20 }]);
    assert.ok(report.warnings.some(({ code }) => code === `SCREENSHOT_METADATA_${completeness.toUpperCase()}`));
  }
});

test("固定目录仍由最终门禁校验", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  assert.deepEqual(report.taxonomy, TAXONOMY);
  assert.deepEqual(report.topics, TOPICS);
  assert.equal(validateEvidenceGraph({ ...report, taxonomy: TAXONOMY.slice(1) }).valid, false);
});
