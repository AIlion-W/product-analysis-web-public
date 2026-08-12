import { createElement, type ReactElement } from "react";

import type { ReportData } from "../../lib/neigong/types.ts";
// Node executes this source TypeScript directly in behavioral contract tests.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { reportPresentationMetrics } from "../../lib/neigong/report-presentation.ts";

function metricCard(label: string, value: string, detail?: string): ReactElement {
  return createElement(
    "article",
    { className: "neigong-report-metric" },
    createElement("span", null, label),
    createElement("strong", null, value),
    detail ? createElement("small", null, detail) : null,
  );
}

export function renderReportSummaryMetrics(report: ReportData): ReactElement {
  const metrics = reportPresentationMetrics(report);
  const usedRowsDetail = metrics.usedRows
    .map((entry) => `${entry.label} ${entry.usedRows} 行`)
    .join("；");
  const totalUsedRows = metrics.usedRows.reduce((total, entry) => total + entry.usedRows, 0);

  return createElement(
    "section",
    { className: "neigong-report-metrics", "aria-labelledby": "neigong-report-metrics-title" },
    createElement("h3", { id: "neigong-report-metrics-title" }, "报告核心指标"),
    createElement(
      "div",
      null,
      metricCard("来源使用行数", `${totalUsedRows} 行`, usedRowsDetail),
      metricCard("F01 最大绝对占比差", metrics.f01Difference, metrics.f01TypeName),
      metricCard("分析结论", `${metrics.findingCount} 条`),
      metricCard("落地清单", `${metrics.actionCount} 条`),
    ),
  );
}
