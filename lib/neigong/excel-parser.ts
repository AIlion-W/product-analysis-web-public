import readXlsxFile from "read-excel-file/browser";
import { strFromU8 } from "fflate";

import type {
  CompletenessStatus,
  ParsedProductPack,
  ProductRole,
  QuestionRow,
  ReviewRow,
  ReviewSort,
  SourceKind,
  SourceMapping,
  SourceSummary,
} from "./types";
// Node contract tests execute source TypeScript directly; runtime imports need extensions.
// @ts-expect-error TS5097 is a no-emit bundler restriction.
import {
  MAX_XLSX_COMPRESSED_BYTES,
  extractValidatedXlsxArchive,
  type ValidatedXlsxArchive,
  XlsxArchiveError,
} from "./xlsx-archive.ts";

export const REVIEW_SHEETS = ["默认排序评价", "时间排序评价"] as const;
export const REVIEW_COLUMNS = [
  "rank",
  "nickname",
  "date",
  "reviewType",
  "sku",
  "initialText",
  "followupText",
] as const;

export interface ProductPackFiles {
  product: { productId: string; role: ProductRole; name: string };
  defaultReviewFile?: File;
  recentReviewFile?: File;
  /** @deprecated 兼容旧版双工作表评价工作簿。新界面使用两个独立评价文件。 */
  reviewFile?: File;
  questionFile?: File;
  screenshotFile?: File;
  ignoredFiles?: File[];
}

export interface ParsedRows<T> {
  rows: T[];
  columns: SourceMapping["columns"];
  rowsRead: number;
  excludedRows: Array<{ rowId: string; sourceId: string; reason: string }>;
  excludedOverLimit: number;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

type ParserError = { code: string; message: string };
type ExcludedRow = { rowId: string; sourceId: string; reason: string };

const REVIEW_HEADER_MAP: Record<string, (typeof REVIEW_COLUMNS)[number]> = {
  序号: "rank",
  排名: "rank",
  用户昵称: "nickname",
  旺旺号: "nickname",
  买家昵称: "nickname",
  昵称: "nickname",
  评价时间: "date",
  初评时间: "date",
  评论时间: "date",
  评价类型: "reviewType",
  评论类型: "reviewType",
  SKU: "sku",
  商品规格: "sku",
  规格: "sku",
  初评内容: "initialText",
  初评: "initialText",
  评价内容: "initialText",
  评论内容: "initialText",
  追评内容: "followupText",
  追评: "followupText",
  追加评价: "followupText",
  追加评论: "followupText",
};

type QuestionColumn = "rank" | "nickname" | "questionText" | "answer" | "date";

const QUESTION_HEADER_MAP: Record<string, QuestionColumn> = {
  序号: "rank",
  排名: "rank",
  昵称: "nickname",
  时间: "date",
  问题: "questionText",
  回答: "answer",
  问答: "answer",
  提问时间: "date",
};

function sourceIdFor(productId: string, kind: SourceKind): string {
  return `${productId}:${kind}`;
}

function reviewKindFor(sort: ReviewSort): SourceKind {
  return sort === "default" ? "default_reviews" : "recent_reviews";
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function rankValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const text = textValue(value);
  if (!/^\d+$/u.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|apos|gt|lt|quot);/giu, (entity, decimal, hexadecimal) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    return ({ "&amp;": "&", "&apos;": "'", "&gt;": ">", "&lt;": "<", "&quot;": '"' })[entity.toLowerCase()] ?? entity;
  });
}

type XmlTag = {
  name: string;
  localName: string;
  attributes: ReadonlyMap<string, string>;
  closing: boolean;
  selfClosing: boolean;
};

function xmlError(message: string): never {
  throw new Error(`UNSAFE_FORMULA_SCAN：${message}`);
}

function parseXmlAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;
    const name = source.slice(index).match(/^[A-Za-z_][\w:.-]*/u)?.[0];
    if (!name) xmlError("属性名称不合法。");
    index += name.length;
    while (/\s/u.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") xmlError(`属性 ${name} 缺少等号。`);
    index += 1;
    while (/\s/u.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") xmlError(`属性 ${name} 必须使用引号。`);
    const valueStart = index + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) xmlError(`属性 ${name} 缺少闭合引号。`);
    if (attributes.has(name)) xmlError(`属性 ${name} 重复。`);
    attributes.set(name, decodeXmlAttribute(source.slice(valueStart, valueEnd)));
    index = valueEnd + 1;
  }
  return attributes;
}

function scanXmlTags(xml: string): XmlTag[] {
  const tags: XmlTag[] = [];
  const stack: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0) xmlError("XML 注释未闭合。");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      if (end < 0) xmlError("CDATA 未闭合。");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) xmlError("XML 声明未闭合。");
      cursor = end + 2;
      continue;
    }

    let end = start + 1;
    let quote = "";
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= xml.length || quote) xmlError("XML 标签或属性引号未闭合。");

    let body = xml.slice(start + 1, end).trim();
    if (!body) xmlError("XML 标签为空。");
    if (body.startsWith("!")) {
      cursor = end + 1;
      continue;
    }
    const closing = body.startsWith("/");
    if (closing) body = body.slice(1).trimStart();
    const selfClosing = !closing && body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1).trimEnd();
    const name = body.match(/^[A-Za-z_][\w:.-]*/u)?.[0];
    if (!name) xmlError("XML 元素名称不合法。");
    const attributes = closing
      ? new Map<string, string>()
      : parseXmlAttributes(body.slice(name.length));
    const tag = {
      name,
      localName: name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name,
      attributes,
      closing,
      selfClosing,
    };

    if (closing) {
      if (body.slice(name.length).trim()) xmlError(`结束标签 ${name} 含非法内容。`);
      if (stack.pop() !== name) xmlError(`结束标签 ${name} 与开始标签不匹配。`);
    } else if (!selfClosing) {
      stack.push(name);
    }
    tags.push(tag);
    cursor = end + 1;
  }
  if (stack.length) xmlError(`XML 元素 ${stack.at(-1)} 未闭合。`);
  return tags;
}

function resolveArchivePath(base: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${base}/${target}`).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

function formulaCellsBySheet(archive: ValidatedXlsxArchive): Map<string, ReadonlySet<string>> {
  const workbookBytes = archive["xl/workbook.xml"];
  const relationshipsBytes = archive["xl/_rels/workbook.xml.rels"];
  if (!workbookBytes || !relationshipsBytes) xmlError("工作簿缺少 workbook.xml 或 relationships。");

  const workbook = strFromU8(workbookBytes);
  const relationships = strFromU8(relationshipsBytes);
  const targets = new Map<string, string>();
  for (const tag of scanXmlTags(relationships)) {
    if (tag.closing || tag.localName !== "Relationship") continue;
    const id = tag.attributes.get("Id");
    const target = tag.attributes.get("Target");
    if (id && target) targets.set(id, resolveArchivePath("xl", target));
  }

  const bySheet = new Map<string, ReadonlySet<string>>();
  for (const tag of scanXmlTags(workbook)) {
    if (tag.closing || tag.localName !== "sheet") continue;
    const name = tag.attributes.get("name");
    const relationshipId = tag.attributes.get("r:id");
    const sheetPath = relationshipId ? targets.get(relationshipId) : undefined;
    const sheetBytes = sheetPath ? archive[sheetPath] : undefined;
    if (!name || !relationshipId || !sheetPath || !sheetBytes) {
      xmlError(`工作表 ${name ?? "（未知）"} 的 relationship 无法解析。`);
    }

    const cells = new Set<string>();
    const sheetXml = strFromU8(sheetBytes);
    let currentCell: { reference?: string; formula: boolean } | undefined;
    for (const sheetTag of scanXmlTags(sheetXml)) {
      if (!sheetTag.closing && sheetTag.localName === "c") {
        if (currentCell) xmlError(`工作表 ${name} 包含嵌套单元格。`);
        currentCell = { reference: sheetTag.attributes.get("r"), formula: false };
        if (sheetTag.selfClosing) currentCell = undefined;
        continue;
      }
      if (!sheetTag.closing && sheetTag.localName === "f" && currentCell) {
        currentCell.formula = true;
        continue;
      }
      if (sheetTag.closing && sheetTag.localName === "c") {
        if (!currentCell) xmlError(`工作表 ${name} 的单元格结束标签无对应开始标签。`);
        if (currentCell.formula) {
          if (!currentCell.reference) xmlError(`工作表 ${name} 的公式单元格缺少坐标。`);
          cells.add(currentCell.reference.toUpperCase());
        }
        currentCell = undefined;
      }
    }
    if (currentCell) xmlError(`工作表 ${name} 的单元格未闭合。`);
    bySheet.set(name, cells);
  }
  if (!bySheet.size) xmlError("工作簿未解析到工作表。");
  return bySheet;
}

function scanFormulaCells(
  archive: ValidatedXlsxArchive,
  fileName: string,
): { cells?: Map<string, ReadonlySet<string>>; error?: ParserError } {
  try {
    return { cells: formulaCellsBySheet(archive) };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("UNSAFE_FORMULA_SCAN：")) throw error;
    return {
      error: {
        code: "UNSAFE_FORMULA_SCAN",
        message: `工作簿「${fileName}」无法安全判定公式排名：${error.message.slice("UNSAFE_FORMULA_SCAN：".length)}`,
      },
    };
  }
}

type WorkbookSheet = { sheet: string; data: unknown[][] };

async function readWorkbookFile(file: File): Promise<{
  sheets?: WorkbookSheet[];
  formulaCells?: Map<string, ReadonlySet<string>>;
  error?: ParserError;
}> {
  if (file.size > MAX_XLSX_COMPRESSED_BYTES) {
    return {
      error: {
        code: "XLSX_ARCHIVE_LIMIT",
        message: `工作簿「${file.name}」压缩文件超过 ${MAX_XLSX_COMPRESSED_BYTES} bytes。`,
      },
    };
  }

  let buffer: ArrayBuffer;
  let archive: ValidatedXlsxArchive;
  try {
    buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_XLSX_COMPRESSED_BYTES) {
      throw new XlsxArchiveError(
        "XLSX_ARCHIVE_LIMIT",
        `XLSX 压缩文件超过 ${MAX_XLSX_COMPRESSED_BYTES} bytes。`,
      );
    }
    archive = extractValidatedXlsxArchive(buffer);
  } catch (error) {
    const archiveError = error instanceof XlsxArchiveError
      ? error
      : new XlsxArchiveError("UNSAFE_XLSX_ARCHIVE", error instanceof Error ? error.message : "无法读取工作簿。");
    return {
      error: {
        code: archiveError.code,
        message: `工作簿「${file.name}」预检失败：${archiveError.message}`,
      },
    };
  }

  const formulaScan = scanFormulaCells(archive, file.name);
  if (formulaScan.error) return { error: formulaScan.error };
  try {
    const sheets = await readXlsxFile(buffer) as WorkbookSheet[];
    return { sheets, formulaCells: formulaScan.cells };
  } catch (error) {
    return {
      error: {
        code: "UNSAFE_XLSX_ARCHIVE",
        message: `工作簿「${file.name}」无法安全解压：${error instanceof Error ? error.message : "格式错误"}`,
      },
    };
  }
}

function cellReference(columnIndex: number, row: number): string {
  let index = columnIndex + 1;
  let column = "";
  while (index > 0) {
    index -= 1;
    column = String.fromCharCode(65 + (index % 26)) + column;
    index = Math.floor(index / 26);
  }
  return `${column}${row}`;
}

function headerIndex<T extends string>(
  header: unknown[] | undefined,
  columns: Record<string, T>,
  required: readonly T[],
  options: { ignoreUnknown?: boolean } = {},
): {
  indexes: Partial<Record<T, number>>;
  columns: SourceMapping["columns"];
  errors: ParserError[];
  warnings: ParserError[];
} {
  const errors: ParserError[] = [];
  const warnings: ParserError[] = [];
  const indexes: Partial<Record<T, number>> = {};
  const mappedColumns: SourceMapping["columns"] = [];

  if (!header) {
    return {
      indexes,
      columns: mappedColumns,
      errors: [{ code: "MISSING_HEADER", message: "工作表缺少表头。" }],
      warnings,
    };
  }

  header.forEach((cell, index) => {
    const name = cell === null || cell === undefined ? "" : String(cell);
    const normalizedName = name.normalize("NFKC").trim();
    const column = columns[normalizedName];
    if (!column) {
      const issue = options.ignoreUnknown
        ? { code: "IGNORED_COLUMN", message: `已忽略非分析列：${normalizedName || "（空）"}。` }
        : { code: "UNKNOWN_COLUMN", message: `不支持的列名：${normalizedName || "（空）"}。` };
      (options.ignoreUnknown ? warnings : errors).push(issue);
      return;
    }
    if (indexes[column] !== undefined) {
      errors.push({ code: "DUPLICATE_COLUMN", message: `多个列名映射到同一字段：${normalizedName}。` });
      return;
    }
    indexes[column] = index;
    mappedColumns.push({ field: column, header: normalizedName });
  });

  for (const column of required) {
    if (indexes[column] === undefined) {
      errors.push({ code: "MISSING_COLUMN", message: `缺少必填列：${column}。` });
    }
  }

  return { indexes, columns: mappedColumns, errors, warnings };
}

function excluded(rowId: string, sourceId: string, reason: string): ExcludedRow {
  return { rowId, sourceId, reason };
}

function summary(
  productId: string,
  kind: SourceKind,
  rowsRead: number,
  usedRows: number,
  excludedRows: number,
  excludedOverLimit: number,
  note: string,
): SourceSummary {
  return {
    sourceId: sourceIdFor(productId, kind),
    productId,
    kind,
    rowsRead,
    validRows: usedRows + excludedOverLimit,
    usedRows,
    excludedRows,
    excludedOverLimit,
    status: statusForUsedRows(usedRows),
    note,
  };
}

function sourceSummaryFromParsed(
  productId: string,
  kind: SourceKind,
  parsed: ParsedRows<unknown>,
): SourceSummary {
  return summary(
    productId,
    kind,
    parsed.rowsRead,
    parsed.rows.length,
    parsed.excludedRows.length,
    parsed.excludedOverLimit,
    parsed.errors.length ? "存在需要修正的列或数据。" : "已完成预检。",
  );
}

export function normalizeExactText(value: string): string {
  return value.normalize("NFKC").replace(/\s/gu, "");
}

export function statusForUsedRows(usedRows: number): CompletenessStatus {
  if (usedRows === 0) return "missing";
  if (usedRows < 90) return "insufficient";
  if (usedRows < 100) return "provisional";
  return "complete";
}

export function parseReviewRows(
  productId: string,
  sort: ReviewSort,
  rows: unknown[][],
  formulaCells: ReadonlySet<string> = new Set(),
): ParsedRows<ReviewRow> {
  const kind = reviewKindFor(sort);
  const sourceId = sourceIdFor(productId, kind);
  const { indexes, columns, errors, warnings } = headerIndex(
    rows[0],
    REVIEW_HEADER_MAP,
    REVIEW_COLUMNS,
    { ignoreUnknown: true },
  );
  const sourceLabel = sort === "default" ? "默认排序评价" : "时间排序评价";
  const result: ParsedRows<ReviewRow> = {
    rows: [],
    columns,
    rowsRead: Math.max(rows.length - 1, 0),
    excludedRows: [],
    excludedOverLimit: 0,
    errors,
    warnings: warnings.map((warning) => ({
      ...warning,
      message: `${sourceLabel}：${warning.message}`,
    })),
  };

  if (errors.length) return result;

  const usedRanks = new Set<number>();
  rows.slice(1).forEach((row, index) => {
    const sourceRow = index + 2;
    const rowId = `${sourceId}:${sourceRow}`;
    const rank = rankValue(row[indexes.rank!]);
    const initialText = textValue(row[indexes.initialText!]);

    if (formulaCells.has(cellReference(indexes.rank!, sourceRow))) {
      result.excludedRows.push(excluded(rowId, sourceId, "FORMULA_RANK"));
      return;
    }
    if (!rank) {
      result.excludedRows.push(excluded(rowId, sourceId, "MISSING_RANK"));
      return;
    }
    if (!initialText) {
      result.excludedRows.push(excluded(rowId, sourceId, "EMPTY_INITIAL_TEXT"));
      return;
    }
    if (usedRanks.has(rank)) {
      result.excludedRows.push(excluded(rowId, sourceId, "DUPLICATE_RANK"));
      return;
    }
    if (result.rows.length >= 100) {
      result.excludedOverLimit += 1;
      result.excludedRows.push(excluded(rowId, sourceId, "OVER_LIMIT"));
      return;
    }

    usedRanks.add(rank);
    result.rows.push({
      rowId,
      sourceId,
      sourceRow,
      productId,
      sort,
      rank,
      date: textValue(row[indexes.date!]),
      sku: textValue(row[indexes.sku!]),
      initialText,
      followupText: textValue(row[indexes.followupText!]),
      normalizedText: normalizeExactText(initialText),
    });
  });

  return result;
}

export function parseQuestionRows(
  productId: string,
  rows: unknown[][],
  formulaCells: ReadonlySet<string> = new Set(),
): ParsedRows<QuestionRow> {
  const kind: SourceKind = "questions";
  const sourceId = sourceIdFor(productId, kind);
  const rawHeader = rows[0] ?? [];
  const normalizedHeader = rawHeader.map((cell) => normalizeExactText(textValue(cell)));
  const ranklessProfile = normalizedHeader.length === 4
    && normalizedHeader.every((name, index) => name === ["昵称", "时间", "问题", "问答"][index]);
  const hasExplicitRank = rawHeader.some((cell) => cell === "序号" || cell === "排名");
  const required: readonly QuestionColumn[] = ranklessProfile
    ? ["nickname", "date", "questionText", "answer"]
    : ["rank", "questionText", "answer", "date"];
  const indexed = headerIndex(ranklessProfile ? normalizedHeader : rawHeader, QUESTION_HEADER_MAP, required);
  const indexes = indexed.indexes;
  const columns = ranklessProfile
    ? indexed.columns.map((column, index) => ({ ...column, header: textValue(rawHeader[index]) }))
    : indexed.columns;
  const errors = [...indexed.errors];
  if (!ranklessProfile && !hasExplicitRank) {
    errors.unshift({
      code: "INVALID_QUESTION_HEADER_PROFILE",
      message: "无排名列时，问大家必须恰好包含「昵称／时间／问题／问答」四列。",
    });
  }
  const result: ParsedRows<QuestionRow> = {
    rows: [],
    columns,
    rowsRead: Math.max(rows.length - 1, 0),
    excludedRows: [],
    excludedOverLimit: 0,
    errors,
    warnings: indexed.warnings,
  };

  if (errors.length) return result;

  const usedRanks = new Set<number>();
  rows.slice(1).forEach((row, index) => {
    const sourceRow = index + 2;
    const rowId = `${sourceId}:${sourceRow}`;
    const rank = indexes.rank === undefined ? index + 1 : rankValue(row[indexes.rank]);
    const questionText = textValue(row[indexes.questionText!]);
    const answer = textValue(row[indexes.answer!]);

    if (indexes.rank !== undefined && formulaCells.has(cellReference(indexes.rank, sourceRow))) {
      result.excludedRows.push(excluded(rowId, sourceId, "FORMULA_RANK"));
      return;
    }
    if (!rank) {
      result.excludedRows.push(excluded(rowId, sourceId, "MISSING_RANK"));
      return;
    }
    if (!questionText) {
      result.excludedRows.push(excluded(rowId, sourceId, "EMPTY_QUESTION_TEXT"));
      return;
    }
    if (!answer) {
      result.excludedRows.push(excluded(rowId, sourceId, "EMPTY_ANSWER"));
      return;
    }
    if (usedRanks.has(rank)) {
      result.excludedRows.push(excluded(rowId, sourceId, "DUPLICATE_RANK"));
      return;
    }
    if (result.rows.length >= 100) {
      result.excludedOverLimit += 1;
      result.excludedRows.push(excluded(rowId, sourceId, "OVER_LIMIT"));
      return;
    }

    usedRanks.add(rank);
    result.rows.push({
      rowId,
      sourceId,
      sourceRow,
      productId,
      rank,
      questionText,
      answer,
      date: textValue(row[indexes.date!]),
      normalizedText: normalizeExactText(questionText),
    });
  });

  return result;
}

function isTemporaryFile(file: File | undefined): boolean {
  return Boolean(file && (file.name.startsWith(".~") || file.name.startsWith("~$")));
}

function missingSource(productId: string, kind: SourceKind, note: string): SourceSummary {
  return summary(productId, kind, 0, 0, 0, 0, note);
}

function mergeParsed<T>(
  parsed: ParsedRows<T>,
  output: Pick<ParsedProductPack, "excludedRows" | "errors" | "warnings">,
): void {
  output.excludedRows.push(...parsed.excludedRows);
  output.errors.push(...parsed.errors);
  output.warnings.push(...parsed.warnings);
}

async function parseIndependentReviewFile(
  productId: string,
  sort: ReviewSort,
  file: File | undefined,
  label: string,
  result: ParsedProductPack,
): Promise<void> {
  const kind = reviewKindFor(sort);
  if (!file) {
    const message = `缺少${label} Excel。`;
    result.errors.push({ code: "MISSING_REVIEW_FILE", message });
    result.sources.push(missingSource(productId, kind, message));
    return;
  }

  const workbook = await readWorkbookFile(file);
  if (workbook.error) {
    result.errors.push(workbook.error);
    result.sources.push(missingSource(productId, kind, workbook.error.message));
    return;
  }

  const firstSheet = workbook.sheets?.[0];
  if (!firstSheet) {
    const message = `${label} Excel 为空。`;
    result.errors.push({ code: "MISSING_REVIEW_SHEET", message });
    result.sources.push(missingSource(productId, kind, message));
    return;
  }

  const parsed = parseReviewRows(productId, sort, firstSheet.data, workbook.formulaCells?.get(firstSheet.sheet));
  result.reviews.push(...parsed.rows);
  result.sources.push(sourceSummaryFromParsed(productId, kind, parsed));
  result.sourceMappings.push({
    sourceId: sourceIdFor(productId, kind),
    fileName: file.name,
    sheetName: firstSheet.sheet,
    columns: parsed.columns,
  });
  mergeParsed(parsed, result);
}

export async function parseProductPack(input: ProductPackFiles): Promise<ParsedProductPack> {
  const { product } = input;
  const result: ParsedProductPack = {
    product,
    reviews: [],
    questions: [],
    sources: [],
    sourceMappings: [],
    excludedRows: [],
    errors: [],
    warnings: [],
  };

  const defaultReviewFile = isTemporaryFile(input.defaultReviewFile) ? undefined : input.defaultReviewFile;
  const recentReviewFile = isTemporaryFile(input.recentReviewFile) ? undefined : input.recentReviewFile;
  const usesIndependentReviewFiles = Boolean(input.defaultReviewFile || input.recentReviewFile);
  for (const file of [input.defaultReviewFile, input.recentReviewFile]) {
    if (isTemporaryFile(file)) {
      result.warnings.push({ code: "TEMPORARY_FILE_IGNORED", message: `已忽略临时锁文件：${file!.name}。` });
    }
  }

  const reviewFile = isTemporaryFile(input.reviewFile) ? undefined : input.reviewFile;
  if (isTemporaryFile(input.reviewFile)) {
    result.warnings.push({ code: "TEMPORARY_FILE_IGNORED", message: `已忽略临时锁文件：${input.reviewFile!.name}。` });
  }
  for (const file of input.ignoredFiles ?? []) {
    if (isTemporaryFile(file)) {
      result.warnings.push({ code: "TEMPORARY_FILE_IGNORED", message: `已忽略临时锁文件：${file.name}。` });
    }
  }

  if (usesIndependentReviewFiles) {
    await parseIndependentReviewFile(product.productId, "default", defaultReviewFile, "默认排序评价", result);
    await parseIndependentReviewFile(product.productId, "recent", recentReviewFile, "时间排序评价", result);
  } else if (!reviewFile) {
    result.errors.push({ code: "MISSING_REVIEW_FILE", message: "缺少评价工作簿。" });
    result.sources.push(
      missingSource(product.productId, "default_reviews", "缺少评价工作簿。"),
      missingSource(product.productId, "recent_reviews", "缺少评价工作簿。"),
    );
  } else {
    const workbook = await readWorkbookFile(reviewFile);
    if (workbook.error) {
      result.errors.push(workbook.error);
      result.sources.push(
        missingSource(product.productId, "default_reviews", workbook.error.message),
        missingSource(product.productId, "recent_reviews", workbook.error.message),
      );
    } else {
      const sheets = workbook.sheets!;
      const sheetNames = sheets.map((sheet) => sheet.sheet);
      const requiredIndexes = REVIEW_SHEETS.map((name) => sheetNames.indexOf(name));
      const foundIndexes = requiredIndexes.filter((index) => index >= 0);
      if (foundIndexes.length === REVIEW_SHEETS.length && foundIndexes[0] > foundIndexes[1]) {
        result.errors.push({ code: "RANK_ORDER_CONFLICT", message: "评价工作表顺序与排名字段冲突。" });
      }

      for (const [sheetIndex, sheetName] of REVIEW_SHEETS.entries()) {
        const sort: ReviewSort = sheetIndex === 0 ? "default" : "recent";
        const kind = reviewKindFor(sort);
        const matched = sheets.find((sheet) => sheet.sheet === sheetName);
        if (!matched) {
          result.errors.push({ code: "MISSING_REVIEW_SHEET", message: `缺少评价工作表：${sheetName}。` });
          result.sources.push(missingSource(product.productId, kind, `缺少评价工作表：${sheetName}。`));
          continue;
        }
        const parsed = parseReviewRows(product.productId, sort, matched.data, workbook.formulaCells!.get(matched.sheet));
        result.reviews.push(...parsed.rows);
        result.sources.push(sourceSummaryFromParsed(product.productId, kind, parsed));
        result.sourceMappings.push({
          sourceId: sourceIdFor(product.productId, kind),
          fileName: reviewFile.name,
          sheetName: matched.sheet,
          columns: parsed.columns,
        });
        mergeParsed(parsed, result);
      }
    }
  }

  const questionFile = isTemporaryFile(input.questionFile) ? undefined : input.questionFile;
  if (isTemporaryFile(input.questionFile)) {
    result.warnings.push({ code: "TEMPORARY_FILE_IGNORED", message: `已忽略临时锁文件：${input.questionFile!.name}。` });
  }
  if (!questionFile) {
    result.sources.push(missingSource(product.productId, "questions", "缺少问大家工作簿。"));
    result.warnings.push({ code: "MISSING_QUESTION_FILE", message: "缺少问大家工作簿。" });
  } else {
    const workbook = await readWorkbookFile(questionFile);
    if (workbook.error) {
      result.errors.push(workbook.error);
      result.sources.push(missingSource(product.productId, "questions", workbook.error.message));
    } else {
      const sheets = workbook.sheets!;
      const firstSheet = sheets[0];
      if (!firstSheet) {
        result.sources.push(missingSource(product.productId, "questions", "问大家工作簿为空。"));
        result.warnings.push({ code: "EMPTY_QUESTION_WORKBOOK", message: "问大家工作簿为空。" });
      } else {
        const parsed = parseQuestionRows(product.productId, firstSheet.data, workbook.formulaCells!.get(firstSheet.sheet));
        result.questions.push(...parsed.rows);
        result.sources.push(sourceSummaryFromParsed(product.productId, "questions", parsed));
        result.sourceMappings.push({
          sourceId: sourceIdFor(product.productId, "questions"),
          fileName: questionFile.name,
          sheetName: firstSheet.sheet,
          columns: parsed.columns,
        });
        mergeParsed(parsed, result);
      }
    }
  }

  if (input.screenshotFile && !isTemporaryFile(input.screenshotFile)) {
    result.screenshot = {
      file: input.screenshotFile,
      sourceId: sourceIdFor(product.productId, "review_tags"),
      status: "ready",
    };
  } else {
    if (isTemporaryFile(input.screenshotFile)) {
      result.warnings.push({ code: "TEMPORARY_FILE_IGNORED", message: `已忽略临时锁文件：${input.screenshotFile!.name}。` });
    }
    result.warnings.push({ code: "MISSING_SCREENSHOT_FILE", message: "缺少评价标签截图。" });
  }

  return result;
}
