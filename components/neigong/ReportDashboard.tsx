import type { ReactNode } from "react";

import {
  buildNeigongExportFileName,
  buildNeigongWorkbook,
} from "@/lib/neigong/excel-export";
import { buildNeigongHtml } from "@/lib/neigong/html-export";
import type { ReportData } from "@/lib/neigong/types";
import {
  businessActionReason,
  dimensionLabel,
  questionSectionTitle,
  sourceKindLabel,
  statusLabel,
} from "@/lib/neigong/report-presentation";

import { renderReportSummaryMetrics } from "./ReportSummaryMetrics";

export type ReportDashboardProps = {
  report: ReportData;
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function productName(report: ReportData, productId: string): string {
  return report.products.find((product) => product.productId === productId)?.name ?? productId;
}

function EmptyState({ gap }: { gap: string }) {
  return (
    <div className="neigong-report-empty" role="status">
      <strong>数据不足</strong>
      <p>具体缺口：{gap}</p>
    </div>
  );
}

function ReportSection({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <article className="neigong-report-section" aria-labelledby={`neigong-report-section-${number}`}>
      <header>
        <span>{number}</span>
        <h3 id={`neigong-report-section-${number}`}>{title}</h3>
      </header>
      {children}
    </article>
  );
}

function finding(report: ReportData, findingId: string) {
  return report.findings.find((entry) => entry.findingId === findingId);
}

function downloadBlob(blob: Blob, fileName: string): void {
  let objectUrl: string | undefined;
  try {
    objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export function ReportDashboard({ report }: ReportDashboardProps) {
  const taxonomyName = new Map(report.taxonomy.map((entry) => [entry.id, entry.name]));
  const topicName = new Map(report.topics.map((entry) => [entry.id, entry.name]));
  const questionCount = new Map<string, number>();
  for (const question of report.questions) {
    questionCount.set(question.productId, (questionCount.get(question.productId) ?? 0) + 1);
  }
  const eligibleQuestionProducts = new Set(
    report.products
      .filter((product) => product.role === "self" || (questionCount.get(product.productId) ?? 0) >= 90)
      .map((product) => product.productId),
  );
  const excludedQuestionProducts = report.products.filter(
    (product) => product.role === "competitor" && !eligibleQuestionProducts.has(product.productId),
  );
  const f01 = finding(report, "F01");
  const f02 = finding(report, "F02");
  const f03 = finding(report, "F03");

  return (
    <div className="neigong-report-dashboard">
      {renderReportSummaryMetrics(report)}
      <div className="neigong-task-actions" aria-label="报告导出">
        <button
          className="neigong-secondary-button"
          type="button"
          onClick={() => {
            const html = buildNeigongHtml(report);
            downloadBlob(
              new Blob([html], { type: "text/html;charset=utf-8" }),
              buildNeigongExportFileName("html"),
            );
          }}
        >
          下载 HTML
        </button>
        <button
          className="neigong-primary-button"
          type="button"
          onClick={() => {
            const workbook = buildNeigongWorkbook(report);
            downloadBlob(
              new Blob([Uint8Array.from(workbook)], {
                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              }),
              buildNeigongExportFileName("xlsx"),
            );
          }}
        >
          导出 Excel
        </button>
      </div>
      <ReportSection number="01" title="数据完整性与产品对照">
        {report.meta.completeness.length ? (
          <div className="neigong-table-scroll" tabIndex={0}>
            <table className="neigong-report-table">
              <thead>
                <tr><th>产品</th><th>来源</th><th>有效／使用</th><th>超限排除</th><th>状态</th></tr>
              </thead>
              <tbody>
                {report.meta.completeness.map((entry) => (
                  <tr key={entry.evidenceId}>
                    <td>{productName(report, entry.productId)}</td>
                    <td>{sourceKindLabel(entry.kind)}</td>
                    <td>{entry.validRows}／{entry.usedRows}（目标 {entry.expectedRows}）</td>
                    <td>{entry.excludedOverLimit}</td>
                    <td><span className={`neigong-status neigong-status-${entry.status}`}>{statusLabel(entry.status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState gap="没有可对账的产品来源。" />}
        {report.reviewTags.length ? (
          <div className="neigong-report-tags" aria-label="截图评价标签">
            {report.reviewTags.map((tag) => <span key={`${tag.sourceId}:${tag.name}`}>{productName(report, tag.productId)} · {tag.name} {tag.count}</span>)}
          </div>
        ) : <EmptyState gap="评价页截图缺失、识别失败，或标签数量不可核验。" />}
        {report.errors.length || report.warnings.length || report.excludedRows.length ? (
          <div className="neigong-report-audit-notes">
            <strong>审计记录</strong>
            <p>错误 {report.errors.length} 条，警告 {report.warnings.length} 条，排除行 {report.excludedRows.length} 条。</p>
          </div>
        ) : null}
        <details className="neigong-report-audit">
          <summary>查看审计证据</summary>
          {[
            ...report.errors.map((entry) => `错误 ${entry.code}：${entry.message}`),
            ...report.warnings.map((entry) => `警告 ${entry.code}：${entry.message}`),
            ...report.excludedRows.map((entry) => `排除 ${entry.rowId}：${entry.reason}`),
            ...report.meta.completeness.map((entry) => entry.evidenceId),
          ].map((entry, index) => <code key={`${index}:${entry}`}>{entry}</code>)}
        </details>
      </ReportSection>

      <ReportSection number="02" title="评价类型与展示倾向">
        {f01?.status === "unavailable" ? <EmptyState gap={f01.detail} /> : null}
        {report.aggregates.taxonomy.length ? (
          <div className="neigong-table-scroll" tabIndex={0}>
            <table className="neigong-report-table">
              <thead>
                <tr><th>产品</th><th>评价类型</th><th>默认排序</th><th>时间排序</th><th>占比差（时间排序－默认排序）</th></tr>
              </thead>
              <tbody>
                {report.aggregates.taxonomy.map((entry) => (
                  <tr key={entry.evidenceId}>
                    <td>{productName(report, entry.productId)}</td>
                    <td>{taxonomyName.get(entry.typeId) ?? entry.typeId}</td>
                    <td>{entry.defaultCount}（{percent(entry.defaultShare)}）</td>
                    <td>{entry.recentCount}（{percent(entry.recentShare)}）</td>
                    <td>{percent(entry.difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState gap="没有逐条评价分类，无法重算展示倾向。" />}
        <details className="neigong-report-audit">
          <summary>查看审计证据</summary>
          <code>{report.aggregates.taxonomy.map((entry) => entry.evidenceId).join(" · ")}</code>
        </details>
      </ReportSection>

      <ReportSection number="03" title="默认前 20 条六维覆盖">
        {f02?.status === "unavailable" ? <EmptyState gap={f02.detail} /> : null}
        {report.top20.length && report.aggregates.dimensions.length ? (
          <div className="neigong-table-scroll" tabIndex={0}>
            <table className="neigong-report-table">
              <thead>
                <tr><th>产品</th><th>维度</th><th>命中</th><th>覆盖率</th></tr>
              </thead>
              <tbody>
                {report.aggregates.dimensions.map((entry) => (
                  <tr key={entry.evidenceId}>
                    <td>{productName(report, entry.productId)}</td>
                    <td>{dimensionLabel(entry.dimension)}</td>
                    <td>{entry.hitCount}／{entry.totalCount}</td>
                    <td>{percent(entry.coverage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState gap="默认排序前 20 条逐维标注不完整。" />}
        <details className="neigong-report-audit">
          <summary>查看审计证据</summary>
          <code>{report.aggregates.dimensions.map((entry) => entry.evidenceId).join(" · ")}</code>
        </details>
      </ReportSection>

      <ReportSection number="04" title={questionSectionTitle(report)}>
        {f03?.status === "unavailable" ? <EmptyState gap={f03.detail} /> : null}
        {excludedQuestionProducts.map((product) => (
          <EmptyState key={product.productId} gap={`${product.name} 的问大家不足 90 条，已排除正式对照。`} />
        ))}
        {report.aggregates.topics.some((entry) => eligibleQuestionProducts.has(entry.productId)) ? (
          <div className="neigong-table-scroll" tabIndex={0}>
            <table className="neigong-report-table">
              <thead>
                <tr><th>产品</th><th>问题主题</th><th>数量</th><th>占比</th><th>代表问题</th></tr>
              </thead>
              <tbody>
                {report.aggregates.topics
                  .filter((entry) => eligibleQuestionProducts.has(entry.productId))
                  .map((entry) => (
                    <tr key={entry.evidenceId}>
                      <td>{productName(report, entry.productId)}</td>
                      <td>{topicName.get(entry.topicId) ?? entry.topicId}</td>
                      <td>{entry.count}</td>
                      <td>{percent(entry.share)}</td>
                      <td>{entry.representativeQuestionIds.length ? `${entry.representativeQuestionIds.length} 条` : "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState gap="我方问大家不足 90 条，不能形成正式主题诊断。" />}
        <details className="neigong-report-audit">
          <summary>查看审计证据</summary>
          <code>{report.aggregates.topics.map((entry) => `${entry.evidenceId}：${entry.representativeQuestionIds.join("、")}`).join(" · ")}</code>
        </details>
      </ReportSection>

      <ReportSection number="05" title="分析结论">
        {report.findings.length ? (
          <div className="neigong-finding-list">
            {report.findings.map((entry) => (
              <section key={entry.findingId} className={`neigong-finding neigong-finding-${entry.status}`}>
                <header><strong>{entry.findingId} · {entry.title}</strong><span>{statusLabel(entry.status)}</span></header>
                <p>{entry.detail}</p>
                <details className="neigong-report-audit">
                  <summary>查看审计证据</summary>
                  <code>{entry.evidenceIds.join(" · ")}</code>
                </details>
              </section>
            ))}
          </div>
        ) : <EmptyState gap="综合 finding 缺失。" />}
      </ReportSection>

      <ReportSection number="06" title="落地清单">
        {report.actions.length ? (
          <ol className="neigong-action-list">
            {report.actions.map((entry) => (
              <li key={entry.actionId}>
                <span>{entry.priority}</span>
                <div>
                  <strong>{entry.action}</strong>
                  <p>{businessActionReason(entry)}</p>
                  <details className="neigong-report-audit">
                    <summary>查看审计证据</summary>
                    <code>{entry.findingIds.join("、")} → {entry.evidenceIds.join("、")}</code>
                  </details>
                </div>
              </li>
            ))}
          </ol>
        ) : <EmptyState gap="没有通过 finding → evidence 门禁的行动。" />}
      </ReportSection>
    </div>
  );
}
