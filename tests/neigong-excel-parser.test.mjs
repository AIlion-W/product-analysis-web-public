import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { buildExcelWorkbook } from "../lib/excel-export.ts";
import {
  parseProductPack,
  parseQuestionRows,
  parseReviewRows,
  statusForUsedRows,
} from "../lib/neigong/excel-parser.ts";
import {
  MAX_XLSX_COMPRESSED_BYTES,
  MAX_XLSX_COMPRESSION_RATIO,
  MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES,
  MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES,
} from "../lib/neigong/xlsx-archive.ts";

const reviewHeader = ["序号", "用户昵称", "评价时间", "评价类型", "SKU", "初评内容", "追评内容"];
const questionHeader = ["排名", "问题", "回答", "提问时间"];

function workbookFile(markdown, name) {
  return new File([buildExcelWorkbook(markdown, name)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function withFormulaCells(file, replacements) {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  for (const { sheetPath, cell, formula, cachedValue } of replacements) {
    const source = strFromU8(archive[sheetPath]);
    const cellPattern = new RegExp(`<c([^>]*\\br="${cell}"[^>]*)>[\\s\\S]*?<\\/c>`, "u");
    const updated = source.replace(cellPattern, (_match, attributes) => {
      const withoutType = attributes.replace(/\s+t="[^"]*"/u, "");
      return `<c${withoutType} t="str"><f>${formula}</f><v>${cachedValue}</v></c>`;
    });
    assert.notEqual(updated, source, `fixture cell ${sheetPath}:${cell} must exist`);
    archive[sheetPath] = strToU8(updated);
  }
  return new File([zipSync(archive)], file.name, { type: file.type });
}

async function rewriteWorkbookXml(file, rewrite) {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  for (const [path, bytes] of Object.entries(archive)) {
    if (!path.endsWith(".xml") && !path.endsWith(".rels")) continue;
    archive[path] = strToU8(rewrite(path, strFromU8(bytes)));
  }
  return new File([zipSync(archive)], file.name, { type: file.type });
}

async function singleQuotedFormulaFixture(file, reorderedCells = []) {
  return rewriteWorkbookXml(file, (path, xml) => {
    let updated = xml.replace(/="([^"']*)"/gu, "='$1'");
    if (path.startsWith("xl/worksheets/")) {
      for (const cell of reorderedCells) {
        updated = updated.replace(
          new RegExp(`<c([^>]*)\\br='${cell}'([^>]*)>`, "u"),
          (_match, before, after) => `<c${before}${after} r='${cell}'>`,
        );
      }
    }
    return updated;
  });
}

async function rewriteCentralDirectory(file, rewrite) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  assert.ok(eocd >= 0);
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50);
    rewrite({ view, cursor, index, entryCount });
    cursor += 46
      + view.getUint16(cursor + 28, true)
      + view.getUint16(cursor + 30, true)
      + view.getUint16(cursor + 32, true);
  }
  return new File([bytes], file.name, { type: file.type });
}

async function rewriteLocalAndCentral(file, rewrite) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  assert.ok(eocd >= 0);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50);
    const localOffset = view.getUint32(cursor + 42, true);
    assert.equal(view.getUint32(localOffset, true), 0x04034b50);
    rewrite({ view, bytes, cursor, localOffset, centralOffset, index, entryCount });
    cursor += 46
      + view.getUint16(cursor + 28, true)
      + view.getUint16(cursor + 30, true)
      + view.getUint16(cursor + 32, true);
  }
  return new File([bytes], file.name, { type: file.type });
}

function aliasedStoredArchive(entryCount = 2_000) {
  const encoder = new TextEncoder();
  const localName = encoder.encode("shared");
  const names = Array.from({ length: entryCount }, (_, index) => (
    index === 0 ? localName : encoder.encode(`alias-${String(index).padStart(4, "0")}`)
  ));
  const localLength = 30 + localName.length;
  const centralLength = names.reduce((total, name) => total + 46 + name.length, 0);
  const bytes = new Uint8Array(localLength + centralLength + 22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(26, localName.length, true);
  bytes.set(localName, 30);

  let cursor = localLength;
  for (const name of names) {
    view.setUint32(cursor, 0x02014b50, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 20, true);
    view.setUint16(cursor + 28, name.length, true);
    view.setUint32(cursor + 42, 0, true);
    bytes.set(name, cursor + 46);
    cursor += 46 + name.length;
  }
  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 8, entryCount, true);
  view.setUint16(cursor + 10, entryCount, true);
  view.setUint32(cursor + 12, centralLength, true);
  view.setUint32(cursor + 16, localLength, true);
  return new File([bytes], "aliased-stored.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function downwardDeclaredDeflateArchive() {
  const bytes = zipSync({
    "bomb.bin": new Uint8Array(MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES + 1),
  }, { level: 9 });
  const file = new File([bytes], "downward-declared.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return rewriteLocalAndCentral(file, ({ view, cursor, localOffset }) => {
    assert.equal(view.getUint16(cursor + 10, true), 8);
    view.setUint32(cursor + 24, 1, true);
    view.setUint32(localOffset + 22, 1, true);
  });
}

function standardReviewWorkbook(name = "archive-budget.xlsx") {
  return workbookFile(`
## 默认排序评价

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 用户A | 2026-08-01 | 好评 | 规格A | 去屑很快 | |

## 时间排序评价

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 用户B | 2026-08-02 | 好评 | 规格B | 控油不错 | |
`, name);
}

function singleReviewWorkbook(sheetName, initialText, name) {
  return workbookFile(`
## ${sheetName}

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 用户A | 2026-08-01 | 好评 | 规格A | ${initialText} | |
`, name);
}

test("keeps an initial review as one primary row and followup only as context", () => {
  const result = parseReviewRows("own", "default", [
    reviewHeader,
    [1, "用户A", "2026-08-01", "好评", "规格A", "  去 屑 很快  ", "12"],
  ]);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].initialText, "去 屑 很快");
  assert.equal(result.rows[0].followupText, "12");
  assert.equal(result.rows[0].normalizedText, "去屑很快");
});

test("distinguishes all four completeness boundaries", () => {
  assert.equal(statusForUsedRows(0), "missing");
  assert.equal(statusForUsedRows(89), "insufficient");
  assert.equal(statusForUsedRows(90), "provisional");
  assert.equal(statusForUsedRows(99), "provisional");
  assert.equal(statusForUsedRows(100), "complete");
});

test("records missing required review columns and blank initial reviews as exclusions", () => {
  const missingColumn = parseReviewRows("own", "default", [
    [...reviewHeader.slice(0, 6), "内容"],
    [1, "用户A", "2026-08-01", "好评", "规格A", "有效", "追评"],
  ]);
  const blankInitial = parseReviewRows("own", "default", [
    reviewHeader,
    [1, "用户A", "2026-08-01", "好评", "规格A", " ", "追评"],
  ]);

  assert.equal(missingColumn.rows.length, 0);
  assert.equal(missingColumn.errors.some(({ code }) => code === "MISSING_COLUMN"), true);
  assert.equal(blankInitial.excludedRows[0].reason, "EMPTY_INITIAL_TEXT");
});

test("accepts 排名 as the rank alias and excludes rows with no rank", () => {
  const rows = parseReviewRows("own", "recent", [
    ["排名", ...reviewHeader.slice(1)],
    [1, "用户A", "2026-08-02", "好评", "规格A", "有效", ""],
    ["", "用户B", "2026-08-02", "好评", "规格A", "无效", ""],
  ]);

  assert.equal(rows.rows[0].rank, 1);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.excludedRows[0].reason, "MISSING_RANK");
});

test("平台评价表别名自动映射，非分析辅助列只警告不阻断", () => {
  const result = parseReviewRows("competitor-a", "default", [
    ["序号", "旺旺号", "初评时间", "评价类型", "SKU", "初评", "晒图/视频", "有用", "追评", "追评时间", "追评晒图/视频"],
    [1, "买家A", "2026-08-12", "好评", "规格A", "去屑效果明显", "[]", 3, "后续没有复发", "2026-08-15", "[]"],
  ]);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map(({ rank, date, sku, initialText, followupText }) => ({
    rank,
    date,
    sku,
    initialText,
    followupText,
  })), [{
    rank: 1,
    date: "2026-08-12",
    sku: "规格A",
    initialText: "去屑效果明显",
    followupText: "后续没有复发",
  }]);
  assert.deepEqual(result.columns, [
    { field: "rank", header: "序号" },
    { field: "nickname", header: "旺旺号" },
    { field: "date", header: "初评时间" },
    { field: "reviewType", header: "评价类型" },
    { field: "sku", header: "SKU" },
    { field: "initialText", header: "初评" },
    { field: "followupText", header: "追评" },
  ]);
  assert.deepEqual(result.warnings, [
    { code: "IGNORED_COLUMN", message: "默认排序评价：已忽略非分析列：晒图/视频。" },
    { code: "IGNORED_COLUMN", message: "默认排序评价：已忽略非分析列：有用。" },
    { code: "IGNORED_COLUMN", message: "默认排序评价：已忽略非分析列：追评时间。" },
    { code: "IGNORED_COLUMN", message: "默认排序评价：已忽略非分析列：追评晒图/视频。" },
  ]);
});

test("评价表头容忍全角与首尾空格，但同一字段的两个别名仍阻断", () => {
  const normalized = parseReviewRows("own", "recent", [
    ["　序号　", " 旺旺号 ", "初评时间", "评价类型", "ＳＫＵ", " 初评 ", "追评", "渠道备注"],
    [1, "买家A", "2026-08-12", "好评", "规格A", "控油不错", "", "活动批次"],
  ]);
  const ambiguous = parseReviewRows("own", "recent", [
    ["序号", "用户昵称", "旺旺号", "评价时间", "评价类型", "SKU", "初评内容", "追评内容"],
    [1, "买家A", "买家A", "2026-08-12", "好评", "规格A", "控油不错", ""],
  ]);

  assert.equal(normalized.rows.length, 1);
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.warnings, [{
    code: "IGNORED_COLUMN",
    message: "时间排序评价：已忽略非分析列：渠道备注。",
  }]);
  assert.equal(ambiguous.rows.length, 0);
  assert.equal(ambiguous.errors.some(({ code }) => code === "DUPLICATE_COLUMN"), true);
});

test("重复 rank 只保留首条，负数和公式 rank 都按无效行排除", () => {
  const reviews = parseReviewRows("own", "default", [
    reviewHeader,
    [1, "用户A", "2026-08-01", "好评", "规格A", "首条", ""],
    [1, "用户B", "2026-08-01", "好评", "规格A", "重复排名", ""],
    [-1, "用户C", "2026-08-01", "好评", "规格A", "负排名", ""],
    ["=1+1", "用户D", "2026-08-01", "好评", "规格A", "公式排名", ""],
  ]);
  const questions = parseQuestionRows("own", [
    questionHeader,
    [1, "首个问题", "回答", "2026-08-01"],
    [1, "重复问题", "回答", "2026-08-01"],
  ]);

  assert.deepEqual(reviews.rows.map((row) => row.initialText), ["首条"]);
  assert.deepEqual(reviews.excludedRows.map((row) => row.reason), [
    "DUPLICATE_RANK",
    "MISSING_RANK",
    "MISSING_RANK",
  ]);
  assert.deepEqual(questions.rows.map((row) => row.questionText), ["首个问题"]);
  assert.equal(questions.excludedRows[0].reason, "DUPLICATE_RANK");
});

test("公式文本只作为普通文本进入解析，不在解析阶段执行", () => {
  const payload = '=HYPERLINK("https://attacker.invalid","click")';
  const result = parseReviewRows("own", "default", [
    reviewHeader,
    [1, "用户A", "2026-08-01", "好评", "规格A", payload, "=1+1"],
  ]);

  assert.equal(result.rows[0].initialText, payload);
  assert.equal(result.rows[0].followupText, "=1+1");
});

test("两个独立评价文件分别按上传角色读取首个工作表", async () => {
  const defaultFile = singleReviewWorkbook("导出的默认排序", "默认评价", "评价数据表格-默认排序.xlsx");
  const recentFile = singleReviewWorkbook("导出的时间排序", "时间评价", "评价数据表格-时间排序.xlsx");

  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    defaultReviewFile: defaultFile,
    recentReviewFile: recentFile,
  });

  assert.deepEqual(parsed.reviews.map(({ sort, initialText }) => ({ sort, initialText })), [
    { sort: "default", initialText: "默认评价" },
    { sort: "recent", initialText: "时间评价" },
  ]);
  assert.deepEqual(parsed.sourceMappings.map(({ fileName, sheetName }) => ({ fileName, sheetName })), [
    { fileName: "评价数据表格-默认排序.xlsx", sheetName: "导出的默认排序" },
    { fileName: "评价数据表格-时间排序.xlsx", sheetName: "导出的时间排序" },
  ]);
  assert.deepEqual(parsed.errors, []);
});

test("独立评价文件缺少一个时只阻断对应数据源", async () => {
  const defaultFile = singleReviewWorkbook("评价数据", "默认评价", "评价数据表格-默认排序.xlsx");

  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    defaultReviewFile: defaultFile,
  });

  assert.deepEqual(parsed.reviews.map(({ sort }) => sort), ["default"]);
  assert.deepEqual(parsed.sources.slice(0, 2).map(({ kind, status }) => ({ kind, status })), [
    { kind: "default_reviews", status: "insufficient" },
    { kind: "recent_reviews", status: "missing" },
  ]);
  assert.deepEqual(parsed.errors, [
    { code: "MISSING_REVIEW_FILE", message: "缺少时间排序评价 Excel。" },
  ]);
});

test("真实 XLSX 的公式 rank 即使含缓存数值也按工作表和单元格排除", async () => {
  const base = workbookFile(`
## 默认排序评价

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | 用户A | 2026-08-01 | 好评 | 规格A | 默认评价 | =普通文本 |
| 4 | 用户C | 2026-08-03 | 好评 | 规格C | 非公式默认评价 | |

## 时间排序评价

| 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 | 排名 |
| --- | --- | --- | --- | --- | --- | --- |
| 用户B | 2026-08-02 | 好评 | 规格B | 时间评价 | =仍是普通文本 | 3 |
| 用户D | 2026-08-04 | 好评 | 规格D | 非公式时间评价 | | 5 |
`, "formula-ranks.xlsx");
  const reviews = await withFormulaCells(base, [
    { sheetPath: "xl/worksheets/sheet1.xml", cell: "A2", formula: "1+1", cachedValue: 2 },
    { sheetPath: "xl/worksheets/sheet2.xml", cell: "G2", formula: "1+2", cachedValue: 3 },
  ]);
  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: reviews,
  });

  assert.deepEqual(parsed.reviews.map(({ sort, rank, sourceRow, initialText }) => ({ sort, rank, sourceRow, initialText })), [
    { sort: "default", rank: 4, sourceRow: 3, initialText: "非公式默认评价" },
    { sort: "recent", rank: 5, sourceRow: 3, initialText: "非公式时间评价" },
  ]);
  assert.deepEqual(parsed.excludedRows, [
    { rowId: "own:default_reviews:2", sourceId: "own:default_reviews", reason: "FORMULA_RANK" },
    { rowId: "own:recent_reviews:2", sourceId: "own:recent_reviews", reason: "FORMULA_RANK" },
  ]);
  assert.equal(parsed.sources[0].rowsRead, 2);
  assert.equal(parsed.sources[1].rowsRead, 2);
});

test("真实 XLSX 单引号属性与属性乱序仍可靠识别三类 rank 公式", async () => {
  const reviewBase = workbookFile(`
## 默认排序评价

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | 用户A | 2026-08-01 | 好评 | 规格A | 默认公式排名 | 普通追评 |
| 4 | 用户C | 2026-08-03 | 好评 | 规格C | 默认有效评价 | 可选公式 |

## 时间排序评价

| 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 | 排名 |
| --- | --- | --- | --- | --- | --- | --- |
| 用户B | 2026-08-02 | 好评 | 规格B | 时间公式排名 | 普通追评 | 3 |
| 用户D | 2026-08-04 | 好评 | 规格D | 时间有效评价 | | 5 |
`, "single-quote-formula-ranks.xlsx");
  const reviewFormulas = await withFormulaCells(reviewBase, [
    { sheetPath: "xl/worksheets/sheet1.xml", cell: "A2", formula: "1+1", cachedValue: 2 },
    { sheetPath: "xl/worksheets/sheet2.xml", cell: "G2", formula: "1+2", cachedValue: 3 },
    { sheetPath: "xl/worksheets/sheet1.xml", cell: "G3", formula: "1+3", cachedValue: 4 },
  ]);
  const reviews = await singleQuotedFormulaFixture(reviewFormulas, ["A2", "G2", "G3"]);

  const questionBase = workbookFile(`
## 问大家

| 问题 | 回答 | 提问时间 | 排名 |
| --- | --- | --- | --- |
| 公式排名问题 | 回答 | 2026-08-01 | 6 |
| 有效问题 | 回答 | 2026-08-02 | 7 |
`, "single-quote-question-rank.xlsx");
  const questionFormulas = await withFormulaCells(questionBase, [
    { sheetPath: "xl/worksheets/sheet1.xml", cell: "D2", formula: "3+3", cachedValue: 6 },
    { sheetPath: "xl/worksheets/sheet1.xml", cell: "C3", formula: "3+4", cachedValue: 7 },
  ]);
  const questions = await singleQuotedFormulaFixture(questionFormulas, ["D2", "C3"]);

  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: reviews,
    questionFile: questions,
  });

  assert.deepEqual(parsed.reviews.map(({ sort, rank, sourceRow }) => ({ sort, rank, sourceRow })), [
    { sort: "default", rank: 4, sourceRow: 3 },
    { sort: "recent", rank: 5, sourceRow: 3 },
  ]);
  assert.deepEqual(parsed.questions.map(({ rank, sourceRow }) => ({ rank, sourceRow })), [
    { rank: 7, sourceRow: 3 },
  ]);
  assert.deepEqual(parsed.excludedRows.map(({ sourceId, reason }) => ({ sourceId, reason })), [
    { sourceId: "own:default_reviews", reason: "FORMULA_RANK" },
    { sourceId: "own:recent_reviews", reason: "FORMULA_RANK" },
    { sourceId: "own:questions", reason: "FORMULA_RANK" },
  ]);
});

test("rank 公式身份因工作表 XML 损坏而无法判定时预检失败关闭", async () => {
  const base = workbookFile(`
## 默认排序评价

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | 用户A | 2026-08-01 | 好评 | 规格A | 默认评价 | |

## 时间排序评价

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | 用户B | 2026-08-02 | 好评 | 规格B | 时间评价 | |
`, "malformed-formula-rank.xlsx");
  const formula = await withFormulaCells(base, [
    { sheetPath: "xl/worksheets/sheet1.xml", cell: "A2", formula: "1+1", cachedValue: 2 },
  ]);
  const malformed = await rewriteWorkbookXml(formula, (path, xml) => (
    path === "xl/worksheets/sheet1.xml"
      ? xml.replace(/<\/c>/u, "</broken-cell>")
      : xml
  ));

  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: malformed,
  });

  assert.equal(parsed.reviews.length, 0);
  assert.equal(parsed.errors.some(({ code }) => code === "UNSAFE_FORMULA_SCAN"), true);
  assert.deepEqual(parsed.sources.slice(0, 2).map(({ kind, status }) => ({ kind, status })), [
    { kind: "default_reviews", status: "missing" },
    { kind: "recent_reviews", status: "missing" },
  ]);
});

test("uses only the first 100 valid reviews and accounts for overflow", () => {
  const result = parseReviewRows("own", "default", [
    reviewHeader,
    ...Array.from({ length: 101 }, (_, index) => [
      index + 1,
      `用户${index + 1}`,
      "2026-08-01",
      "好评",
      "规格A",
      "有效",
      "",
    ]),
  ]);

  assert.equal(result.rows.length, 100);
  assert.equal(result.rowsRead, 101);
  assert.equal(result.excludedOverLimit, 1);
  assert.equal(result.excludedRows.at(-1).reason, "OVER_LIMIT");
});

test("excludes empty questions and questions without an answer", () => {
  const emptyQuestion = parseQuestionRows("own", [
    questionHeader,
    [1, " ", "有回答", "2026-08-01"],
  ]);
  const emptyAnswer = parseQuestionRows("own", [
    questionHeader,
    [1, "是否适合油头", " ", "2026-08-01"],
  ]);

  assert.equal(emptyQuestion.excludedRows[0].reason, "EMPTY_QUESTION_TEXT");
  assert.equal(emptyAnswer.excludedRows[0].reason, "EMPTY_ANSWER");
});

test("店透视问大家四列表按 Excel 行序补排名并识别时间和问答", () => {
  const result = parseQuestionRows("own", [
    ["昵称", "时间", "问题", "问答"],
    ["用户A", "2026-08-01", "是否适合油头", "适合"],
    ["用户B", "2026-08-02", "多久见效", "因人而异"],
  ]);

  assert.deepEqual(result.rows.map((row) => [row.rank, row.date, row.questionText, row.answer]), [
    [1, "2026-08-01", "是否适合油头", "适合"],
    [2, "2026-08-02", "多久见效", "因人而异"],
  ]);
  assert.deepEqual(result.columns, [
    { field: "nickname", header: "昵称" },
    { field: "date", header: "时间" },
    { field: "questionText", header: "问题" },
    { field: "answer", header: "问答" },
  ]);
});

test("真实 XLSX 的标准问大家四列按工作表行序稳定补 rank", async () => {
  const questions = workbookFile(`
## 问大家

| 昵称 | 时间 | 问题 | 问答 |
| --- | --- | --- | --- |
| 用户A | 2026-08-01 | 是否适合油头 | 适合 |
| 用户B | 2026-08-02 | 多久见效 | 因人而异 |
`, "questions-four-column.xlsx");
  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    questionFile: questions,
  });

  assert.deepEqual(parsed.questions.map(({ rank, sourceRow, questionText }) => ({ rank, sourceRow, questionText })), [
    { rank: 1, sourceRow: 2, questionText: "是否适合油头" },
    { rank: 2, sourceRow: 3, questionText: "多久见效" },
  ]);
  assert.equal(parsed.sources.find(({ kind }) => kind === "questions").usedRows, 2);
});

test("无 rank 问大家仅接受规范化后恰好四列的标准 profile", () => {
  const normalized = parseQuestionRows("own", [
    [" 昵称 ", "时　间", "问　题", "问答"],
    ["用户A", "2026-08-01", "是否适合油头", "适合"],
    ["用户B", "2026-08-02", "多久见效", "因人而异"],
  ]);
  const missingNickname = parseQuestionRows("own", [
    ["时间", "问题", "问答"],
    ["2026-08-01", "是否适合油头", "适合"],
  ]);
  const extraKnownColumn = parseQuestionRows("own", [
    ["昵称", "时间", "问题", "问答", "回答"],
    ["用户A", "2026-08-01", "是否适合油头", "适合", "适合"],
  ]);
  const wrongAlias = parseQuestionRows("own", [
    ["昵称", "时间", "问题内容", "问答"],
    ["用户A", "2026-08-01", "是否适合油头", "适合"],
  ]);

  assert.deepEqual(normalized.rows.map(({ rank, sourceRow }) => ({ rank, sourceRow })), [
    { rank: 1, sourceRow: 2 },
    { rank: 2, sourceRow: 3 },
  ]);
  for (const rejected of [missingNickname, extraKnownColumn, wrongAlias]) {
    assert.equal(rejected.rows.length, 0);
    assert.equal(rejected.errors.some(({ code }) => code === "INVALID_QUESTION_HEADER_PROFILE"), true);
  }
});

test("旧问大家 profile 必须携带显式排名且保持 rank 与 sourceRow", () => {
  const ranked = parseQuestionRows("own", [
    questionHeader,
    [7, "是否适合油头", "适合", "2026-08-01"],
  ]);
  const noRank = parseQuestionRows("own", [
    ["问题", "回答", "提问时间"],
    ["是否适合油头", "适合", "2026-08-01"],
  ]);

  assert.deepEqual(ranked.rows.map(({ rank, sourceRow }) => ({ rank, sourceRow })), [
    { rank: 7, sourceRow: 2 },
  ]);
  assert.equal(noRank.rows.length, 0);
  assert.equal(noRank.errors.some(({ code }) => code === "INVALID_QUESTION_HEADER_PROFILE"), true);
});

test("uses only the first 100 valid questions and accounts for overflow", () => {
  const result = parseQuestionRows("own", [
    questionHeader,
    ...Array.from({ length: 101 }, (_, index) => [
      index + 1,
      `问题${index + 1}`,
      "有回答",
      "2026-08-01",
    ]),
  ]);

  assert.equal(result.rows.length, 100);
  assert.equal(result.rowsRead, 101);
  assert.equal(result.excludedOverLimit, 1);
  assert.equal(result.excludedRows.at(-1).reason, "OVER_LIMIT");
});

test("问大家仍拒绝非标准语义别名，评价表头允许首尾空格", () => {
  const alias = parseQuestionRows("own", [
    ["排名", "问题内容", "回答", "提问时间"],
    [1, "是否适合油头", "适合", "2026-08-01"],
  ]);
  const padded = parseReviewRows("own", "default", [
    [" 序号 ", ...reviewHeader.slice(1)],
    [1, "用户A", "2026-08-01", "好评", "规格A", "去屑很快", ""],
  ]);

  assert.equal(alias.errors[0].code, "UNKNOWN_COLUMN");
  assert.deepEqual(padded.errors, []);
  assert.equal(padded.rows.length, 1);
});

test("reads both named review sheets and maps source identity and Excel rows", async () => {
  const reviews = workbookFile(`
## 默认排序评价

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 用户A | 2026-08-01 | 好评 | 规格A | 去屑很快 | 追评 |

## 时间排序评价

| 排名 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 用户B | 2026-08-02 | 好评 | 规格B | 控油不错 | |
`, "reviews.xlsx");
  const questions = workbookFile(`
## 问大家

| 排名 | 问题 | 回答 | 提问时间 |
| --- | --- | --- | --- |
| 1 | 是否适合油头 | 适合 | 2026-08-03 |
`, "questions.xlsx");

  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: reviews,
    questionFile: questions,
  });

  assert.deepEqual(
    parsed.reviews.map((row) => [row.sourceId, row.sourceRow, row.sort]),
    [
      ["own:default_reviews", 2, "default"],
      ["own:recent_reviews", 2, "recent"],
    ],
  );
  assert.equal(parsed.questions[0].sourceId, "own:questions");
  assert.equal(parsed.questions[0].sourceRow, 2);
  assert.deepEqual(
    parsed.sources.map((source) => [source.kind, source.usedRows]),
    [
      ["default_reviews", 1],
      ["recent_reviews", 1],
      ["questions", 1],
    ],
  );
  assert.deepEqual(parsed.sourceMappings, [
    {
      sourceId: "own:default_reviews",
      fileName: "reviews.xlsx",
      sheetName: "默认排序评价",
      columns: [
        { field: "rank", header: "序号" },
        { field: "nickname", header: "用户昵称" },
        { field: "date", header: "评价时间" },
        { field: "reviewType", header: "评价类型" },
        { field: "sku", header: "SKU" },
        { field: "initialText", header: "初评内容" },
        { field: "followupText", header: "追评内容" },
      ],
    },
    {
      sourceId: "own:recent_reviews",
      fileName: "reviews.xlsx",
      sheetName: "时间排序评价",
      columns: [
        { field: "rank", header: "排名" },
        { field: "nickname", header: "用户昵称" },
        { field: "date", header: "评价时间" },
        { field: "reviewType", header: "评价类型" },
        { field: "sku", header: "SKU" },
        { field: "initialText", header: "初评内容" },
        { field: "followupText", header: "追评内容" },
      ],
    },
    {
      sourceId: "own:questions",
      fileName: "questions.xlsx",
      sheetName: "问大家",
      columns: [
        { field: "rank", header: "排名" },
        { field: "questionText", header: "问题" },
        { field: "answer", header: "回答" },
        { field: "date", header: "提问时间" },
      ],
    },
  ]);
});

test("blocks a workbook missing either required review sheet", async () => {
  const reviews = workbookFile(`
## 默认排序评价

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 用户A | 2026-08-01 | 好评 | 规格A | 去屑很快 | |
`, "missing-sheet.xlsx");

  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: reviews,
  });

  assert.equal(parsed.errors[0].code, "MISSING_REVIEW_SHEET");
});

test("blocks reversed named review sheets because their rank order conflicts", async () => {
  const reviews = workbookFile(`
## 时间排序评价

| 排名 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 用户B | 2026-08-02 | 好评 | 规格B | 控油不错 | |

## 默认排序评价

| 序号 | 用户昵称 | 评价时间 | 评价类型 | SKU | 初评内容 | 追评内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 用户A | 2026-08-01 | 好评 | 规格A | 去屑很快 | |
`, "reversed-sheets.xlsx");

  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: reviews,
  });

  assert.equal(parsed.errors[0].code, "RANK_ORDER_CONFLICT");
});

test("ignores Office temporary lock files with a warning", async () => {
  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: new File(["not used"], ".~reviews.xlsx"),
    questionFile: new File(["not used"], "~$questions.xlsx"),
    screenshotFile: new File(["not used"], ".~tags.png"),
  });

  assert.equal(
    parsed.warnings.filter((warning) => warning.code === "TEMPORARY_FILE_IGNORED").length,
    3,
  );
  assert.ok(parsed.errors.some((error) => error.code === "MISSING_REVIEW_FILE"));
  assert.deepEqual(
    parsed.sources.map((source) => [source.kind, source.status]),
    [
      ["default_reviews", "missing"],
      ["recent_reviews", "missing"],
      ["questions", "missing"],
    ],
  );
});

test("XLSX 压缩文件超限时不读取 arrayBuffer 或尝试解压", async () => {
  let reads = 0;
  const oversized = {
    name: "oversized.xlsx",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: MAX_XLSX_COMPRESSED_BYTES + 1,
    async arrayBuffer() { reads += 1; throw new Error("must not read"); },
  };
  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: oversized,
  });
  assert.equal(reads, 0);
  assert.equal(parsed.errors.some(({ code }) => code === "XLSX_ARCHIVE_LIMIT"), true);
});

test("XLSX 读取后按实际 buffer.byteLength 再次执行压缩文件预算", async () => {
  let reads = 0;
  const spoofed = {
    name: "spoofed-size.xlsx",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 1,
    async arrayBuffer() {
      reads += 1;
      return new ArrayBuffer(MAX_XLSX_COMPRESSED_BYTES + 1);
    },
  };
  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: spoofed,
  });
  assert.equal(reads, 1);
  assert.equal(parsed.errors.some(({ code }) => code === "XLSX_ARCHIVE_LIMIT"), true);
  assert.equal(parsed.errors.some(({ code }) => code === "UNSAFE_FORMULA_SCAN"), false);
  assert.equal(parsed.reviews.length, 0);
});

test("XLSX 拒绝 2000 个中央目录别名共享同一 stored localOffset", async () => {
  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: aliasedStoredArchive(),
  });
  assert.equal(parsed.errors.some(({ code }) => code === "UNSAFE_XLSX_ARCHIVE"), true);
  assert.equal(parsed.errors.some(({ code }) => code === "UNSAFE_FORMULA_SCAN"), false);
  assert.equal(parsed.reviews.length, 0);
});

test("XLSX 流式实际展开阻断向下虚报的 deflate entry", async () => {
  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: await downwardDeclaredDeflateArchive(),
  });
  assert.equal(parsed.errors.some(({ code }) => code === "XLSX_ARCHIVE_LIMIT"), true);
  assert.equal(parsed.errors.some(({ code }) => code === "UNSAFE_FORMULA_SCAN"), false);
  assert.equal(parsed.reviews.length, 0);
});

test("XLSX 中央目录与 local header 的 name、method、flags 必须一致且拒绝 data descriptor", async () => {
  const base = standardReviewWorkbook("local-central-mismatch.xlsx");
  const cases = [
    await rewriteLocalAndCentral(base, ({ view, bytes, cursor, localOffset, index }) => {
      if (index !== 0) return;
      const localNameStart = localOffset + 30;
      assert.ok(view.getUint16(cursor + 28, true) > 0);
      bytes[localNameStart] ^= 1;
    }),
    await rewriteLocalAndCentral(base, ({ view, cursor, localOffset, index }) => {
      if (index === 0) view.setUint16(localOffset + 8, view.getUint16(cursor + 10, true) === 8 ? 0 : 8, true);
    }),
    await rewriteLocalAndCentral(base, ({ view, cursor, localOffset, index }) => {
      if (index !== 0) return;
      const flags = view.getUint16(cursor + 8, true) | 0x8;
      view.setUint16(cursor + 8, flags, true);
      view.setUint16(localOffset + 6, flags, true);
    }),
  ];
  for (const file of cases) {
    const parsed = await parseProductPack({
      product: { productId: "own", role: "self", name: "我方产品" },
      reviewFile: file,
    });
    assert.equal(parsed.errors.some(({ code }) => code === "UNSAFE_XLSX_ARCHIVE"), true);
    assert.equal(parsed.errors.some(({ code }) => code === "UNSAFE_FORMULA_SCAN"), false);
  }
});

test("XLSX stored entry 必须 size 相等且 entry 数据范围不得越过中央目录", async () => {
  const stored = new File([zipSync({ "stored.bin": new Uint8Array([1, 2, 3, 4]) }, { level: 0 })], "stored.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const unequalStored = await rewriteLocalAndCentral(stored, ({ view, cursor, localOffset }) => {
    view.setUint32(cursor + 24, 3, true);
    view.setUint32(localOffset + 22, 3, true);
  });
  const base = standardReviewWorkbook("entry-range.xlsx");
  const outOfRange = await rewriteLocalAndCentral(base, ({ view, cursor, localOffset, centralOffset, index }) => {
    if (index !== 0) return;
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const beyondCentral = centralOffset - dataStart + 1;
    view.setUint32(cursor + 20, beyondCentral, true);
    view.setUint32(localOffset + 18, beyondCentral, true);
  });
  for (const file of [unequalStored, outOfRange]) {
    const parsed = await parseProductPack({
      product: { productId: "own", role: "self", name: "我方产品" },
      reviewFile: file,
    });
    assert.equal(parsed.errors.some(({ code }) => code === "UNSAFE_XLSX_ARCHIVE"), true);
    assert.equal(parsed.errors.some(({ code }) => code === "UNSAFE_FORMULA_SCAN"), false);
  }
});

test("XLSX 中央目录在实际解压前阻断单 entry、总展开大小和高压缩比", async () => {
  const base = standardReviewWorkbook();
  const cases = [
    await rewriteCentralDirectory(base, ({ view, cursor, index }) => {
      if (index === 0) {
        view.setUint32(cursor + 20, MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES + 1, true);
        view.setUint32(cursor + 24, MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES + 1, true);
      }
    }),
    await rewriteCentralDirectory(base, ({ view, cursor, entryCount }) => {
      const declared = Math.floor(MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES / entryCount) + 1;
      view.setUint32(cursor + 20, declared, true);
      view.setUint32(cursor + 24, declared, true);
    }),
    await rewriteCentralDirectory(base, ({ view, cursor, index }) => {
      if (index === 0) {
        view.setUint32(cursor + 20, 1, true);
        view.setUint32(cursor + 24, MAX_XLSX_COMPRESSION_RATIO + 1, true);
      }
    }),
  ];
  for (const file of cases) {
    const parsed = await parseProductPack({
      product: { productId: "own", role: "self", name: "我方产品" },
      reviewFile: file,
    });
    assert.equal(
      parsed.errors.some(({ code }) => code === "XLSX_ARCHIVE_LIMIT"),
      true,
      JSON.stringify(parsed.errors),
    );
    assert.equal(parsed.reviews.length, 0);
  }
});

test("损坏中央目录失败关闭，预算内正常工作簿仍可解析", async () => {
  const base = standardReviewWorkbook("central-directory.xlsx");
  const malformed = await rewriteCentralDirectory(base, ({ view, cursor, index }) => {
    if (index === 0) view.setUint32(cursor, 0, true);
  });
  const rejected = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: malformed,
  });
  assert.equal(rejected.errors.some(({ code }) => code === "UNSAFE_XLSX_ARCHIVE"), true);
  assert.equal(rejected.reviews.length, 0);

  const accepted = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: base,
  });
  assert.equal(accepted.errors.length, 0);
  assert.equal(accepted.reviews.length, 2);
});

test("Office 锁文件优先忽略，即使声明超限也不读取", async () => {
  let reads = 0;
  const lock = {
    name: "~$oversized.xlsx",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: MAX_XLSX_COMPRESSED_BYTES + 1,
    async arrayBuffer() { reads += 1; throw new Error("must not read"); },
  };
  const parsed = await parseProductPack({
    product: { productId: "own", role: "self", name: "我方产品" },
    reviewFile: lock,
  });
  assert.equal(reads, 0);
  assert.equal(parsed.warnings.some(({ code }) => code === "TEMPORARY_FILE_IGNORED"), true);
  assert.equal(parsed.errors.some(({ code }) => code === "XLSX_ARCHIVE_LIMIT"), false);
});

test("问大家旧版表头的序号列按 NFKC 与首尾空格规范化识别", () => {
  const rows = [
    ["序号 ", "昵称", "提问时间", "问题", "回答"],
    [1, "买家一", "2026-08-01", "保温多久", "24 小时"],
    [2, "买家二", "2026-08-02", "材质是什么", "316 不锈钢"],
  ];

  const parsed = parseQuestionRows("own", rows);

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 2);
});

test("问大家四列表头忽略 Excel 补齐的尾部空列", () => {
  const rows = [
    ["昵称", "时间", "问题", "问答", null],
    ["买家一", "2026-08-01", "保温多久", "24 小时", null],
  ];

  const parsed = parseQuestionRows("own", rows);

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].rank, 1);
});

test("评价表头忽略 Excel 补齐的尾部空列", () => {
  const parsed = parseReviewRows("own", "default", [
    [...reviewHeader, null],
    [1, "买家一", "2026-08-01", "好评", "红色", "很好用", "", null],
  ]);

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 1);
});

test("全角数字排名按 NFKC 归一，不再被当作缺失排名排除", () => {
  const parsed = parseReviewRows("own", "default", [
    reviewHeader,
    ["１", "买家一", "2026-08-01", "好评", "红色", "很好用", ""],
  ]);

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.excludedRows, []);
  assert.equal(parsed.rows[0].rank, 1);
});

test("缺列提示使用业务列名，不暴露内部字段 id", () => {
  const review = parseReviewRows("own", "default", [
    ["序号", "用户昵称", "评价时间", "评价类型", "SKU", "初评内容"],
    [1, "买家一", "2026-08-01", "好评", "红色", "很好用"],
  ]);
  const question = parseQuestionRows("own", [
    ["时间", "昵称", "问题", "问答"],
    ["2026-08-01", "买家一", "保温多久", "24 小时"],
  ]);

  const missing = [...review.errors, ...question.errors].filter(({ code }) => code === "MISSING_COLUMN");
  assert.equal(missing.length, 2);
  assert.deepEqual(missing.map(({ message }) => message), [
    "缺少必填列：追评正文。",
    "缺少必填列：排名（序号）。",
  ]);
  for (const { message } of missing) {
    assert.equal(/followupText|initialText|questionText|nickname|reviewType|\brank\b/.test(message), false);
  }
});
