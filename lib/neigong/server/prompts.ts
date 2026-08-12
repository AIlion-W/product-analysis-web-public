// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { TAXONOMY, TOPICS } from "../catalog.ts";
import type { ModelTask, ModelTaskRequest } from "../types";
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import { COMPLAINT_DECISION_MAP, OWN_PRODUCT_KNOWLEDGE } from "./knowledge.ts";

type InputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "high" };

const COMMON = `你是「内功问诊」的服务器端结构化分析器。只返回所给严格 JSON Schema 对象，不返回 Markdown、解释、代码围栏或 Schema 外字段。不得联网，不得补造输入中不存在的事实或证据。`;

const REVIEW_RULES = TAXONOMY
  .map((item) => `${item.id} ${item.name}：${item.definition}`)
  .join("\n");

const QUESTION_RULES = TOPICS
  .map((item) => `${item.id} ${item.name}：${item.definition}；include：${item.includeWhen}；exclude：${item.excludeWhen}`)
  .join("\n");

const INSTRUCTIONS: Record<ModelTask, string> = {
  "review-taxonomy": `${COMMON}
每条评价必须在 t1-t8 中单选，完整覆盖输入 rowId 且不得重复。
证据来源只能是 initial 或 followup，evidenceQuote 必须逐字摘自所选来源。低信息追评、模板化追评和只表达「还行／不错」的追评不增加信息量，也不能把低信息初评升级成高信息分类。
分类定义：
${REVIEW_RULES}`,
  "question-topic": `${COMMON}
每个问题必须在 q1-q8 中单选，完整覆盖输入 rowId 且不得重复。topicEvidence 必须逐字摘自 questionText。严格按 include／exclude 边界判断：
${QUESTION_RULES}`,
  "top20-dimensions": `${COMMON}
逐条评价、逐维判断 persona（人群）、scene（场景）、painPoint（痛点）、detail（体验细节）、effect（效果）、delight（惊喜）。每维必须返回 boolean；命中时 evidence 必须逐字摘自初评或追评，未命中时 evidence 必须为空字符串。score 等于六个 true 的数量。完整覆盖输入 rowId，不得重复。`,
  "screenshot-metadata": `${COMMON}
只读取截图中明确可见的商品名、评价总数、问答总数和评价标签及数量。看不清或未出现的单值字段返回 null，标签数量看不清返回 null；根据可见范围标记 complete、partial 或 missing。`,
  synthesis: `${COMMON}
只读取输入中的代码聚合事实，以及下方两份服务器端我方事实。禁止读取或推断原始评价、原始问题、截图内容。必须输出且只输出 F01、F02、F03 三项 finding；不可用的结论用 unavailable，不能强行下结论。evidenceIds 只能引用当前 finding 的 readiness 白名单。
每个 finding 只能返回 id、status、evidenceIds；禁止返回 title、text、action、reason 或任何自由文本。网页标题、诊断正文和动作全部由代码确定性生成。不得输出优势、领先、更好或亮点总结。

【我方产品唯一事实】
${OWN_PRODUCT_KNOWLEDGE}

【我方客诉决策唯一事实】
${COMPLAINT_DECISION_MAP}`,
};

export function getNeigongInstructions(task: ModelTask): string {
  return INSTRUCTIONS[task];
}

export function buildNeigongInput(request: ModelTaskRequest): Array<InputContent> {
  if (request.task === "screenshot-metadata") {
    return [
      { type: "input_text", text: JSON.stringify({ productId: request.productId }) },
      { type: "input_image", image_url: request.input.dataUrl as string, detail: "high" },
    ];
  }

  return [{
    type: "input_text",
    text: JSON.stringify({
      requestId: request.requestId,
      productId: request.productId,
      ...(request.task === "synthesis" ? { facts: request.input.facts } : { rows: request.input.rows }),
    }),
  }];
}
