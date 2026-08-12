import type {
  ModelTask,
  ModelTaskOutputMap,
  ModelTaskRequest,
  SynthesisFacts,
} from "../types";

export const MODEL_TASKS = [
  "review-taxonomy",
  "question-topic",
  "top20-dimensions",
  "screenshot-metadata",
  "synthesis",
] as const satisfies readonly ModelTask[];

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

export interface JsonSchema {
  type?: string | string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
}

export interface StrictJsonFormat {
  type: "json_schema";
  name: string;
  strict: true;
  schema: JsonSchema;
}

const strictObject = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});

const reviewLabel = strictObject({
  rowId: { type: "string" },
  typeId: { type: "string", enum: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"] },
  evidenceSource: { type: "string", enum: ["initial", "followup"] },
  evidenceQuote: { type: "string" },
});

const questionLabel = strictObject({
  rowId: { type: "string" },
  topicId: { type: "string", enum: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"] },
  topicEvidence: { type: "string" },
});

const dimensionFlags = strictObject({
  persona: { type: "boolean" },
  scene: { type: "boolean" },
  painPoint: { type: "boolean" },
  detail: { type: "boolean" },
  effect: { type: "boolean" },
  delight: { type: "boolean" },
});

const dimensionEvidence = strictObject({
  persona: { type: "string" },
  scene: { type: "string" },
  painPoint: { type: "string" },
  detail: { type: "string" },
  effect: { type: "string" },
  delight: { type: "string" },
});

const top20Label = strictObject({
  rowId: { type: "string" },
  dimensions: dimensionFlags,
  evidence: dimensionEvidence,
  score: { type: "integer", minimum: 0, maximum: 6 },
  note: { type: "string" },
});

const screenshotResult = strictObject({
  productName: { type: ["string", "null"] },
  reviewTotal: { type: ["string", "null"] },
  questionTotal: { type: ["string", "null"] },
  tags: {
    type: "array",
    items: strictObject({
      tag: { type: "string" },
      count: { type: ["integer", "null"], minimum: 0 },
    }),
  },
  completeness: { type: "string", enum: ["complete", "partial", "missing"] },
});

const finding = strictObject({
  id: { type: "string", enum: ["F01", "F02", "F03"] },
  status: { type: "string", enum: ["available", "unavailable"] },
  evidenceIds: { type: "array", items: { type: "string" } },
});

const synthesisFactsSchema = strictObject({
  products: {
    type: "array",
    items: strictObject({
      productId: { type: "string" },
      role: { type: "string", enum: ["self", "competitor"] },
      name: { type: "string" },
    }),
  },
  completeness: {
    type: "array",
    items: strictObject({
      evidenceId: { type: "string" },
      productId: { type: "string" },
      kind: { type: "string", enum: ["default_reviews", "recent_reviews", "questions", "review_tags"] },
      expectedRows: { type: "integer", minimum: 0 },
      validRows: { type: "integer", minimum: 0 },
      usedRows: { type: "integer", minimum: 0 },
      status: { type: "string", enum: ["complete", "provisional", "insufficient", "missing"] },
    }),
  },
  readiness: {
    type: "array",
    items: strictObject({
      findingId: { type: "string", enum: ["F01", "F02", "F03"] },
      status: { type: "string", enum: ["available", "unavailable"] },
      reason: { type: "string" },
      evidenceIds: { type: "array", items: { type: "string" } },
    }),
  },
  aggregates: strictObject({
    taxonomy: {
      type: "array",
      items: strictObject({
        productId: { type: "string" },
        typeId: { type: "string", enum: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"] },
        defaultCount: { type: "integer", minimum: 0 },
        defaultShare: { type: "number", minimum: 0, maximum: 1 },
        recentCount: { type: "integer", minimum: 0 },
        recentShare: { type: "number", minimum: 0, maximum: 1 },
        difference: { type: "number", minimum: -1, maximum: 1 },
        evidenceId: { type: "string" },
      }),
    },
    topics: {
      type: "array",
      items: strictObject({
        topicId: { type: "string", enum: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"] },
        productId: { type: "string" },
        count: { type: "integer", minimum: 0 },
        share: { type: "number", minimum: 0, maximum: 1 },
        representativeQuestionIds: { type: "array", items: { type: "string" } },
        evidenceId: { type: "string" },
      }),
    },
    dimensions: {
      type: "array",
      items: strictObject({
        dimension: { type: "string", enum: ["persona", "scene", "painPoint", "detail", "effect", "delight"] },
        productId: { type: "string" },
        hitCount: { type: "integer", minimum: 0 },
        totalCount: { type: "integer", minimum: 0 },
        coverage: { type: "number", minimum: 0, maximum: 1 },
        evidenceId: { type: "string" },
      }),
    },
    duplicateRows: {
      type: "array",
      items: strictObject({
        sourceId: { type: "string" },
        rowIds: { type: "array", items: { type: "string" } },
      }),
    },
    crossSortOverlap: {
      type: "array",
      items: strictObject({
        productId: { type: "string" },
        rowIds: { type: "array", items: { type: "string" } },
      }),
    },
  }),
});

export const RESPONSE_FORMATS: Record<ModelTask, StrictJsonFormat> = {
  "review-taxonomy": {
    type: "json_schema",
    name: "neigong_review_taxonomy",
    strict: true,
    schema: strictObject({ labels: { type: "array", items: reviewLabel } }),
  },
  "question-topic": {
    type: "json_schema",
    name: "neigong_question_topic",
    strict: true,
    schema: strictObject({ labels: { type: "array", items: questionLabel } }),
  },
  "top20-dimensions": {
    type: "json_schema",
    name: "neigong_top20_dimensions",
    strict: true,
    schema: strictObject({ rows: { type: "array", items: top20Label } }),
  },
  "screenshot-metadata": {
    type: "json_schema",
    name: "neigong_screenshot_metadata",
    strict: true,
    schema: screenshotResult,
  },
  synthesis: {
    type: "json_schema",
    name: "neigong_synthesis",
    strict: true,
    schema: strictObject({
      findings: { type: "array", items: finding },
    }),
  },
};

function invalid(code: string, error: string): ValidationResult<never> {
  return { ok: false, code, error };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isNonEmptyString(value: unknown, maximum = 20_000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isBoundedString(value: unknown, maximum = 20_000): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function containsImageDataUrl(value: unknown): boolean {
  if (typeof value === "string") return value.trimStart().startsWith("data:image/");
  if (Array.isArray(value)) return value.some(containsImageDataUrl);
  return isObject(value) && Object.values(value).some(containsImageDataUrl);
}

function validateRows(input: Record<string, unknown>, task: ModelTask): ValidationResult<Record<string, unknown>> {
  if (!hasOnlyKeys(input, ["rows"]) || !Array.isArray(input.rows)) {
    return invalid("INVALID_REQUEST", "任务输入必须只包含 rows 数组");
  }

  const limit = task === "top20-dimensions" ? 20 : 50;
  if (input.rows.length > limit) return invalid("TOO_MANY_ROWS", `单批最多 ${limit} 条`);
  if (input.rows.length === 0) return invalid("INVALID_REQUEST", "rows 不能为空");

  const rowIds = new Set<string>();
  for (const row of input.rows) {
    if (!isObject(row) || !isNonEmptyString(row.rowId, 256)) {
      return invalid("INVALID_REQUEST", "每行必须包含有效 rowId");
    }
    if (rowIds.has(row.rowId)) return invalid("DUPLICATE_ROW_ID", `rowId 重复：${row.rowId}`);
    rowIds.add(row.rowId);

    if (task === "question-topic") {
      if (!isNonEmptyString(row.questionText)) return invalid("INVALID_REQUEST", "问题行缺少 questionText");
      if (row.answer !== undefined && !isBoundedString(row.answer)) return invalid("INVALID_REQUEST", "answer 必须是长度不超过 20000 的字符串");
    } else {
      if (row.initialText !== undefined && !isBoundedString(row.initialText)) return invalid("INVALID_REQUEST", "initialText 必须是长度不超过 20000 的字符串");
      if (row.followupText !== undefined && !isBoundedString(row.followupText)) return invalid("INVALID_REQUEST", "followupText 必须是长度不超过 20000 的字符串");
      if (!isNonEmptyString(row.initialText) && !isNonEmptyString(row.followupText)) {
        return invalid("INVALID_REQUEST", "评价行必须包含初评或追评");
      }
    }
  }

  if (containsImageDataUrl(input)) return invalid("INVALID_REQUEST", "该任务不接受截图 Data URL");
  return { ok: true, value: input };
}

function validateScreenshot(input: Record<string, unknown>): ValidationResult<Record<string, unknown>> {
  if (!hasOnlyKeys(input, ["dataUrl", "width", "height", "bytes"])) {
    return invalid("INVALID_SCREENSHOT", "截图任务包含未知字段");
  }
  if (typeof input.dataUrl !== "string") {
    return invalid("INVALID_SCREENSHOT", "截图必须是 JPEG、PNG 或 WebP Data URL");
  }
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(input.dataUrl);
  if (!match || match[2].length % 4 !== 0) return invalid("INVALID_SCREENSHOT", "截图 Base64 无效或为空");
  let bytes: Uint8Array;
  try {
    const decoded = atob(match[2]);
    bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return invalid("INVALID_SCREENSHOT", "截图 Base64 解码失败");
  }
  const mime = match[1].toLowerCase();
  const validMagic = mime === "png"
    ? bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
    : mime === "jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12
        && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
        && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!validMagic) return invalid("INVALID_SCREENSHOT", "截图 MIME 与文件魔数不一致");
  for (const key of ["width", "height", "bytes"] as const) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || (input[key] as number) < 0)) {
      return invalid("INVALID_SCREENSHOT", `${key} 必须是非负整数`);
    }
  }
  return { ok: true, value: input };
}

function validateSynthesis(input: Record<string, unknown>): ValidationResult<Record<string, unknown>> {
  if (!hasOnlyKeys(input, ["facts"]) || !isObject(input.facts)) {
    return invalid("INVALID_SYNTHESIS_INPUT", "综合任务只接受 facts 对象");
  }
  const schemaError = validateAgainstSchema(input.facts, synthesisFactsSchema, "facts");
  if (schemaError) return invalid("INVALID_SYNTHESIS_INPUT", schemaError);
  const facts = input.facts as unknown as SynthesisFacts;
  const productIds = new Set<string>();
  for (const product of facts.products) {
    if (!isNonEmptyString(product.productId, 256) || !isNonEmptyString(product.name) || productIds.has(product.productId)) {
      return invalid("INVALID_SYNTHESIS_INPUT", "products 包含空值或重复 productId");
    }
    productIds.add(product.productId);
  }

  const evidenceIds = new Set<string>();
  const definitions = [
    ...facts.completeness,
    ...facts.aggregates.taxonomy,
    ...facts.aggregates.topics,
    ...facts.aggregates.dimensions,
  ];
  for (const definition of definitions) {
    if (!isNonEmptyString(definition.evidenceId, 512) || evidenceIds.has(definition.evidenceId)) {
      return invalid("INVALID_SYNTHESIS_INPUT", "evidenceId 为空或重复");
    }
    if (!productIds.has(definition.productId)) {
      return invalid("INVALID_SYNTHESIS_INPUT", `证据引用未知产品：${definition.productId}`);
    }
    evidenceIds.add(definition.evidenceId);
  }

  const readinessIds = new Set<string>();
  for (const readiness of facts.readiness) {
    if (readinessIds.has(readiness.findingId)) return invalid("INVALID_SYNTHESIS_INPUT", `readiness 重复：${readiness.findingId}`);
    readinessIds.add(readiness.findingId);
    if (!isNonEmptyString(readiness.reason) || readiness.evidenceIds.length === 0 || new Set(readiness.evidenceIds).size !== readiness.evidenceIds.length) {
      return invalid("INVALID_SYNTHESIS_INPUT", `readiness ${readiness.findingId} 证据为空或重复`);
    }
    if (readiness.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
      return invalid("INVALID_SYNTHESIS_INPUT", `readiness ${readiness.findingId} 引用未知证据`);
    }
  }
  if (!["F01", "F02", "F03"].every((findingId) => readinessIds.has(findingId))) {
    return invalid("INVALID_SYNTHESIS_INPUT", "readiness 必须完整包含 F01-F03");
  }
  return { ok: true, value: input };
}

export function validateModelTaskRequest(value: unknown): ValidationResult<ModelTaskRequest> {
  if (!isObject(value)) return invalid("INVALID_REQUEST", "请求必须是 JSON 对象");
  if (typeof value.task !== "string" || !MODEL_TASKS.includes(value.task as ModelTask)) {
    return invalid("INVALID_TASK", "未知模型任务");
  }
  const task = value.task as ModelTask;
  if (!isNonEmptyString(value.productId, 256)) return invalid("INVALID_REQUEST", "缺少 productId");
  if (value.requestId !== undefined && !isNonEmptyString(value.requestId, 256)) {
    return invalid("INVALID_REQUEST", "requestId 必须是非空字符串");
  }

  const payloadKeys = task === "screenshot-metadata"
    ? ["dataUrl", "width", "height", "bytes"]
    : task === "synthesis" ? ["facts"] : ["rows"];
  const commonKeys = ["task", "requestId", "productId"];
  let input: Record<string, unknown>;

  if ("input" in value) {
    if (!hasOnlyKeys(value, [...commonKeys, "input"]) || !isObject(value.input)) {
      return invalid("INVALID_REQUEST", "input 必须是唯一任务载荷对象");
    }
    input = value.input;
  } else {
    if (!hasOnlyKeys(value, [...commonKeys, ...payloadKeys])) return invalid("INVALID_REQUEST", "请求包含未知字段");
    input = Object.fromEntries(payloadKeys.filter((key) => key in value).map((key) => [key, value[key]]));
  }

  const validated = task === "screenshot-metadata"
    ? validateScreenshot(input)
    : task === "synthesis"
      ? validateSynthesis(input)
      : validateRows(input, task);
  if (!validated.ok) return validated;

  return {
    ok: true,
    value: {
      task,
      requestId: typeof value.requestId === "string" ? value.requestId : `${task}:${value.productId}`,
      productId: value.productId,
      input: validated.value,
    },
  };
}

function matchesType(value: unknown, type: string) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "result"): string | null {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => matchesType(value, type))) return `${path} 类型错误`;
  if (value === null) return null;
  if (schema.enum && !schema.enum.includes(value as string)) return `${path} 不在允许值中`;
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} 小于最小值`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} 大于最大值`;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} 数量超限`;
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateAgainstSchema(value[index], schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (isObject(value) && schema.properties) {
    const required = schema.required ?? [];
    for (const key of required) if (!(key in value)) return `${path}.${key} 缺失`;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in schema.properties)) return `${path}.${key} 未定义`;
    }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (key in value) {
        const error = validateAgainstSchema(value[key], childSchema, `${path}.${key}`);
        if (error) return error;
      }
    }
  }
  return null;
}

export function validateModelTaskResult<T extends ModelTask>(task: T, value: unknown): ValidationResult<ModelTaskOutputMap[T]> {
  const format = RESPONSE_FORMATS[task];
  if (!format) return invalid("INVALID_TASK", "未知模型任务");
  const error = validateAgainstSchema(value, format.schema);
  if (error) return invalid("MODEL_SCHEMA_INVALID", error);
  return { ok: true, value: value as ModelTaskOutputMap[T] };
}

function rowMap(request: ModelTaskRequest) {
  const rows = Array.isArray(request.input.rows) ? request.input.rows : [];
  return new Map(rows.filter(isObject).map((row) => [row.rowId, row]));
}

function hasUniqueKnownRows(rows: unknown[], known: Map<unknown, Record<string, unknown>>) {
  const seen = new Set<unknown>();
  for (const item of rows) {
    if (!isObject(item) || !known.has(item.rowId) || seen.has(item.rowId)) return false;
    seen.add(item.rowId);
  }
  return seen.size === known.size;
}

function normalizedIncludes(source: unknown, quote: unknown) {
  return typeof source === "string" && typeof quote === "string" && quote.trim().length > 0 && source.includes(quote);
}

function collectEvidenceIds(facts: SynthesisFacts): Set<string> {
  return new Set([
    ...facts.completeness.map((item) => item.evidenceId),
    ...facts.readiness.flatMap((item) => item.evidenceIds),
    ...facts.aggregates.taxonomy.map((item) => item.evidenceId),
    ...facts.aggregates.topics.map((item) => item.evidenceId),
    ...facts.aggregates.dimensions.map((item) => item.evidenceId),
  ]);
}

export function validateModelTaskReferences(
  request: ModelTaskRequest,
  value: unknown,
): ValidationResult<Record<string, unknown>> {
  if (!isObject(value)) return invalid("MODEL_SCHEMA_INVALID", "模型结果不是对象");
  const known = rowMap(request);

  if (request.task === "review-taxonomy") {
    const labels = value.labels as unknown[];
    if (!hasUniqueKnownRows(labels, known)) return invalid("MODEL_SCHEMA_INVALID", "评价结果 rowId 不完整、重复或未知");
    for (const label of labels as Array<Record<string, unknown>>) {
      const row = known.get(label.rowId)!;
      const source = label.evidenceSource === "initial" ? row.initialText : row.followupText;
      if (!normalizedIncludes(source, label.evidenceQuote)) return invalid("MODEL_SCHEMA_INVALID", "评价证据不在对应初评或追评中");
    }
  }

  if (request.task === "question-topic") {
    const labels = value.labels as unknown[];
    if (!hasUniqueKnownRows(labels, known)) return invalid("MODEL_SCHEMA_INVALID", "问题结果 rowId 不完整、重复或未知");
    for (const label of labels as Array<Record<string, unknown>>) {
      const row = known.get(label.rowId)!;
      if (!normalizedIncludes(row.questionText, label.topicEvidence)) return invalid("MODEL_SCHEMA_INVALID", "问题证据不在原问题中");
    }
  }

  if (request.task === "top20-dimensions") {
    const rows = value.rows as unknown[];
    if (!hasUniqueKnownRows(rows, known)) return invalid("MODEL_SCHEMA_INVALID", "六维结果 rowId 不完整、重复或未知");
    for (const resultRow of rows as Array<Record<string, unknown>>) {
      const sourceRow = known.get(resultRow.rowId)!;
      const dimensions = resultRow.dimensions as Record<string, boolean>;
      const evidence = resultRow.evidence as Record<string, string>;
      const score = Object.values(dimensions).filter(Boolean).length;
      if (resultRow.score !== score) return invalid("MODEL_SCHEMA_INVALID", "六维 score 与命中数不一致");
      for (const key of Object.keys(dimensions)) {
        if (dimensions[key] && !normalizedIncludes(sourceRow.initialText, evidence[key]) && !normalizedIncludes(sourceRow.followupText, evidence[key])) {
          return invalid("MODEL_SCHEMA_INVALID", `六维 ${key} 证据不在原评价中`);
        }
        if (!dimensions[key] && evidence[key] !== "") return invalid("MODEL_SCHEMA_INVALID", `六维 ${key} 未命中时证据必须为空`);
      }
    }
  }

  if (request.task === "synthesis") {
    const findings = value.findings as Array<Record<string, unknown>>;
    const findingIds = findings.map((item) => item.id);
    if (new Set(findingIds).size !== 3 || !["F01", "F02", "F03"].every((id) => findingIds.includes(id))) {
      return invalid("MODEL_SCHEMA_INVALID", "综合结论必须完整输出 F01-F03");
    }
    const facts = request.input.facts as SynthesisFacts;
    const knownEvidence = collectEvidenceIds(facts);
    const readinessByFinding = new Map(facts.readiness.map((item) => [item.findingId, item]));
    for (const item of findings) {
      const evidenceIds = item.evidenceIds as string[];
      const readiness = readinessByFinding.get(item.id as "F01" | "F02" | "F03");
      if (!readiness || item.status !== readiness.status) {
        return invalid("MODEL_SCHEMA_INVALID", `综合结论 ${item.id} status 与 readiness 不一致`);
      }
      if (evidenceIds.length === 0 || new Set(evidenceIds).size !== evidenceIds.length) {
        return invalid("MODEL_SCHEMA_INVALID", `综合结论 ${item.id} 证据为空或重复`);
      }
      for (const id of evidenceIds) {
        if (!knownEvidence.has(id) || !readiness.evidenceIds.includes(id)) {
          return invalid("MODEL_SCHEMA_INVALID", `综合结论引用未知或未授权证据：${id}`);
        }
      }
    }
  }

  return { ok: true, value };
}
