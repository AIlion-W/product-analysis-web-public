import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const elements = (xml, tag) =>
  xml.match(new RegExp(`<w:${tag}(?: [^>]*)?>[\\s\\S]*?</w:${tag}>`, "gu")) ?? [];

const property = (xml, tag) =>
  xml.match(new RegExp(`<w:${tag}(?: [^>]*)?(?:/>|>[\\s\\S]*?</w:${tag}>)`, "u"))?.[0] ?? "";

test("用户文档描述真实的内功问诊输入、门槛、导出与会话边界", () => {
  const readme = read("README.md");
  for (const text of [
    "内功问诊",
    "最多 3 个竞品",
    "默认排序评价",
    "时间排序评价",
    "产品数据包/",
    "评价数据表格-默认排序.xlsx",
    "评价数据表格-时间排序.xlsx",
    "问大家.xlsx",
    "评价页截图.png",
    "90 条",
    "前 20",
    "下载 HTML",
    "导出 Excel",
    "关闭／刷新后本次问诊状态丢失",
    "全链路分析仍使用原通用评价逻辑",
    "单个 XLSX 压缩文件最大 10MB",
    "重试综合报告",
    "不会重跑已成功的 Excel 主任务",
  ]) assert.match(readme, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const contract of [
    "精确四列 `昵称`、`时间`、`问题`、`问答`，系统按 Excel 行序补排名",
    "旧版表头必须带 `序号` 或 `排名`",
    "两个评价文件分别读取第一个工作表",
    "`旺旺号`／`用户昵称`",
    "额外的非分析列只记录警告，不阻断预检",
    "同一字段出现两个候选列",
    "`.~` 或 `~$`",
  ]) assert.ok(readme.includes(contract), `README 缺少输入合同：${contract}`);
  assert.doesNotMatch(readme, /问大家.*表头必须为：`序号`/u);
  assert.match(readme, /^OPENAI_API_KEY=你的模型服务密钥$/mu);
  assert.deepEqual(
    [...readme.matchAll(/^OPENAI_API_KEY=(.*)$/gmu)].map((match) => match[1]),
    ["你的模型服务密钥"],
  );
  assert.doesNotMatch(readme, /\/Users\/|(?:sk|sess|gh[pousr])-[A-Za-z0-9_-]{16,}/u);
});

test("接手文档与数据真源只声明当前实现和真实路径", () => {
  const claude = read("CLAUDE.md");
  const sourceOfTruth = read("SOURCE_OF_TRUTH.md");
  const roadmap = read("ROADMAP.md");

  for (const path of [
    "lib/neigong/",
    "components/neigong/",
    "app/api/neigong/analyze/route.ts",
  ]) assert.match(claude, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(claude, /全链路分析仍使用原通用评价逻辑/u);
  assert.match(claude, /node --test tests\/\*\.test\.mjs/u);
  assert.doesNotMatch(claude, /\/Users\/|codex-runtimes|skills\/documents/u);

  for (const path of [
    "components/neigong/NeigongWorkspace.tsx",
    "lib/neigong/excel-parser.ts",
    "lib/neigong/report-builder.ts",
    "lib/neigong/excel-export.ts",
    "lib/neigong/html-export.ts",
    "app/api/neigong/analyze/route.ts",
  ]) {
    assert.match(sourceOfTruth, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, `${path} 必须真实存在`);
  }
  assert.match(sourceOfTruth, /冲突/u);
  assert.match(roadmap, /功能实现与自动化验证完成，真实业务验收待补标准独立评价文件样例/u);
  assert.doesNotMatch(roadmap, /尚未开始实现/u);
});

test("Word 生成脚本与成品包含内功问诊说明且不泄露私有配置", () => {
  const source = read("tools/update_usage_guide.py");
  for (const text of [
    '("内功问诊", "上传我方与最多 3 个竞品的默认排序评价 Excel、时间排序评价 Excel、问大家 Excel 和评价页截图；确认完整性后分批分析并导出 HTML／Excel。")',
    "产品数据包/",
    "默认排序评价",
    "时间排序评价",
    "评价数据表格-默认排序.xlsx",
    "评价数据表格-时间排序.xlsx",
    "两个评价文件分别读取第一个工作表",
    "全链路分析仍使用原通用评价逻辑",
    "关闭／刷新后本次问诊状态丢失",
    "精确四列「昵称、时间、问题、问答」，系统按 Excel 行序补排名",
    "旧版表头必须带「序号」或「排名」",
    "「旺旺号／用户昵称」",
    "额外的非分析列只记录警告，不阻断预检",
    "同一字段出现两个候选列",
    "文件名以 .~ 或 ~$ 开头",
    "单个 XLSX 压缩文件最大 10MB",
    "重试综合报告",
  ]) assert.ok(source.includes(text), `生成脚本缺少：${text}`);

  const docx = fileURLToPath(new URL("../public/产品分析助手使用说明.docx", import.meta.url));
  const xml = execFileSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8" });
  for (const text of [
    "内功问诊",
    "默认排序评价",
    "时间排序评价",
    "评价数据表格-默认排序.xlsx",
    "评价数据表格-时间排序.xlsx",
    "两个评价文件分别读取第一个工作表",
    "产品数据包/",
    "最多 3 个竞品",
    "90 条",
    "前 20",
    "下载 HTML",
    "导出 Excel",
    "全链路分析仍使用原通用评价逻辑",
    "关闭／刷新后本次问诊状态丢失",
    "精确四列「昵称、时间、问题、问答」，系统按 Excel 行序补排名",
    "旧版表头必须带「序号」或「排名」",
    "「旺旺号／用户昵称」",
    "额外的非分析列只记录警告，不阻断预检",
    "同一字段出现两个候选列",
    "文件名以 .~ 或 ~$ 开头",
    "单个 XLSX 压缩文件最大 10MB",
    "重试综合报告",
  ]) assert.ok(xml.includes(text), `Word 缺少：${text}`);
  assert.doesNotMatch(xml, /问大家表头：序号、问题、回答、提问时间/u);
  const tableXml = xml.match(/<w:tbl(?:.|\n)*?<\/w:tbl>/gu) ?? [];
  assert.equal(
    tableXml.some((table) => table.includes("产品数据包/") || table.includes("待分析资料/")),
    false,
    "目录树必须是等宽段落，不能继续放在单格假表格中",
  );
  assert.match(xml, /w:ascii="Menlo"/u);
  assert.doesNotMatch(xml, /OPENAI_API_KEY|\/Users\/|codex-runtimes|skills\/documents/u);
});

test("Word 分析方式新增行继承相邻普通数据行的完整表格几何和段落格式", () => {
  const docx = fileURLToPath(new URL("../public/产品分析助手使用说明.docx", import.meta.url));
  const xml = execFileSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8" });
  const analysisTable = elements(xml, "tbl").find((table) =>
    table.includes("分析方式") && table.includes("全链路分析"));
  assert.ok(analysisTable, "必须找到分析方式表格");

  const rows = elements(analysisTable, "tr");
  assert.equal(rows.length, 7, "分析方式表格必须包含表头和 6 个数据行");
  const adjacentRow = rows[5];
  const addedRow = rows[6];
  assert.ok(adjacentRow.includes("买家秀专项分析"));
  assert.ok(addedRow.includes("全链路分析"));
  assert.equal(property(addedRow, "trPr"), property(adjacentRow, "trPr"), "新增行必须深拷贝 trPr");

  const adjacentCells = elements(adjacentRow, "tc");
  const addedCells = elements(addedRow, "tc");
  assert.equal(addedCells.length, adjacentCells.length);
  for (let index = 0; index < adjacentCells.length; index += 1) {
    const expectedCellProperties = property(adjacentCells[index], "tcPr");
    const actualCellProperties = property(addedCells[index], "tcPr");
    assert.match(actualCellProperties, /<w:tcBorders>/u, `第 ${index + 1} 列缺少边框`);
    assert.match(actualCellProperties, /<w:tcMar>/u, `第 ${index + 1} 列缺少内边距`);
    assert.match(actualCellProperties, /<w:vAlign w:val="center"\/>/u, `第 ${index + 1} 列缺少垂直居中`);
    assert.equal(actualCellProperties, expectedCellProperties, `第 ${index + 1} 列 tcPr 必须与相邻普通行一致`);
    assert.equal(
      property(addedCells[index], "pPr"),
      property(adjacentCells[index], "pPr"),
      `第 ${index + 1} 列段落格式必须与相邻普通行一致`,
    );
  }
});
