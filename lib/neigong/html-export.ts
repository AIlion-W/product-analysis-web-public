import type { ReportData } from "./types";
// Node executes this source TypeScript directly in behavioral contract tests.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import {
  businessActionReason,
  dimensionLabel,
  formatGeneratedAt,
  questionSectionTitle,
  reportPresentationMetrics,
  sourceKindLabel,
  statusLabel,
} from "./report-presentation.ts";
// Node executes this source TypeScript directly in contract tests.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { validateEvidenceGraph } from "./rules.ts";

function assertValidatedReport(report: ReportData): void {
  const validation = validateEvidenceGraph(report);
  if (validation.valid) return;
  const first = validation.errors[0];
  throw new Error(`REPORT_NOT_VALIDATED：${first?.code ?? "UNKNOWN"}：${first?.message ?? "报告证据图校验失败。"}`);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function strings(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
}

function exportableReport(report: ReportData) {
  return {
    meta: {
      generatedAt: text(report.meta.generatedAt),
      completeness: report.meta.completeness.map((entry) => ({
        evidenceId: text(entry.evidenceId),
        productId: text(entry.productId),
        kind: text(entry.kind),
        expectedRows: number(entry.expectedRows),
        validRows: number(entry.validRows),
        usedRows: number(entry.usedRows),
        excludedOverLimit: number(entry.excludedOverLimit),
        status: text(entry.status),
        blocking: boolean(entry.blocking),
      })),
    },
    products: report.products.map((product) => ({
      productId: text(product.productId),
      role: text(product.role),
      name: text(product.name),
    })),
    taxonomy: report.taxonomy.map((entry) => ({ id: text(entry.id), name: text(entry.name) })),
    topics: report.topics.map((entry) => ({ id: text(entry.id), name: text(entry.name) })),
    questions: report.questions.map((question) => ({ productId: text(question.productId) })),
    reviewTags: report.reviewTags.map((tag) => ({
      sourceId: text(tag.sourceId),
      productId: text(tag.productId),
      name: text(tag.name),
      count: number(tag.count),
    })),
    errors: report.errors.map((entry) => ({ code: text(entry.code), message: text(entry.message) })),
    warnings: report.warnings.map((entry) => ({ code: text(entry.code), message: text(entry.message) })),
    excludedRows: report.excludedRows.map((entry) => ({
      rowId: text(entry.rowId),
      sourceId: text(entry.sourceId),
      reason: text(entry.reason),
    })),
    aggregates: {
      taxonomy: report.aggregates.taxonomy.map((entry) => ({
        productId: text(entry.productId),
        typeId: text(entry.typeId),
        defaultCount: number(entry.defaultCount),
        defaultShare: number(entry.defaultShare),
        recentCount: number(entry.recentCount),
        recentShare: number(entry.recentShare),
        difference: number(entry.difference),
        evidenceId: text(entry.evidenceId),
      })),
      dimensions: report.aggregates.dimensions.map((entry) => ({
        productId: text(entry.productId),
        dimension: text(entry.dimension),
        hitCount: number(entry.hitCount),
        totalCount: number(entry.totalCount),
        coverage: number(entry.coverage),
        evidenceId: text(entry.evidenceId),
      })),
      topics: report.aggregates.topics.map((entry) => ({
        productId: text(entry.productId),
        topicId: text(entry.topicId),
        count: number(entry.count),
        share: number(entry.share),
        representativeQuestionIds: strings(entry.representativeQuestionIds),
        evidenceId: text(entry.evidenceId),
      })),
    },
    findings: report.findings.map((finding) => ({
      findingId: text(finding.findingId),
      status: text(finding.status),
      title: text(finding.title),
      detail: text(finding.detail),
      evidenceIds: strings(finding.evidenceIds),
    })),
    actions: report.actions.map((action) => ({
      actionId: text(action.actionId),
      priority: text(action.priority),
      action: text(action.action),
      reason: text(action.reason),
      findingIds: strings(action.findingIds ?? (action.findingId ? [action.findingId] : [])),
      evidenceIds: strings(action.evidenceIds ?? (action.evidenceId ? [action.evidenceId] : [])),
    })),
  };
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/[\u2028\u2029]/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#x27;");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function table(headers: string[], rows: Array<Array<string | number>>): string {
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("");
  return `<div class="scroll" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function empty(message: string): string {
  return `<div class="empty" role="status"><strong>数据不足</strong><span>具体缺口：${escapeHtml(message)}</span></div>`;
}

function auditDetails(lines: string[]): string {
  const content = lines.filter(Boolean).map((line) => `<code>${escapeHtml(line)}</code>`).join("");
  return `<details class="neigong-report-audit"><summary>查看审计证据</summary>${content || "<span>无审计编号</span>"}</details>`;
}

function section(number: string, title: string, body: string): string {
  return `<section class="section"><h2><span>${number}</span>${escapeHtml(title)}</h2>${body}</section>`;
}

export function buildNeigongHtml(report: ReportData): string {
  assertValidatedReport(report);
  const metrics = reportPresentationMetrics(report);
  const productNames = new Map(report.products.map((product) => [product.productId, product.name]));
  const taxonomyNames = new Map(report.taxonomy.map((entry) => [entry.id, entry.name]));
  const topicNames = new Map(report.topics.map((entry) => [entry.id, entry.name]));
  const questionCounts = new Map<string, number>();
  for (const question of report.questions) {
    questionCounts.set(question.productId, (questionCounts.get(question.productId) ?? 0) + 1);
  }
  const eligibleQuestionProducts = new Set(report.products
    .filter((product) => product.role === "self" || (questionCounts.get(product.productId) ?? 0) >= 90)
    .map((product) => product.productId));
  const excludedQuestionProducts = report.products.filter(
    (product) => product.role === "competitor" && !eligibleQuestionProducts.has(product.productId),
  );
  const finding = (findingId: string) => report.findings.find((entry) => entry.findingId === findingId);
  const usedRowsDetail = metrics.usedRows.map((entry) => `${escapeHtml(entry.label)} ${entry.usedRows} 行`).join("；");
  const totalUsedRows = metrics.usedRows.reduce((total, entry) => total + entry.usedRows, 0);

  const completenessBody = report.meta.completeness.length
    ? table(
      ["产品", "来源", "有效／使用", "超限排除", "状态"],
      report.meta.completeness.map((entry) => [
        productNames.get(entry.productId) ?? entry.productId,
        sourceKindLabel(entry.kind),
        `${entry.validRows}／${entry.usedRows}（目标 ${entry.expectedRows}）`,
        entry.excludedOverLimit,
        statusLabel(entry.status),
      ]),
    )
    : empty("没有可对账的产品来源。");
  const tags = report.reviewTags.length
    ? `<div class="tags" aria-label="截图评价标签">${report.reviewTags.map((tag) => `<span>${escapeHtml(productNames.get(tag.productId) ?? tag.productId)} · ${escapeHtml(tag.name)} ${escapeHtml(tag.count)}</span>`).join("")}</div>`
    : empty("评价页截图缺失、识别失败，或标签数量不可核验。");
  const auditCount = report.errors.length || report.warnings.length || report.excludedRows.length
    ? `<div class="audit-note"><strong>审计记录</strong><p>错误 ${report.errors.length} 条，警告 ${report.warnings.length} 条，排除行 ${report.excludedRows.length} 条。</p></div>`
    : "";
  const auditMessages = [
    ...report.errors.map((entry) => `错误 ${entry.code}：${entry.message}`),
    ...report.warnings.map((entry) => `警告 ${entry.code}：${entry.message}`),
    ...report.excludedRows.map((entry) => `排除 ${entry.rowId}：${entry.reason}`),
    ...report.meta.completeness.map((entry) => entry.evidenceId),
  ];
  const section1 = section("01", "数据完整性与产品对照", completenessBody + tags + auditCount + auditDetails(auditMessages));

  const f01 = finding("F01");
  const taxonomyBody = `${f01?.status === "unavailable" ? empty(f01.detail) : ""}${report.aggregates.taxonomy.length
    ? table(
      ["产品", "评价类型", "默认排序", "时间排序", "占比差（时间排序－默认排序）"],
      report.aggregates.taxonomy.map((entry) => [
        productNames.get(entry.productId) ?? entry.productId,
        taxonomyNames.get(entry.typeId) ?? entry.typeId,
        `${entry.defaultCount}（${percent(entry.defaultShare)}）`,
        `${entry.recentCount}（${percent(entry.recentShare)}）`,
        percent(entry.difference),
      ]),
    )
    : empty("没有逐条评价分类，无法重算展示倾向。")} ${auditDetails(report.aggregates.taxonomy.map((entry) => entry.evidenceId))}`;
  const section2 = section("02", "评价类型与展示倾向", taxonomyBody);

  const f02 = finding("F02");
  const dimensionBody = `${f02?.status === "unavailable" ? empty(f02.detail) : ""}${report.top20.length && report.aggregates.dimensions.length
    ? table(
      ["产品", "维度", "命中", "覆盖率"],
      report.aggregates.dimensions.map((entry) => [
        productNames.get(entry.productId) ?? entry.productId,
        dimensionLabel(entry.dimension),
        `${entry.hitCount}／${entry.totalCount}`,
        percent(entry.coverage),
      ]),
    )
    : empty("默认排序前 20 条逐维标注不完整。")} ${auditDetails(report.aggregates.dimensions.map((entry) => entry.evidenceId))}`;
  const section3 = section("03", "默认前 20 条六维覆盖", dimensionBody);

  const f03 = finding("F03");
  const eligibleTopics = report.aggregates.topics.filter((entry) => eligibleQuestionProducts.has(entry.productId));
  const excludedNotices = excludedQuestionProducts.map((product) => empty(`${product.name} 的问大家不足 90 条，已排除正式对照。`)).join("");
  const topicBody = `${f03?.status === "unavailable" ? empty(f03.detail) : ""}${excludedNotices}${eligibleTopics.length
    ? table(
      ["产品", "问题主题", "数量", "占比", "代表问题"],
      eligibleTopics.map((entry) => [
        productNames.get(entry.productId) ?? entry.productId,
        topicNames.get(entry.topicId) ?? entry.topicId,
        entry.count,
        percent(entry.share),
        entry.representativeQuestionIds.length ? `${entry.representativeQuestionIds.length} 条` : "—",
      ]),
    )
    : empty("我方问大家不足 90 条，不能形成正式主题诊断。")} ${auditDetails(eligibleTopics.map((entry) => `${entry.evidenceId}：${entry.representativeQuestionIds.join("、")}`))}`;
  const section4 = section("04", questionSectionTitle(report), topicBody);

  const findingsBody = report.findings.length
    ? `<div class="cards">${report.findings.map((entry) => `<article class="card ${escapeHtml(entry.status)}"><header><strong>${escapeHtml(entry.findingId)} · ${escapeHtml(entry.title)}</strong><span>${escapeHtml(statusLabel(entry.status))}</span></header><p>${escapeHtml(entry.detail)}</p>${auditDetails(entry.evidenceIds)}</article>`).join("")}</div>`
    : empty("综合 finding 缺失。");
  const section5 = section("05", "分析结论", findingsBody);

  const actionsBody = report.actions.length
    ? `<ol>${report.actions.map((entry) => `<li><strong>${escapeHtml(entry.priority)} · ${escapeHtml(entry.action)}</strong><p>${escapeHtml(businessActionReason(entry))}</p>${auditDetails([`${entry.findingIds.join("、")} → ${entry.evidenceIds.join("、")}`])}</li>`).join("")}</ol>`
    : empty("没有通过分析结论与证据门禁的行动。");
  const section6 = section("06", "落地清单", actionsBody);
  const serialized = serializeForInlineScript(exportableReport(report));

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>内功问诊报告</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#687180;--line:#dfe4eb;--blue:#5271e8;--warn:#9a5b12}*{box-sizing:border-box}body{margin:0;background:#f4f6f9;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.55}main{width:min(1180px,calc(100% - 32px));margin:32px auto 64px}.hero{margin-bottom:18px;padding:24px;border-radius:16px;background:#172033;color:#fff}.hero h1{margin:0 0 5px;font-size:26px}.hero p{margin:0;color:#bfc8da}.neigong-report-metrics{padding:18px;border:1px solid var(--line);border-radius:14px;background:#f8faff}.neigong-report-metrics h2{margin:0 0 12px;font-size:16px}.neigong-report-metrics>div{display:grid;grid-template-columns:minmax(0,2fr) repeat(3,minmax(110px,1fr));gap:10px}.neigong-report-metrics article{display:grid;align-content:start;gap:4px;min-width:0;padding:13px;border:1px solid #e3e8f3;border-radius:10px;background:#fff}.neigong-report-metrics span,.neigong-report-metrics small{color:var(--muted);font-size:11px}.neigong-report-metrics strong{font-size:18px}.neigong-report-metrics small{overflow-wrap:anywhere}.section{margin-top:16px;padding:20px;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 6px 20px rgba(23,32,51,.04)}.section h2{margin:0 0 14px;font-size:18px}.section h2 span{margin-right:9px;color:var(--blue);font-size:11px;letter-spacing:.12em}.scroll{overflow-x:auto}table{width:100%;min-width:720px;border-collapse:collapse;font-size:12px}th,td{padding:9px 11px;border-bottom:1px solid #edf0f4;text-align:left;vertical-align:top}th{background:#f6f7fa;color:var(--muted);font-size:10px}.empty{display:grid;gap:3px;margin:9px 0;padding:12px 14px;border:1px dashed #d8dde5;border-radius:9px;background:#fafbfc;color:var(--muted)}.empty strong{color:var(--warn);font-size:11px;letter-spacing:.08em}.tags{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.tags span{padding:5px 9px;border-radius:999px;background:#edf7f4;color:#277861;font-size:11px}.audit-note{margin-top:12px;padding:12px 14px;border-left:3px solid #d58a29;background:#fff9f0}.audit-note p{margin:4px 0 0;color:var(--muted);font-size:12px}.neigong-report-audit{margin-top:10px;color:var(--muted);font-size:11px}.neigong-report-audit summary{width:max-content;cursor:pointer;color:#526172;font-weight:650}.neigong-report-audit code{display:block;margin-top:7px;overflow-wrap:anywhere;white-space:normal}.cards{display:grid;gap:10px}.card{padding:13px;border:1px solid var(--line);border-left:4px solid var(--blue);border-radius:9px}.card.unavailable{border-left-color:#d58a29;background:#fffaf3}.card header{display:flex;justify-content:space-between;gap:12px}.card header span{color:var(--muted);font-size:11px}.card p{margin:7px 0;color:#4f5865}ol{margin:0;padding-left:24px}li{padding:8px 0}li p{margin:5px 0;color:var(--muted);font-size:12px}@media(max-width:720px){main{width:min(100% - 20px,1180px);margin-top:10px}.hero,.section{padding:16px}.neigong-report-metrics>div{grid-template-columns:1fr 1fr}}
  </style>
</head>
<body>
  <main>
    <header class="hero"><h1>内功问诊</h1><p>生成时间：${escapeHtml(formatGeneratedAt(report.meta.generatedAt))} · 离线审计报告</p></header>
    <section class="neigong-report-metrics" aria-labelledby="report-metrics-title">
      <h2 id="report-metrics-title">报告核心指标</h2>
      <div>
        <article><span>来源使用行数</span><strong>${totalUsedRows} 行</strong><small>${usedRowsDetail}</small></article>
        <article><span>F01 最大绝对占比差</span><strong>${escapeHtml(metrics.f01Difference)}</strong><small>${escapeHtml(metrics.f01TypeName)}</small></article>
        <article><span>分析结论</span><strong>${metrics.findingCount} 条</strong></article>
        <article><span>落地清单</span><strong>${metrics.actionCount} 条</strong></article>
      </div>
    </section>
    ${section1}${section2}${section3}${section4}${section5}${section6}
  </main>
  <script>window.REPORT_DATA=${serialized};</script>
</body>
</html>`;
}
