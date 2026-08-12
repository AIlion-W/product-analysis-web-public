import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as bundle } from "esbuild";
import { strFromU8, unzipSync } from "fflate";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import readXlsxFile from "read-excel-file/browser";

import { buildExcelWorkbook } from "../lib/excel-export.ts";
import {
  buildNeigongExportFileName,
  buildNeigongWorkbook,
} from "../lib/neigong/excel-export.ts";
import { buildNeigongHtml } from "../lib/neigong/html-export.ts";
import { validateEvidenceGraph } from "../lib/neigong/rules.ts";
import { createValidNeigongReport } from "./helpers/neigong-report-fixture.mjs";

const FORMULA_TEXT = " \t=HYPERLINK(\"https://attacker.invalid\",\"click\")";
const HTML_TEXT = "</script><img src=x onerror=alert(1)>\u2028\u2029";
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

let reportDashboardPromise;

async function loadReportDashboard() {
  reportDashboardPromise ??= (async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "neigong-dashboard-test-"));
    const outputFile = join(temporaryDirectory, "ReportDashboard.mjs");
    try {
      await bundle({
        entryPoints: [join(PROJECT_ROOT, "components/neigong/ReportDashboard.tsx")],
        outfile: outputFile,
        bundle: true,
        platform: "node",
        format: "esm",
        jsx: "automatic",
        alias: { "@": PROJECT_ROOT },
        logLevel: "silent",
      });
      return (await import(pathToFileURL(outputFile).href)).ReportDashboard;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  })();
  return reportDashboardPromise;
}

async function renderReportDashboard(report) {
  const ReportDashboard = await loadReportDashboard();
  return renderToStaticMarkup(createElement(ReportDashboard, { report }));
}

function validReport() {
  const report = createValidNeigongReport();
  report.products[0].name = HTML_TEXT;
  report.sources[0].note = FORMULA_TEXT;
  report.reviews[0].sku = FORMULA_TEXT;
  report.reviews[0].initialText = FORMULA_TEXT;
  report.reviews[0].followupText = HTML_TEXT;
  report.reviews[0].typeEvidence.quote = FORMULA_TEXT;
  report.questions[0].questionText = FORMULA_TEXT;
  report.questions[0].answer = HTML_TEXT;
  report.questions[0].topicEvidence = FORMULA_TEXT;
  report.top20[0].dimensions[0].evidence = FORMULA_TEXT;
  report.findings[0].title = FORMULA_TEXT;
  report.findings[0].detail = HTML_TEXT;
  report.actions[0].action = FORMULA_TEXT;
  report.actions[0].reason = `${FORMULA_TEXT} ${report.actions[0].reason}`;
  assert.equal(validateEvidenceGraph(report).valid, true);
  return report;
}

function visibleSummaryText(markup) {
  assert.doesNotMatch(markup, /\bhidden\b|data-audit-/u);
  const match = markup.match(/<section class="neigong-report-metrics"[^>]*>([\s\S]*?)<\/section>/u);
  assert.ok(match, "核心指标必须渲染在用户可见的报告结构中");
  return match[1]
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:#x27|apos);/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function visibleBusinessText(markup) {
  return markup
    .replace(/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/giu, " ")
    .replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/giu, " ")
    .replace(/<details class="neigong-report-audit"[\s\S]*?<\/details>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:#x27|apos);/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function visibleAuditText(markup) {
  return [...markup.matchAll(/<details class="neigong-report-audit"[^>]*>([\s\S]*?)<\/details>/giu)]
    .map((match) => match[1].replace(/<[^>]+>/gu, " "))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function rowObject(rows, index) {
  return Object.fromEntries(rows[0].map((header, column) => [header, rows[index][column]]));
}

test("同一 ReportData 在网页、HTML 和 Excel 三呈现的核心数值精确一致", async () => {
  const report = createValidNeigongReport();
  const f01Aggregate = report.aggregates.taxonomy.find((entry) => entry.productId === "own" && entry.typeId === "t2");
  const expectedDifference = `${(Math.abs(f01Aggregate.difference) * 100).toFixed(1)}pp`;
  const expectedVisibleParts = [
    "我方产品 · 默认排序评价 100 行",
    "我方产品 · 时间排序评价 100 行",
    "我方产品 · 问大家 100 行",
    `F01 最大绝对占比差 ${expectedDifference} 人群场景+痛点+效果`,
    `分析结论 ${report.findings.length} 条`,
    `落地清单 ${report.actions.length} 条`,
  ];

  const dashboard = visibleSummaryText(await renderReportDashboard(report));
  const html = visibleSummaryText(buildNeigongHtml(report));
  for (const summary of [dashboard, html]) {
    assert.ok(
      summary.indexOf("默认排序评价") < summary.indexOf("时间排序评价")
      && summary.indexOf("时间排序评价") < summary.indexOf("问大家"),
      "来源摘要应按默认排序评价、时间排序评价、问大家的业务顺序展示",
    );
  }

  const sheets = await readXlsxFile(new Blob([buildNeigongWorkbook(report)]));
  const completeness = sheets.find((sheet) => sheet.sheet === "数据完整性").data;
  const findingRows = sheets.find((sheet) => sheet.sheet === "分析结论").data;
  const actionRows = sheets.find((sheet) => sheet.sheet === "落地清单").data;
  const xlsxUsedRows = completeness
    .slice(1)
    .map((_, index) => rowObject(completeness, index + 1))
    .map((row) => `${row.evidenceId}:${row["使用行数"]}`)
    .sort()
    .join("|");
  const f01FindingRow = findingRows
    .slice(1)
    .map((_, index) => rowObject(findingRows, index + 1))
    .find((row) => row.findingId === "F01");
  for (const part of expectedVisibleParts) {
    assert.ok(dashboard.includes(part), `网页缺少可见指标：${part}`);
    assert.ok(html.includes(part), `HTML 缺少可见指标：${part}`);
  }
  assert.equal(xlsxUsedRows, report.meta.completeness
    .map((entry) => `${entry.evidenceId}:${entry.usedRows}`)
    .sort()
    .join("|"));
  assert.equal(f01FindingRow["F01类型"], "t2");
  assert.equal(f01FindingRow["F01最大绝对占比差"], expectedDifference);
  assert.ok(findingRows[0].includes("是否触发关注线"));
  assert.ok(findingRows[0].includes("规则代码"));
  assert.equal(findingRows[0].includes("是否存在问题"), false);
  assert.equal(findingRows.length - 1, report.findings.length);
  assert.equal(actionRows.length - 1, report.actions.length);
});

test("网页与离线 HTML 先展示中文业务含义，并把内部证据放进可展开审计区", async () => {
  const report = createValidNeigongReport();
  report.reviewTags = [{ sourceId: "own:review_tags", productId: "own", name: "去屑明显", count: 12 }];
  report.errors = [{ code: "SOURCE_ERROR", message: "示例错误" }];
  report.warnings = [{ code: "SOURCE_WARNING", message: "示例警告" }];
  report.excludedRows = [{ rowId: "own-default-101", sourceId: "own:default_reviews", reason: "OVER_LIMIT" }];
  report.sources = report.sources.map((entry) => entry.sourceId === "own:default_reviews"
    ? { ...entry, rowsRead: 101, validRows: 101, excludedRows: 1, excludedOverLimit: 1 }
    : entry);
  report.meta.completeness = report.meta.completeness.map((entry) => entry.sourceIds.includes("own:default_reviews")
    ? { ...entry, validRows: 101, excludedOverLimit: 1 }
    : entry);
  assert.equal(validateEvidenceGraph(report).valid, true);

  const dashboardMarkup = await renderReportDashboard(report);
  const htmlMarkup = buildNeigongHtml(report);
  for (const markup of [dashboardMarkup, htmlMarkup]) {
    const businessText = visibleBusinessText(markup);
    const auditText = visibleAuditText(markup);

    for (const label of [
      "默认排序评价",
      "时间排序评价",
      "问大家",
      "完整",
      "人群身份",
      "使用场景",
      "核心痛点",
      "体验细节",
      "效果反馈",
      "意外惊喜",
      "可诊断",
      "占比差（时间排序－默认排序）",
      "问大家主题分布（仅我方）",
      "去屑明显 12",
      "错误 1 条，警告 1 条，排除行 1 条",
    ]) assert.ok(businessText.includes(label), `业务主视图缺少：${label}`);

    for (const internal of ["self_default_reviews", "persona", "available", "AGG-TYPE-own-t1", "DATA-own-self_default_reviews"]) {
      assert.equal(businessText.includes(internal), false, `业务主视图不应直接暴露内部字段：${internal}`);
    }
    assert.match(auditText, /AGG-TYPE-own-t1|DATA-own-self_default_reviews/);
    assert.match(auditText, /错误 SOURCE_ERROR：示例错误/);
    assert.match(auditText, /警告 SOURCE_WARNING：示例警告/);
    assert.match(auditText, /排除 own-default-101：OVER_LIMIT/);
  }
  assert.match(visibleBusinessText(htmlMarkup), /生成时间：2026-08-11 08:00（北京时间）/);
});

test("行动原因即使带额外冒号前缀，也不会把审计编号重新泄露到业务主视图", async () => {
  for (const reasonMode of ["额外前缀", "缺少分隔符"]) {
    const report = createValidNeigongReport();
    const action = report.actions[0];
    action.reason = reasonMode === "额外前缀"
      ? `外部前缀：${action.reason}`
      : `${action.findingIds.join("、")}｜${action.evidenceIds.join("、")}`;
    assert.equal(validateEvidenceGraph(report).valid, true);

    for (const markup of [await renderReportDashboard(report), buildNeigongHtml(report)]) {
      const businessText = visibleBusinessText(markup);
      assert.equal(businessText.includes("AGG-TYPE-own-t1"), false);
      assert.match(visibleAuditText(markup), /AGG-TYPE-own-t1/);
    }
  }
});

test("真实报告构建链路把 F02 维度名翻译为中文，并在 F01 数据不足时不显示英文状态", async () => {
  const f02Report = createValidNeigongReport({ lowDimension: "persona" });
  const unavailableReport = createValidNeigongReport({ ownRecent: 89 });

  for (const markup of [await renderReportDashboard(f02Report), buildNeigongHtml(f02Report)]) {
    const businessText = visibleBusinessText(markup);
    assert.match(businessText, /「人群身份」命中 4 条/);
    assert.equal(businessText.includes("「persona」"), false);
  }
  for (const markup of [await renderReportDashboard(unavailableReport), buildNeigongHtml(unavailableReport)]) {
    const summary = visibleSummaryText(markup);
    assert.match(summary, /F01 最大绝对占比差 数据不足 数据不足/);
    assert.equal(summary.includes("unavailable"), false);
  }
});

test("无合格竞品时问大家标题明确仅我方，有合格竞品时才称竞品对照", async () => {
  const weakCompetitor = createValidNeigongReport({
    competitors: [{ productId: "weak", name: "弱竞品", questionCount: 89 }],
  });
  const strongCompetitor = createValidNeigongReport({
    competitors: [{ productId: "strong", name: "强竞品", questionCount: 90 }],
  });

  for (const markup of [await renderReportDashboard(weakCompetitor), buildNeigongHtml(weakCompetitor)]) {
    assert.match(visibleBusinessText(markup), /问大家主题分布（仅我方）/);
  }
  for (const markup of [await renderReportDashboard(strongCompetitor), buildNeigongHtml(strongCompetitor)]) {
    assert.match(visibleBusinessText(markup), /问大家竞品对照/);
  }
});

test("离线 HTML 对截图标签计数执行最终输出转义", () => {
  const report = createValidNeigongReport();
  report.reviewTags = [{
    sourceId: "own:review_tags",
    productId: "own",
    name: "安全标签",
    count: "</span><img src=x onerror=alert(1)>",
  }];
  assert.equal(validateEvidenceGraph(report).valid, true);

  const html = buildNeigongHtml(report);
  assert.doesNotMatch(html, /<img src=x|<[^>]+onerror=/i);
  assert.match(html, /&lt;\/span&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("内功问诊 Excel 固定且仅包含六张工作表，并保留审计列", () => {
  const workbook = unzipSync(buildNeigongWorkbook(validReport()));
  const xml = strFromU8(workbook["xl/workbook.xml"]);
  const names = [
    "数据完整性",
    "评价逐条标注",
    "前 20 六维",
    "问大家逐条标注",
    "分析结论",
    "落地清单",
  ];

  for (const name of names) assert.match(xml, new RegExp(`name="${name}"`));
  assert.equal((xml.match(/<sheet /g) ?? []).length, 6);

  const reviews = strFromU8(workbook["xl/worksheets/sheet2.xml"]);
  for (const column of ["productId", "sort", "rank", "sourceId", "sourceRow", "rowId", "初评", "追评", "typeId", "typeEvidence"]) {
    assert.match(reviews, new RegExp(`>${column}<`));
  }
  assert.match(reviews, /own-default-1/);
  assert.match(strFromU8(workbook["xl/worksheets/sheet5.xml"]), /AGG-TYPE-own-t1/);
  assert.match(strFromU8(workbook["xl/worksheets/sheet6.xml"]), /F0[13]/);
});

test("内功问诊 Excel 的六张表统一阻断含前导空白的公式注入", () => {
  const workbook = unzipSync(buildNeigongWorkbook(validReport()));

  for (let index = 1; index <= 6; index += 1) {
    const xml = strFromU8(workbook[`xl/worksheets/sheet${index}.xml`]);
    assert.doesNotMatch(xml, /<t[^>]*>[\t ]*=HYPERLINK/);
  }
  for (const index of [1, 2, 3, 4, 5, 6]) {
    const xml = strFromU8(workbook[`xl/worksheets/sheet${index}.xml`]);
    assert.match(xml, /&apos; \t=HYPERLINK/);
  }
  assert.doesNotMatch(strFromU8(workbook["xl/worksheets/sheet2.xml"]), /\u0000/u);
});

test("Excel 公式防护覆盖等号、加号、减号和 at 符号", () => {
  const payloads = ["=PAYLOAD", " \t+PAYLOAD", "\r\n-PAYLOAD", "\n@PAYLOAD"];
  for (const payload of payloads) {
    const report = validReport();
    report.actions[0].action = payload;
    const workbook = unzipSync(buildNeigongWorkbook(report));
    const xml = strFromU8(workbook["xl/worksheets/sheet6.xml"]);
    assert.match(xml, /&apos;[\s]*[=+\-@]PAYLOAD/);
  }

  const productPayload = validReport();
  productPayload.products[0].name = "\r\n=PRODUCT";
  const firstSheet = strFromU8(
    unzipSync(buildNeigongWorkbook(productPayload))["xl/worksheets/sheet1.xml"],
  );
  assert.match(firstSheet, /&apos;[\s]*=PRODUCT/);
});

test("上传日期和未受 validator 约束的 action 字段一律按不可信文本防公式", () => {
  const report = validReport();
  report.reviews[0].date = "\r\n=HYPERLINK(\"https://attacker.invalid\")";
  report.questions[0].date = "\t@SUM(1,1)";
  report.actions[0].actionId = "=CMD";
  report.actions[0].priority = "+1";
  assert.equal(validateEvidenceGraph(report).valid, true);

  const workbook = unzipSync(buildNeigongWorkbook(report));
  assert.match(strFromU8(workbook["xl/worksheets/sheet2.xml"]), /&apos;\r\n=HYPERLINK/);
  assert.match(strFromU8(workbook["xl/worksheets/sheet4.xml"]), /&apos;\t@SUM/);
  assert.match(strFromU8(workbook["xl/worksheets/sheet6.xml"]), /&apos;=CMD/);
  assert.match(strFromU8(workbook["xl/worksheets/sheet6.xml"]), /&apos;\+1/);

  const normal = unzipSync(buildNeigongWorkbook(validReport()));
  const normalReviews = strFromU8(normal["xl/worksheets/sheet2.xml"]);
  const normalActions = strFromU8(normal["xl/worksheets/sheet6.xml"]);
  assert.match(normalReviews, />2026-08-11<\/t>/);
  assert.match(normalActions, />A01<\/t>/);
  assert.match(normalActions, />P1<\/t>/);
  assert.doesNotMatch(normalActions, /&apos;(?:A01|P1)/);
});

test("代码生成的负百分比保持为负数文本，不被公式防护添加单引号", () => {
  const workbook = unzipSync(buildNeigongWorkbook(validReport()));
  const reviews = strFromU8(workbook["xl/worksheets/sheet2.xml"]);

  assert.match(reviews, />-20\.0%<\/t>/);
  assert.doesNotMatch(reviews, /&apos;-20\.0%/);
});

function containsForbiddenXmlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 0x9
      || codePoint === 0xa
      || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      if ((codePoint & 0xffff) !== 0xfffe && (codePoint & 0xffff) !== 0xffff) continue;
    }
    return true;
  }
  return false;
}

test("Excel 移除完整 XML 禁止字符并保留合法 Unicode", () => {
  const report = validReport();
  report.reviews[0].followupText = `合法😀\u0000\ud800X\udc00\ufffe\uffff\u{1fffe}\u{10ffff}结尾`;
  const workbook = unzipSync(buildNeigongWorkbook(report));

  for (const [name, bytes] of Object.entries(workbook)) {
    if (!name.endsWith(".xml")) continue;
    const xml = strFromU8(bytes);
    assert.equal(containsForbiddenXmlCharacter(xml), false, name);
  }
  assert.match(strFromU8(workbook["xl/worksheets/sheet2.xml"]), /合法😀.*结尾/u);
});

test("Excel 单元格 32767 字符可导出，32768 字符按工作表与坐标报错", () => {
  const boundary = validReport();
  boundary.reviews[0].followupText = "a".repeat(32767);
  assert.doesNotThrow(() => buildNeigongWorkbook(boundary));

  const oversized = validReport();
  oversized.reviews[0].followupText = "a".repeat(32768);
  assert.throws(
    () => buildNeigongWorkbook(oversized),
    /EXCEL_CELL_TOO_LONG.*评价逐条标注.*第 2 行.*第 10 列/s,
  );
});

test("离线 HTML 安全内嵌同一报告，并独立展示六分区", () => {
  const html = buildNeigongHtml(validReport());

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /window\.REPORT_DATA/);
  for (const title of ["数据完整性与产品对照", "评价类型与展示倾向", "默认前 20 条六维覆盖", "问大家主题分布（仅我方）", "分析结论", "落地清单"]) {
    assert.match(html, new RegExp(title));
  }
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.equal((html.match(/<script(?:\s|>)/gi) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/gi) ?? []).length, 1);
  assert.doesNotMatch(html, /<\/script><img/i);
  assert.doesNotMatch(html, /<img src=x|<[^>]+onerror=/i);
  assert.doesNotMatch(html, /[\u2028\u2029]/u);
  assert.doesNotMatch(html, /OPENAI_API_KEY|api\.openai\.com|data:image\/png;base64|PRIVATE_ORIGINAL/);
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
});

test("HTML 逐层白名单剥离所有合同外敏感字段和原文件对象", () => {
  const report = validReport();
  report.uploadedFileBase64 = "data:image/png;base64,PRIVATE_TOP";
  report.meta.apiKey = "PRIVATE_KEY_META";
  report.products[0].uploadedFileBase64 = "data:image/png;base64,PRIVATE_PRODUCT";
  report.sources[0].originalScreenshot = { dataUrl: "data:image/png;base64,PRIVATE_SOURCE" };
  report.questions[0].privatePayload = { apiKey: "PRIVATE_KEY_QUESTION" };
  report.top20[0].originalFile = { name: "PRIVATE_FILE" };
  report.aggregates.taxonomy[0].PRIVATE_KEY = "PRIVATE_AGGREGATE";
  report.findings[0].rawModel = { dataUrl: "data:image/png;base64,PRIVATE_FINDING" };
  report.actions[0].apiKey = "PRIVATE_KEY_ACTION";
  assert.equal(validateEvidenceGraph(report).valid, true);

  const html = buildNeigongHtml(report);
  assert.doesNotMatch(html, /PRIVATE_|data:image\/png;base64|uploadedFileBase64|originalScreenshot|originalFile|rawModel|apiKey/);
});

test("导出实时校验证据图，拒绝自报 valid 的不完整或校验后被篡改报告", async () => {
  const incomplete = validReport();
  incomplete.sources = [];
  incomplete.meta.validation = { valid: true, errors: [] };
  assert.equal(validateEvidenceGraph(incomplete).valid, false);
  await assert.rejects(() => renderReportDashboard(incomplete), /REPORT_NOT_VALIDATED/);
  assert.throws(() => buildNeigongHtml(incomplete), /REPORT_NOT_VALIDATED/);
  assert.throws(() => buildNeigongWorkbook(incomplete), /REPORT_NOT_VALIDATED/);

  const mutated = validReport();
  assert.doesNotThrow(() => buildNeigongHtml(mutated));
  mutated.aggregates.taxonomy[0].defaultCount += 1;
  assert.equal(mutated.meta.validation.valid, true);
  assert.equal(validateEvidenceGraph(mutated).valid, false);
  await assert.rejects(() => renderReportDashboard(mutated), /REPORT_NOT_VALIDATED/);
  assert.throws(() => buildNeigongHtml(mutated), /REPORT_NOT_VALIDATED/);
  assert.throws(() => buildNeigongWorkbook(mutated), /REPORT_NOT_VALIDATED/);
});

test("实时校验结果为准，不受陈旧的 false 自报标记干扰", () => {
  const report = validReport();
  report.meta.validation = { valid: false, errors: [{ code: "STALE", message: "陈旧" }] };
  assert.equal(validateEvidenceGraph(report).valid, true);
  assert.doesNotThrow(() => buildNeigongHtml(report));
  assert.doesNotThrow(() => buildNeigongWorkbook(report));
});

test("导出文件名使用明确日期和固定扩展名", () => {
  const date = new Date("2026-08-11T15:59:00+08:00");
  assert.equal(buildNeigongExportFileName("html", date), "内功问诊-2026-08-11.html");
  assert.equal(buildNeigongExportFileName("xlsx", date), "内功问诊-2026-08-11.xlsx");
});

test("报告按钮共享当前 report，且对象 URL 在异常路径也会回收", async () => {
  const source = await readFile(
    new URL("../components/neigong/ReportDashboard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /buildNeigongHtml\(report\)/);
  assert.match(source, /buildNeigongWorkbook\(report\)/);
  assert.match(source, /下载 HTML/);
  assert.match(source, /导出 Excel/);
  assert.match(source, /finally\s*\{\s*if \(objectUrl\) URL\.revokeObjectURL\(objectUrl\)/s);
});

test("旧 Markdown Excel 导出继续保持筛选和冻结首行", () => {
  const markdown = "| 列 A | 列 B |\n| --- | --- |\n| 值 1 | 值 2 |";
  const workbook = unzipSync(buildExcelWorkbook(markdown, "旧导出回归"));
  const sheet = strFromU8(workbook["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /<autoFilter ref="A1:B2"\/>/);
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2"/);
});
