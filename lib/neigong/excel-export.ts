// Node executes this source TypeScript directly in contract tests.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { buildWorkbookFromTables, type ExportTable } from "../excel-export.ts";

import type { Action, ReportData } from "./types";
// Node executes this source TypeScript directly in contract tests.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { reportPresentationMetrics } from "./report-presentation.ts";
// Node executes this source TypeScript directly in contract tests.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { validateEvidenceGraph } from "./rules.ts";

type ExportExtension = "html" | "xlsx";

function assertValidatedReport(report: ReportData): void {
  const validation = validateEvidenceGraph(report);
  if (validation.valid) return;
  const first = validation.errors[0];
  throw new Error(`REPORT_NOT_VALIDATED：${first?.code ?? "UNKNOWN"}：${first?.message ?? "报告证据图校验失败。"}`);
}

type NeigongCell = { value: unknown; untrusted: boolean };

function trusted(value: unknown): NeigongCell {
  return { value, untrusted: false };
}

function untrusted(value: unknown): NeigongCell {
  return { value, untrusted: true };
}

function isAllowedXmlCodePoint(codePoint: number): boolean {
  if (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd) return true;
  if (codePoint >= 0x20 && codePoint <= 0xd7ff) return true;
  if (codePoint >= 0xe000 && codePoint <= 0xfffd) return true;
  if (codePoint < 0x10000 || codePoint > 0x10ffff) return false;
  const planeOffset = codePoint & 0xffff;
  return planeOffset !== 0xfffe && planeOffset !== 0xffff;
}

function cleanXmlText(value: unknown): string {
  const source = value === null || value === undefined ? "" : String(value);
  let clean = "";
  for (const character of source) {
    const codePoint = character.codePointAt(0)!;
    clean += isAllowedXmlCodePoint(codePoint) ? character : "\ufffd";
  }
  return clean;
}

function renderCell(
  cell: NeigongCell,
  sheetName: string,
  rowNumber: number,
  columnNumber: number,
): string {
  let text = cleanXmlText(cell.value);
  if (cell.untrusted && /^[\s]*[=+\-@]/u.test(text)) text = `'${text}`;
  if (text.length > 32767) {
    throw new Error(
      `EXCEL_CELL_TOO_LONG：工作表「${sheetName}」第 ${rowNumber} 行第 ${columnNumber} 列超过 32767 字符。`,
    );
  }
  return text;
}

function exportTable(name: string, headers: string[], rows: NeigongCell[][]): ExportTable {
  return {
    name,
    rows: [
      headers.map((header, columnIndex) => renderCell(trusted(header), name, 1, columnIndex + 1)),
      ...rows.map((cells, rowIndex) => cells.map((cell, columnIndex) => (
        renderCell(cell, name, rowIndex + 2, columnIndex + 1)
      ))),
    ],
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function actionFindingIds(action: Action): string[] {
  return unique([action.findingId, ...(action.findingIds ?? [])]);
}

function actionEvidenceIds(action: Action): string[] {
  return unique([action.evidenceId, ...(action.evidenceIds ?? [])]);
}

function tablesFromReport(report: ReportData): ExportTable[] {
  const metrics = reportPresentationMetrics(report);
  const productById = new Map(report.products.map((product) => [product.productId, product]));
  const sourceById = new Map(report.sources.map((source) => [source.sourceId, source]));
  const reviewById = new Map(report.reviews.map((review) => [review.rowId, review]));
  const typeById = new Map(report.taxonomy.map((type) => [type.id, type.name]));
  const topicById = new Map(report.topics.map((topic) => [topic.id, topic.name]));

  const completenessRows = report.meta.completeness.map((entry) => {
    const product = productById.get(entry.productId);
    const sources = entry.sourceIds.map((sourceId) => sourceById.get(sourceId)).filter(Boolean);
    return [
      untrusted(entry.productId),
      untrusted(product?.name ?? entry.productId),
      untrusted(product?.role ?? ""),
      untrusted(entry.kind),
      untrusted(entry.sourceIds.join("、")),
      untrusted(sources.map((source) => source?.note ?? "").filter(Boolean).join("；")),
      trusted(entry.expectedRows),
      trusted(entry.validRows),
      trusted(entry.usedRows),
      trusted(entry.excludedOverLimit),
      untrusted(entry.status),
      trusted(entry.blocking),
      untrusted(entry.evidenceId),
    ];
  });

  const reviewRows = report.reviews.map((review) => {
    const aggregate = report.aggregates.taxonomy.find(
      (entry) => entry.productId === review.productId && entry.typeId === review.typeId,
    );
    const typeEvidence = review.typeEvidence
      ? `${review.typeEvidence.source}：${review.typeEvidence.quote}`
      : "";
    return [
      untrusted(review.productId),
      untrusted(review.sort),
      trusted(review.rank),
      untrusted(review.sourceId),
      trusted(review.sourceRow),
      untrusted(review.rowId),
      untrusted(review.date),
      untrusted(review.sku),
      untrusted(review.initialText),
      untrusted(review.followupText),
      untrusted(review.typeId ?? ""),
      trusted(review.typeId ? typeById.get(review.typeId) ?? review.typeId : ""),
      untrusted(typeEvidence),
      trusted(aggregate?.defaultCount ?? ""),
      trusted(aggregate ? percent(aggregate.defaultShare) : ""),
      trusted(aggregate?.recentCount ?? ""),
      trusted(aggregate ? percent(aggregate.recentShare) : ""),
      trusted(aggregate ? percent(aggregate.difference) : ""),
      untrusted(aggregate?.evidenceId ?? ""),
    ];
  });

  const dimensionRows = report.top20.flatMap((assessment) => {
    const review = reviewById.get(assessment.reviewId);
    return assessment.dimensions.map((dimension) => {
      const aggregate = report.aggregates.dimensions.find(
        (entry) => entry.productId === review?.productId && entry.dimension === dimension.dimension,
      );
      return [
        untrusted(review?.productId ?? ""),
        untrusted(assessment.reviewId),
        untrusted(review?.sourceId ?? ""),
        trusted(review?.sourceRow ?? ""),
        trusted(assessment.rank),
        trusted(assessment.score),
        trusted(dimension.dimension),
        trusted(dimension.present),
        untrusted(dimension.evidence),
        trusted(aggregate?.hitCount ?? ""),
        trusted(aggregate?.totalCount ?? ""),
        trusted(aggregate ? percent(aggregate.coverage) : ""),
        untrusted(aggregate?.evidenceId ?? ""),
      ];
    });
  });

  const questionRows = report.questions.map((question) => {
    const aggregate = report.aggregates.topics.find(
      (entry) => entry.productId === question.productId && entry.topicId === question.topicId,
    );
    return [
      untrusted(question.productId),
      trusted(question.rank),
      untrusted(question.sourceId),
      trusted(question.sourceRow),
      untrusted(question.rowId),
      untrusted(question.date),
      untrusted(question.questionText),
      untrusted(question.answer),
      untrusted(question.topicId ?? ""),
      trusted(question.topicId ? topicById.get(question.topicId) ?? question.topicId : ""),
      untrusted(question.topicEvidence ?? ""),
      trusted(aggregate?.count ?? ""),
      trusted(aggregate ? percent(aggregate.share) : ""),
      untrusted(aggregate?.representativeQuestionIds.join("、") ?? ""),
      untrusted(aggregate?.evidenceId ?? ""),
    ];
  });

  const findingRows = report.findings.map((finding) => [
    untrusted(finding.findingId),
    untrusted(finding.status),
    trusted(finding.hasProblem),
    untrusted(finding.problemCode ?? ""),
    untrusted(finding.title),
    untrusted(finding.detail),
    untrusted(finding.evidenceIds.join("、")),
    trusted(finding.findingId === "F01" ? metrics.f01TypeId : ""),
    trusted(finding.findingId === "F01" ? metrics.f01Difference : ""),
  ]);

  const actionRows = report.actions.map((action) => [
    untrusted(action.actionId),
    untrusted(action.priority),
    untrusted(action.action),
    untrusted(action.reason),
    untrusted(actionFindingIds(action).join("、")),
    untrusted(actionEvidenceIds(action).join("、")),
  ]);

  return [
    exportTable(
      "数据完整性",
      ["productId", "产品", "role", "kind", "sourceId", "来源说明", "目标行数", "有效行数", "使用行数", "超限排除", "状态", "blocking", "evidenceId"],
      completenessRows,
    ),
    exportTable(
      "评价逐条标注",
      ["productId", "sort", "rank", "sourceId", "sourceRow", "rowId", "日期", "SKU", "初评", "追评", "typeId", "评价类型", "typeEvidence", "默认数量", "默认占比", "时间数量", "时间占比", "占比差", "evidenceId"],
      reviewRows,
    ),
    exportTable(
      "前 20 六维",
      ["productId", "rowId", "sourceId", "sourceRow", "rank", "总分", "维度", "是否命中", "逐条证据", "命中数", "总数", "覆盖率", "evidenceId"],
      dimensionRows,
    ),
    exportTable(
      "问大家逐条标注",
      ["productId", "rank", "sourceId", "sourceRow", "rowId", "日期", "问题", "回答", "topicId", "问题主题", "topicEvidence", "主题数量", "主题占比", "代表问题 rowId", "evidenceId"],
      questionRows,
    ),
    exportTable(
      "分析结论",
      ["findingId", "状态", "是否触发关注线", "规则代码", "标题", "结论", "evidenceId", "F01类型", "F01最大绝对占比差"],
      findingRows,
    ),
    exportTable(
      "落地清单",
      ["actionId", "优先级", "行动", "原因", "findingId", "evidenceId"],
      actionRows,
    ),
  ];
}

export function buildNeigongWorkbook(report: ReportData): Uint8Array {
  assertValidatedReport(report);
  return buildWorkbookFromTables(tablesFromReport(report), "内功问诊");
}

export function buildNeigongExportFileName(
  extension: ExportExtension,
  date: Date = new Date(),
): string {
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_EXPORT_DATE");
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `内功问诊-${year}-${month}-${day}.${extension}`;
}
