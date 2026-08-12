"use client";

import type { ParsedProductPack, SourceKind, SourceMapping, SourceSummary } from "@/lib/neigong/types";

import type { ProductPackDraft } from "./ProductPackCard";

export type PreflightProduct = {
  draft: ProductPackDraft;
  parsed?: ParsedProductPack;
  parsing: boolean;
  parseError?: { code: string; message: string };
  mappingConfirmed: boolean;
};

export type PreflightPanelProps = {
  products: PreflightProduct[];
  onMappingChange(productId: string, confirmed: boolean): void;
  onBack(): void;
  onStart(): void;
};

const SOURCE_LABELS: Record<SourceKind, string> = {
  default_reviews: "默认排序评价 Excel",
  recent_reviews: "时间排序评价 Excel",
  questions: "问大家 Excel",
  review_tags: "评价页截图",
};

const STATUS_LABELS = {
  complete: "完整",
  provisional: "可分析，样本略少",
  insufficient: "样本不足，仅保留逐条结果",
  missing: "缺失",
} as const;

// Parser errors are blocking. `insufficient` is represented by source status and remains a warning.
const BLOCKING_ERROR_CODES = new Set([
  "RANK_ORDER_CONFLICT",
  "MISSING_REVIEW_FILE",
  "MISSING_REVIEW_SHEET",
  "MISSING_HEADER",
  "MISSING_COLUMN",
  "UNKNOWN_COLUMN",
  "DUPLICATE_COLUMN",
  "PARSER_FAILED",
]);

function sourceRow(source: SourceSummary, mapping?: SourceMapping) {
  return (
    <tr key={source.sourceId}>
      <td>{SOURCE_LABELS[source.kind]}</td>
      <td>{mapping?.fileName ?? "未识别"}</td>
      <td>{mapping?.sheetName ?? "未识别"}</td>
      <td className="neigong-field-mapping">
        {mapping?.columns.length
          ? mapping.columns.map((column) => `${column.header} → ${column.field}`).join("；")
          : "未识别"}
      </td>
      <td>{source.rowsRead}</td>
      <td>{source.validRows}</td>
      <td>{source.usedRows}</td>
      <td>{source.excludedRows}</td>
      <td>{source.excludedOverLimit}</td>
      <td>
        <span className={`neigong-status neigong-status-${source.status}`}>
          {STATUS_LABELS[source.status]}
        </span>
      </td>
    </tr>
  );
}

function fileName(draft: ProductPackDraft, kind: SourceKind): string {
  if (kind === "default_reviews") return draft.defaultReviewFile?.name ?? draft.reviewFile?.name ?? "未选择";
  if (kind === "recent_reviews") return draft.recentReviewFile?.name ?? draft.reviewFile?.name ?? "未选择";
  if (kind === "questions") return draft.questionFile?.name ?? "未选择";
  return draft.screenshotFile?.name ?? "未选择";
}

function ProductPreflight({
  item,
  onMappingChange,
}: {
  item: PreflightProduct;
  onMappingChange(productId: string, confirmed: boolean): void;
}) {
  const { draft, parsed, parsing, parseError, mappingConfirmed } = item;
  const productId = draft.product.productId;
  const errors = [...(parsed?.errors ?? []), ...(parseError ? [parseError] : [])];
  const warnings = parsed?.warnings ?? [];
  const insufficient = parsed?.sources.filter((source) => source.status === "insufficient") ?? [];
  const screenshotStatus = parsed?.screenshot?.status === "ready" ? "已就绪" : "缺失或不可用";

  return (
    <article className="neigong-preflight-product">
      <div className="neigong-preflight-head">
        <div>
          <span className="neigong-role-badge">{draft.product.role === "self" ? "我方产品" : "竞品"}</span>
          <h3>{draft.product.name.trim() || "产品名为空"}</h3>
        </div>
        <span className="neigong-parsing-state">{parsing ? "正在解析…" : parsed ? "解析完成" : "等待解析"}</span>
      </div>

      {parsed ? (
        <div className="neigong-table-scroll" tabIndex={0} aria-label={`${draft.product.name || productId} 完整性明细`}>
          <table className="neigong-preflight-table">
            <thead>
              <tr>
                <th>文件角色</th>
                <th>实际文件</th>
                <th>工作表名称</th>
                <th>字段映射</th>
                <th>rowsRead</th>
                <th>validRows</th>
                <th>usedRows</th>
                <th>excludedRows</th>
                <th>excludedOverLimit</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {parsed.sources.map((source) => sourceRow(
                source,
                parsed.sourceMappings.find((mapping) => mapping.sourceId === source.sourceId),
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="neigong-empty-state">尚无解析结果。请返回上传资料，并分别选择默认排序和时间排序评价 Excel。</p>
      )}

      <dl className="neigong-file-summary">
        {(["default_reviews", "recent_reviews", "questions", "review_tags"] as const).map((kind) => (
          <div key={kind}>
            <dt>{SOURCE_LABELS[kind]}</dt>
            <dd>{fileName(draft, kind)}</dd>
          </div>
        ))}
        <div>
          <dt>截图状态</dt>
          <dd>{screenshotStatus}</dd>
        </div>
      </dl>

      {errors.length ? (
        <div className="neigong-message-group neigong-message-errors" role="alert">
          <strong>阻断项</strong>
          <ul>
            {errors.map((error, index) => (
              <li key={`${error.code}-${index}`}>
                <code>{error.code}</code>：{error.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.length || insufficient.length ? (
        <div className="neigong-message-group neigong-message-warnings">
          <strong>警告项（不阻断逐条分析）</strong>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>
                <code>{warning.code}</code>：{warning.message}
              </li>
            ))}
            {insufficient.map((source) => (
              <li key={`insufficient-${source.sourceId}`}>
                <code>insufficient</code>：
                {parsed?.sourceMappings.find((mapping) => mapping.sourceId === source.sourceId)?.sheetName ?? SOURCE_LABELS[source.kind]}
                仅有 {source.usedRows} 条可用数据。
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="neigong-confirm-row">
        <input
          type="checkbox"
          checked={mappingConfirmed}
          disabled={!parsed || parsing || errors.some((error) => BLOCKING_ERROR_CODES.has(error.code))}
          onChange={(event) => onMappingChange(productId, event.currentTarget.checked)}
        />
        我已确认产品归属、工作表名称与字段映射
      </label>
    </article>
  );
}

export function PreflightPanel({ products, onMappingChange, onBack, onStart }: PreflightPanelProps) {
  const hasBlockingIssue = products.some(({ draft, parsed, parsing, parseError, mappingConfirmed }) => (
    parsing
    || !parsed
    || Boolean(parseError)
    || !draft.product.name.trim()
    || !mappingConfirmed
    || parsed.errors.length > 0
  ));

  return (
    <section className="neigong-stage-panel" aria-labelledby="neigong-preflight-title">
      <div className="neigong-stage-heading">
        <div>
          <span>阶段 02</span>
          <h2 id="neigong-preflight-title">完整性检查</h2>
        </div>
        <p>errors 会阻断；insufficient 仅警告并保留逐条分析。</p>
      </div>

      <div className="neigong-preflight-list">
        {products.map((item) => (
          <ProductPreflight
            key={item.draft.product.productId}
            item={item}
            onMappingChange={onMappingChange}
          />
        ))}
      </div>

      <div className="neigong-stage-actions">
        <button className="neigong-secondary-button" type="button" onClick={onBack}>
          返回上传资料
        </button>
        <button className="neigong-primary-button" type="button" disabled={hasBlockingIssue} onClick={onStart}>
          确认映射后分析
        </button>
      </div>
    </section>
  );
}
