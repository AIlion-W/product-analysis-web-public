import type { Action, ReportData } from "./types.ts";
// Node executes this source TypeScript directly in behavioral contract tests.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { DIMENSION_LABELS } from "./catalog.ts";
// Node executes this source TypeScript directly in behavioral contract tests.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { selectF01TaxonomyAggregate, validateEvidenceGraph } from "./rules.ts";

export type ReportPresentationMetrics = {
  usedRows: Array<{ evidenceId: string; label: string; usedRows: number }>;
  f01TypeId: string;
  f01TypeName: string;
  f01Difference: string;
  findingCount: number;
  actionCount: number;
};

const STATUS_LABELS: Record<string, string> = {
  complete: "完整",
  provisional: "基本完整",
  insufficient: "数据不足",
  missing: "缺失",
  available: "可诊断",
  unavailable: "数据不足",
};

export function sourceKindLabel(kind: string): string {
  if (kind.endsWith("default_reviews")) return "默认排序评价";
  if (kind.endsWith("recent_reviews")) return "时间排序评价";
  if (kind.endsWith("questions")) return "问大家";
  if (kind.endsWith("review_tags")) return "评价页截图";
  return kind;
}

export function dimensionLabel(dimension: string): string {
  return DIMENSION_LABELS[dimension] ?? dimension;
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function formatGeneratedAt(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}（北京时间）`;
}

function actionFindingIds(action: Pick<Action, "findingId" | "findingIds">): string[] {
  return action.findingIds?.length ? action.findingIds : action.findingId ? [action.findingId] : [];
}

function actionEvidenceIds(action: Pick<Action, "evidenceId" | "evidenceIds">): string[] {
  return action.evidenceIds?.length ? action.evidenceIds : action.evidenceId ? [action.evidenceId] : [];
}

export function businessActionReason(action: Pick<Action, "reason" | "findingId" | "findingIds" | "evidenceId" | "evidenceIds">): string {
  const auditPrefix = `${actionFindingIds(action).join("、")}｜${actionEvidenceIds(action).join("、")}：`;
  const separator = action.reason.lastIndexOf(auditPrefix);
  return separator >= 0
    ? action.reason.slice(separator + auditPrefix.length)
    : "具体依据已收纳在审计证据中。";
}

export function questionSectionTitle(report: ReportData): string {
  const questionCount = new Map<string, number>();
  for (const question of report.questions) {
    questionCount.set(question.productId, (questionCount.get(question.productId) ?? 0) + 1);
  }
  return report.products.some(
    (product) => product.role === "competitor" && (questionCount.get(product.productId) ?? 0) >= 90,
  )
    ? "问大家竞品对照"
    : "问大家主题分布（仅我方）";
}

export function reportPresentationMetrics(report: ReportData): ReportPresentationMetrics {
  const validation = validateEvidenceGraph(report);
  if (!validation.valid) {
    const first = validation.errors[0];
    throw new Error(`REPORT_NOT_VALIDATED：${first?.code ?? "UNKNOWN"}：${first?.message ?? "报告证据图校验失败。"}`);
  }

  const f01 = report.findings.find((finding) => finding.findingId === "F01");
  const f01Aggregate = f01?.status === "available"
    ? selectF01TaxonomyAggregate(report.products, report.aggregates.taxonomy)
    : undefined;
  const productNames = new Map(report.products.map((product) => [product.productId, product.name]));
  const taxonomyNames = new Map(report.taxonomy.map((entry) => [entry.id, entry.name]));
  return {
    usedRows: report.meta.completeness
      .map((entry) => ({
        evidenceId: entry.evidenceId,
        label: `${productNames.get(entry.productId) ?? entry.productId} · ${sourceKindLabel(entry.kind)}`,
        usedRows: entry.usedRows,
      })),
    f01TypeId: f01Aggregate?.typeId ?? "unavailable",
    f01TypeName: f01Aggregate ? taxonomyNames.get(f01Aggregate.typeId) ?? f01Aggregate.typeId : "数据不足",
    f01Difference: f01Aggregate
      ? `${(Math.abs(f01Aggregate.difference) * 100).toFixed(1)}pp`
      : "数据不足",
    findingCount: report.findings.length,
    actionCount: report.actions.length,
  };
}
