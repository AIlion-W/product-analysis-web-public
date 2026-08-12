import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";

import {
  buildExcelWorkbook,
  parseMarkdownTables,
} from "../lib/excel-export.ts";

const SAMPLE_RESULT = `
## 一、主副图对比表

| 阵营 | 图片编号 | 标题/可见文案 | 问题与机会 |
| --- | --- | --- | --- |
| 我方 | 我方图 1 | **横扫油屑痒** | 文案偏密；突出产品 |
| 竞品 | 竞品图 1 | 一洗 KO 屑油痒 | 证据更集中 |

## 二、我方 5 图执行表

| 图序 | 主图/副图 | 标题 | 画面要求 |
| --- | --- | --- | --- |
| 1 | 主图 | 横扫油屑痒 | 产品居中<br>功效前置 |
| 2 | 副图 | 真人实测 | 清爽发缝 |
`;

test("parses GFM result tables into editable rows", () => {
  const tables = parseMarkdownTables(SAMPLE_RESULT);

  assert.deepEqual(tables, [
    {
      name: "主副图对比表",
      rows: [
        ["阵营", "图片编号", "标题/可见文案", "问题与机会"],
        ["我方", "我方图 1", "横扫油屑痒", "文案偏密；突出产品"],
        ["竞品", "竞品图 1", "一洗 KO 屑油痒", "证据更集中"],
      ],
    },
    {
      name: "我方 5 图执行表",
      rows: [
        ["图序", "主图/副图", "标题", "画面要求"],
        ["1", "主图", "横扫油屑痒", "产品居中\n功效前置"],
        ["2", "副图", "真人实测", "清爽发缝"],
      ],
    },
  ]);
});

test("builds a two-sheet Excel workbook with filters and frozen headers", () => {
  const workbook = unzipSync(
    buildExcelWorkbook(SAMPLE_RESULT, "主副图对比分析方案"),
  );

  const workbookXml = strFromU8(workbook["xl/workbook.xml"]);
  const firstSheetXml = strFromU8(
    workbook["xl/worksheets/sheet1.xml"],
  );
  const secondSheetXml = strFromU8(
    workbook["xl/worksheets/sheet2.xml"],
  );

  assert.match(workbookXml, /name="主副图对比表"/);
  assert.match(workbookXml, /name="我方 5 图执行表"/);
  assert.match(firstSheetXml, /<autoFilter ref="A1:D3"\/>/);
  assert.match(secondSheetXml, /<autoFilter ref="A1:D3"\/>/);
  assert.match(firstSheetXml, /<pane ySplit="1" topLeftCell="A2"/);
  assert.match(firstSheetXml, /<c r="A1" s="1" t="inlineStr">/);
  assert.match(firstSheetXml, /<t xml:space="preserve">我方图 1<\/t>/);
});
