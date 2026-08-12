# 内功问诊 Web 版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将独立「评价区全盘分析」入口替换为可预检、可分批恢复、可追溯和可导出的「内功问诊」，同时保持「全链路分析」及其他现有模块行为不变。

**Architecture:** 浏览器读取标准 Excel、压缩截图并完成完整性预检；独立 `/api/neigong/analyze` Route Handler 以严格 JSON Schema 执行五类模型任务；确定性规则引擎负责门禁、查重、聚合与证据链校验。当前页面只在 `review` 模块渲染新的独立工作区，最终报告留在 React 内存并从同一个 `ReportData` 生成网页、HTML 和六工作表 Excel。

**Tech Stack:** Next.js 16.2.6、React 19.2.6、TypeScript 5.9.3、Vinext 0.0.50、Cloudflare Edge Runtime、OpenAI Responses API、`read-excel-file@9.3.9`、`fflate@^0.8.2`、Node.js 22 内置测试运行器。

## Global Constraints

- 只替换独立 `review` 入口；现有 `/api/analyze`、`lib/prompts.ts` 中的通用评价逻辑和「全链路分析」首版不改。
- 支持 1 份我方产品数据包和 0–3 份竞品数据包；有 1–3 个竞品时形成对照，0 个竞品时只做我方诊断。
- 每个产品包固定包含一份双工作表评价 Excel、一份问大家 Excel 和一张评价页截图；截图失败允许降级，评价 Excel 映射错误必须阻断。
- 默认排序、时间排序和问大家各最多使用前 100 条；模型分类批次固定 50 条；浏览器最大并发固定 2；失败自动重试 1 次。
- 完整性四态固定为 `complete`（100）、`provisional`（90–99）、`insufficient`（1–89）、`missing`（0）；低于 90 条的来源不形成正式 finding。
- 查重固定使用「初评文本 NFKC 归一化 + 删除全部 Unicode 空白 + 一对一多重集精确匹配」；追评只作为语义上下文。
- action 必须回指 finding，finding 必须回指有效 evidenceId；断链结果不得进入报告。
- 模型必须返回严格 JSON Schema；结构化输出失败时任务失败，不回退到 Markdown 解析。
- 不新增账号、数据库、后台、历史项目、localStorage 或 IndexedDB；刷新／关闭页面后状态清空。
- `OPENAI_API_KEY` 和我方产品知识只允许存在于服务器端；模型请求保持 `store: false`。
- 上传文件、解析结果和报告不在服务器端持久化；不得宣传为供应商层面的零数据留存。
- HTML 和 Excel 必须从同一个已校验 `ReportData` 生成；Excel 固定六张工作表并保留 sourceId、rowId、findingId、evidenceId。
- 文件内容使用普通空格，不写入 NBSP；项目文档使用中文。
- 不覆盖或提交现有未跟踪文件 `app/globals 2.css`、`app/layout 2.tsx`、`app/page 2.tsx`、`tsconfig.tsbuildinfo`。

---

## File Map

### 新建

- `SOURCE_OF_TRUTH.md`：网页版业务规则、协议、知识和提示词位置的唯一索引。
- `lib/neigong/types.ts`：前后端共享的输入、批次、完整性、证据和 `ReportData` 类型。
- `lib/neigong/catalog.ts`：t1–t8、q1–q8、六维和固定工作表／列名常量。
- `lib/neigong/excel-parser.ts`：标准评价 Excel、问大家 Excel 的浏览器解析和预检。
- `lib/neigong/rules.ts`：门禁、NFKC 查重、多重集匹配、聚合和证据链校验。
- `lib/neigong/image.ts`：单张评价页截图的浏览器压缩与 Data URL 转换。
- `lib/neigong/task-runner.ts`：并发 2、自动重试 1 次、人工重试和竞品排除所需的任务状态机。
- `lib/neigong/report-builder.ts`：把预检、模型批次和确定性聚合组装成最终 `ReportData`。
- `lib/neigong/html-export.ts`：从 `ReportData` 生成离线 HTML。
- `lib/neigong/excel-export.ts`：从 `ReportData` 生成固定六工作表表格。
- `lib/neigong/server/knowledge.ts`：部署内置的我方产品一页纸和客诉决策地图；仅服务器端导入。
- `lib/neigong/server/prompts.ts`：五类模型任务的服务端指令。
- `lib/neigong/server/schemas.ts`：五类请求校验器和 Responses API 严格 JSON Schema。
- `lib/neigong/server/model.ts`：Responses API 调用、拒绝识别和结构化输出解析。
- `app/api/neigong/analyze/route.ts`：内功问诊独立 JSON 接口。
- `components/neigong/NeigongWorkspace.tsx`：四阶段工作区总控和当前会话状态。
- `components/neigong/ProductPackCard.tsx`：我方／竞品数据包上传卡。
- `components/neigong/PreflightPanel.tsx`：文件角色、工作表、字段、行数和缺口确认。
- `components/neigong/AnalysisProgress.tsx`：批次进度、失败重试和竞品排除。
- `components/neigong/ReportDashboard.tsx`：六分区问诊看板。
- `tests/neigong-catalog.test.mjs`：固定分类与协议枚举。
- `tests/neigong-excel-parser.test.mjs`：标准表解析、排除记账和门禁边界。
- `tests/neigong-rules.test.mjs`：查重、聚合和证据链。
- `tests/neigong-api-contract.test.mjs`：五类 API 请求与严格 Schema 契约。
- `tests/neigong-task-runner.test.mjs`：并发、重试和排除。
- `tests/neigong-report-builder.test.mjs`：报告组装及降级。
- `tests/neigong-exports.test.mjs`：离线 HTML 与六工作表 Excel。
- `tests/neigong-workspace.test.mjs`：入口替换、旧模块隔离和 UI 文案静态契约。

### 修改

- `package.json`、`package-lock.json`：增加 `read-excel-file@9.3.9`。
- `lib/excel-export.ts`：抽出接受 `ExportTable[]` 的通用工作簿生成函数，保留旧 Markdown 导出接口。
- `app/page.tsx`：把 `review` 卡片改名为「内功问诊」，仅该模块渲染 `NeigongWorkspace`。
- `app/globals.css`：增加 `.neigong-*` 命名空间样式，不改变现有模块选择卡。
- `README.md`、`ROADMAP.md`、`CLAUDE.md`：同步新入口、架构、验证命令和真实状态。
- `tools/update_usage_guide.py`、`public/产品分析助手使用说明.docx`：同步标准数据包和四阶段流程。

---

### Task 1: 固化网页版真源、共享类型与分类目录

**Files:**
- Create: `SOURCE_OF_TRUTH.md`
- Create: `lib/neigong/types.ts`
- Create: `lib/neigong/catalog.ts`
- Create: `lib/neigong/server/knowledge.ts`
- Create: `tests/neigong-catalog.test.mjs`

**Interfaces:**
- Consumes: 已批准设计 `docs/superpowers/specs/2026-08-10-neigong-wenzhen-web-design.md`；技能真源中的 t1–t8、q1–q8、一页纸和客诉地图。
- Produces: `TAXONOMY`、`TOPICS`、`DIMENSIONS`、`ReportData`、`ParsedProductPack`、`ModelTaskRequest`、`ModelTaskResult`，供后续所有任务引用。

- [ ] **Step 1: 写分类目录失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { DIMENSIONS, TAXONOMY, TOPICS } from "../lib/neigong/catalog.ts";

test("内功问诊使用固定且互斥的分类目录", () => {
  assert.deepEqual(TAXONOMY.map(({ id }) => id), ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
  assert.deepEqual(TOPICS.map(({ id }) => id), ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"]);
  assert.ok(TOPICS.every(({ includeWhen, excludeWhen }) => includeWhen && excludeWhen));
  assert.deepEqual(DIMENSIONS, ["persona", "scene", "painPoint", "detail", "effect", "delight"]);
});
```

- [ ] **Step 2: 运行测试并确认因模块缺失而失败**

Run: `node --test tests/neigong-catalog.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 新建共享类型和固定目录**

`lib/neigong/types.ts` 至少定义这些精确接口：

```ts
export type ProductRole = "self" | "competitor";
export type ReviewSort = "default" | "recent";
export type SourceKind = "default_reviews" | "recent_reviews" | "questions" | "review_tags";
export type CompletenessStatus = "complete" | "provisional" | "insufficient" | "missing";
export type FindingStatus = "available" | "unavailable" | "historical";
export type ModelTask = "review-taxonomy" | "question-topic" | "top20-dimensions" | "screenshot-metadata" | "synthesis";

export interface ReviewRow {
  rowId: string;
  sourceId: string;
  sourceRow: number;
  productId: string;
  sort: ReviewSort;
  rank: number;
  date: string;
  sku: string;
  initialText: string;
  followupText: string;
  normalizedText: string;
  typeId?: string;
  typeEvidence?: { source: "initial" | "followup"; quote: string };
}

export interface QuestionRow {
  rowId: string;
  sourceId: string;
  sourceRow: number;
  productId: string;
  rank: number;
  questionText: string;
  answer: string;
  date: string;
  normalizedText: string;
  topicId?: string;
  topicEvidence?: string;
}

export interface SourceSummary {
  sourceId: string;
  productId: string;
  kind: SourceKind;
  rowsRead: number;
  validRows: number;
  usedRows: number;
  excludedRows: number;
  excludedOverLimit: number;
  status: CompletenessStatus;
  note: string;
}

export interface ParsedProductPack {
  product: { productId: string; role: ProductRole; name: string };
  reviews: ReviewRow[];
  questions: QuestionRow[];
  sources: SourceSummary[];
  screenshot?: { file: File; sourceId: string; status: "ready" | "missing" };
  excludedRows: Array<{ rowId: string; sourceId: string; reason: string }>;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}
```

同一文件继续定义设计文档第 10 节顶层 `ReportData` 的所有字段；禁止使用 `any`，可变字典使用 `Record<string, unknown>`。

`lib/neigong/catalog.ts` 固定导出：

```ts
export const DIMENSIONS = ["persona", "scene", "painPoint", "detail", "effect", "delight"] as const;
export const TAXONOMY = [
  { id: "t1", name: "纯功效陈述", definition: "只说效果，没有人、场景或细节" },
  { id: "t2", name: "人群场景+痛点+效果", definition: "信息最完整的一类" },
  { id: "t3", name: "痛点+效果", definition: "有痛点有结果，缺人设和场景" },
  { id: "t4", name: "人群场景+效果", definition: "有代入感但痛点弱" },
  { id: "t5", name: "体验细节", definition: "质地气味泡沫等实物感描述为主" },
  { id: "t6", name: "未使用待观察", definition: "刚收到、还没用或用得太短" },
  { id: "t7", name: "泛化无信息", definition: "好用不错可以，零信息量" },
  { id: "t8", name: "服务物流", definition: "讲发货包装客服，与产品力无关" },
] as const;

export const TOPICS = [
  { id: "q1", name: "效果验证", definition: "询问是否有效、具体效果强弱或与替代品相比是否值得购买", includeWhen: "主要决策意图是验证去屑、止痒、控油等效果", excludeWhen: "主要询问使用周期、特定人群、安全性或规格" },
  { id: "q2", name: "适用人群与症状", definition: "询问特定人群、头皮状态或症状能否使用", includeWhen: "核心是孕妇、儿童、敏感头皮、染烫或具体症状是否适用", excludeWhen: "核心是成分、使用步骤或见效时间" },
  { id: "q3", name: "规格价格与活动", definition: "询问容量、价格、赠品、组合或促销规则", includeWhen: "核心是买多少、多少钱、包含什么或活动机制", excludeWhen: "核心是效果、成分或使用方法" },
  { id: "q4", name: "使用体验与安全顾虑", definition: "询问刺激、干涩、气味、副作用或使用后的不适", includeWhen: "核心是体验风险、安全顾虑或负面反应", excludeWhen: "只问某类人能否使用而没有具体体验风险" },
  { id: "q5", name: "无关或低信息提问", definition: "与购买决策无关或无法判断意图的问题", includeWhen: "文本是占位、灌水、无意义字符或明显无关", excludeWhen: "可以归入其他任一明确决策主题" },
  { id: "q6", name: "成分与配方", definition: "询问活性成分、浓度、完整成分表或配方属性", includeWhen: "核心是二硫化硒、硅油、中草药、浓度或具体成分", excludeWhen: "只问效果或安全结果而不问配方" },
  { id: "q7", name: "品牌与信任资质", definition: "询问正品、品牌、备案、证书或宣传可信度", includeWhen: "核心是来源、真伪、品牌背书、资质或检测证明", excludeWhen: "核心是物流售后或产品功效" },
  { id: "q8", name: "使用方法与见效周期", definition: "询问频次、步骤、组合顺序、用量或多久见效", includeWhen: "核心是怎么用、多久用一次、多久见效或维持多久", excludeWhen: "只问是否有效而不关心方法或时间" },
] as const;
```

- [ ] **Step 4: 把产品知识变成部署内置的服务器常量**

创建 `lib/neigong/server/knowledge.ts`，逐字迁入以下两个真源的正文，不在运行时读取用户目录：

```text
neigong-wenzhen 技能 references/我方产品一页纸.md
neigong-wenzhen 技能 references/客诉决策地图.md
```

用 `apply_patch` 创建两个多行字符串常量 `OWN_PRODUCT_KNOWLEDGE` 和 `COMPLAINT_DECISION_MAP`；字符串内容分别与上述两个文件从一级标题开始到 EOF 完全一致。不要保留绝对路径、读取文件系统或在字符串外增加推断内容。

测试增加以下约束，防止臆造规格、价格、浓度和香型：

```js
assert.match(OWN_PRODUCT_KNOWLEDGE, /净含量 \/ 规格：.*待补充/);
assert.match(OWN_PRODUCT_KNOWLEDGE, /售价：.*待补充/);
assert.match(OWN_PRODUCT_KNOWLEDGE, /未列具体专利号 \/ 浓度百分比/);
assert.match(OWN_PRODUCT_KNOWLEDGE, /气味\/香型未明确/);
```

- [ ] **Step 5: 建立项目数据真源索引**

`SOURCE_OF_TRUTH.md` 写入以下结构和明确声明：

```md
# 产品分析助手数据真源

## 速查表

| 要找什么 | 权威文件 |
|---|---|
| 内功问诊产品与技术设计 | `docs/superpowers/specs/2026-08-10-neigong-wenzhen-web-design.md` |
| 实施任务与验收命令 | `docs/superpowers/plans/2026-08-10-neigong-wenzhen-web.md` |
| 前后端共享数据协议 | `lib/neigong/types.ts` |
| 评价类型、问题主题和六维目录 | `lib/neigong/catalog.ts` |
| 我方产品与客诉知识 | `lib/neigong/server/knowledge.ts` |
| 模型提示词与严格 Schema | `lib/neigong/server/prompts.ts`、`lib/neigong/server/schemas.ts` |
| 独立内功问诊接口 | `app/api/neigong/analyze/route.ts` |

## 冲突规则

网页版运行时以本项目文件为准，不依赖 `~/.codex/skills`。共享类型与文档冲突时先停止实现并修正设计、类型和测试，不在调用点私自兼容第二套字段。
```

- [ ] **Step 6: 运行分类测试和 TypeScript 构建**

Run: `node --test tests/neigong-catalog.test.mjs && npm run build`

Expected: 分类测试 PASS；构建成功；客户端产物中不得出现 `OWN_PRODUCT_KNOWLEDGE` 的正文。

- [ ] **Step 7: 提交真源与协议**

```bash
git add SOURCE_OF_TRUTH.md lib/neigong/types.ts lib/neigong/catalog.ts lib/neigong/server/knowledge.ts tests/neigong-catalog.test.mjs
git commit -m "feat: define neigong data contract"
```

---

### Task 2: 解析标准 Excel 并生成可确认的预检结果

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/neigong/excel-parser.ts`
- Create: `tests/neigong-excel-parser.test.mjs`

**Interfaces:**
- Consumes: `ParsedProductPack`、`ReviewRow`、`QuestionRow`、`SourceSummary`。
- Produces: `parseProductPack(input: ProductPackFiles): Promise<ParsedProductPack>` 和纯函数 `parseReviewRows`、`parseQuestionRows`，供上传 UI 调用。

- [ ] **Step 1: 安装锁定依赖**

Run: `npm install read-excel-file@9.3.9`

Expected: `package.json` 出现 `"read-excel-file": "^9.3.9"`，锁文件记录 9.3.9。

- [ ] **Step 2: 写标准评价和问大家解析失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { parseQuestionRows, parseReviewRows, statusForUsedRows } from "../lib/neigong/excel-parser.ts";

const reviewHeader = ["序号", "用户昵称", "评价时间", "评价类型", "SKU", "初评内容", "追评内容"];

test("初评是一行主记录，追评只保留为上下文", () => {
  const result = parseReviewRows("own", "default", [reviewHeader, [1, "用户A", "2026-08-01", "好评", "规格A", "  去 屑 很快  ", "12"]]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].initialText, "去 屑 很快");
  assert.equal(result.rows[0].followupText, "12");
  assert.equal(result.rows[0].normalizedText, "去屑很快");
});

test("完整性边界严格区分四态", () => {
  assert.equal(statusForUsedRows(0), "missing");
  assert.equal(statusForUsedRows(89), "insufficient");
  assert.equal(statusForUsedRows(90), "provisional");
  assert.equal(statusForUsedRows(99), "provisional");
  assert.equal(statusForUsedRows(100), "complete");
});
```

继续覆盖：缺少双工作表、`排名` 列别名、未知列名、空初评、无排名、101 条截断、问题为空、问答为空、`.~` 临时锁文件。

- [ ] **Step 3: 运行解析测试并确认失败**

Run: `node --test tests/neigong-excel-parser.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 4: 实现纯解析函数和错误记账**

`lib/neigong/excel-parser.ts` 导出：

```ts
export const REVIEW_SHEETS = ["默认排序评价", "时间排序评价"] as const;
export const REVIEW_COLUMNS = ["rank", "nickname", "date", "reviewType", "sku", "initialText", "followupText"] as const;

export function normalizeExactText(value: string): string {
  return value.normalize("NFKC").replace(/\s/gu, "");
}

export function statusForUsedRows(usedRows: number): CompletenessStatus {
  if (usedRows === 0) return "missing";
  if (usedRows < 90) return "insufficient";
  if (usedRows < 100) return "provisional";
  return "complete";
}

export function parseReviewRows(productId: string, sort: ReviewSort, rows: unknown[][]): ParsedRows<ReviewRow>;
export function parseQuestionRows(productId: string, rows: unknown[][]): ParsedRows<QuestionRow>;
export async function parseProductPack(input: ProductPackFiles): Promise<ParsedProductPack>;
```

规则必须逐条落地：只接受 `序号`／`排名` 别名；源行号从 Excel 第 2 行开始；工作表顺序与排名字段冲突写入阻断错误 `RANK_ORDER_CONFLICT`；100 条后写 `excludedOverLimit`；所有排除写原因；`.~` 文件写 warning 后忽略。

- [ ] **Step 5: 用真实双工作表工作簿验证文件级读取**

测试中使用现有 `buildExcelWorkbook()` 动态构造含「默认排序评价」「时间排序评价」两张表的 `File`，再调用 `parseProductPack()`；问大家工作簿同样构造。断言工作表映射、sourceId、sourceRow 和使用行数，不提交桌面样例副本。

- [ ] **Step 6: 运行解析测试、现有 Excel 回归和构建**

Run: `node --test tests/neigong-excel-parser.test.mjs tests/excel-export.test.mjs && npm run build`

Expected: 全部 PASS；浏览器构建不出现 Node-only `fs` 依赖。

- [ ] **Step 7: 提交 Excel 预检能力**

```bash
git add package.json package-lock.json lib/neigong/excel-parser.ts tests/neigong-excel-parser.test.mjs
git commit -m "feat: parse neigong excel packs"
```

---

### Task 3: 实现确定性门禁、精确查重、聚合和证据链校验

**Files:**
- Create: `lib/neigong/rules.ts`
- Create: `tests/neigong-rules.test.mjs`

**Interfaces:**
- Consumes: 已解析并带 rowId/sourceId 的评价与问题；模型返回的 typeId/topicId/六维标注。
- Produces: `buildDedupAggregate`、`buildTypeStats`、`buildQuestionStats`、`buildSixDimensionStats`、`getAnalysisReadiness`、`validateEvidenceGraph`。

- [ ] **Step 1: 写多重集和证据链失败测试**

```js
test("默认与时间表按一对一多重集匹配", () => {
  const result = buildDedupAggregate(
    [review("d1", "相同"), review("d2", "相同"), review("d3", "不同")],
    [review("r1", "相同"), review("r2", "别的")],
  );
  assert.equal(result.crossLists[0].overlapRows, 1);
  assert.deepEqual(result.crossLists[0].pairs, [{ leftRowId: "d1", rightRowId: "r1" }]);
});

test("断链 action 不能通过验证", () => {
  const validation = validateEvidenceGraph(report({
    findings: [{ id: "F01", status: "available", evidenceIds: ["AGG-MISSING"] }],
    actions: [{ priority: "P0", findingIds: ["F01"], reason: "F01｜AGG-MISSING：补内容" }],
  }));
  assert.equal(validation.valid, false);
  assert.match(validation.errors[0].code, /UNKNOWN_EVIDENCE/);
});
```

继续覆盖：单表重复组、全角半角 NFKC、Unicode 空白、emoji 保留、t1–t8 单选、q1–q8 单选、90 条 finding 可用、89 条 finding 不可用、F02 20／89／90 条边界、最多 8 条 actions。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/neigong-rules.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现可复算的确定性函数**

```ts
export function matchExactMultiset(left: ReviewRow[], right: ReviewRow[]): Array<{ leftRowId: string; rightRowId: string }> {
  const queues = new Map<string, ReviewRow[]>();
  for (const row of right) queues.set(row.normalizedText, [...(queues.get(row.normalizedText) ?? []), row]);
  const pairs: Array<{ leftRowId: string; rightRowId: string }> = [];
  for (const row of left) {
    const match = queues.get(row.normalizedText)?.shift();
    if (match) pairs.push({ leftRowId: row.rowId, rightRowId: match.rowId });
  }
  return pairs;
}
```

聚合函数只能读取逐条结果，不读取模型自报计数。每个聚合项生成稳定 evidenceId，例如 `AGG-TYPE-own-t1`、`AGG-SIX-own-scene`、`AGG-QUESTION-own-q1`。

- [ ] **Step 4: 实现 readiness 和证据图校验**

`getAnalysisReadiness()` 固定规则：F01 需要我方 default/recent 均 ≥90；F02 需要 default ≥90 才正式 available，20–89 只保留逐条结果；F03 需要我方 questions ≥90，并只纳入 questions ≥90 的竞品。

`validateEvidenceGraph()` 必须检查：所有 rowId 唯一、所有模型 rowId 来自输入、所有 finding evidenceId 存在、所有 action findingId 存在、reason 中的 findingId/evidenceId 与数组一致、actions ≤8、聚合计数与明细一致。

- [ ] **Step 5: 运行规则测试**

Run: `node --test tests/neigong-rules.test.mjs`

Expected: 全部 PASS。

- [ ] **Step 6: 提交规则引擎**

```bash
git add lib/neigong/rules.ts tests/neigong-rules.test.mjs
git commit -m "feat: add auditable neigong rules"
```

---

### Task 4: 建立五类严格 JSON 模型任务接口

**Files:**
- Create: `lib/neigong/server/prompts.ts`
- Create: `lib/neigong/server/schemas.ts`
- Create: `lib/neigong/server/model.ts`
- Create: `app/api/neigong/analyze/route.ts`
- Create: `tests/neigong-api-contract.test.mjs`

**Interfaces:**
- Consumes: `ModelTaskRequest`，每批最多 50 条评价／问题，前 20 六维最多 20 条，截图 Data URL 只用于截图任务，synthesis 只接收已聚合事实。
- Produces: `{ ok: true, task, result }` 或 `{ ok: false, code, error, retryable }`；不返回 Markdown。

- [ ] **Step 1: 写请求校验和 Schema 失败测试**

```js
test("评价分类批次拒绝 51 条和未知 task", () => {
  assert.deepEqual(validateModelTaskRequest({ task: "review-taxonomy", productId: "own", rows: rows(51) }).ok, false);
  assert.deepEqual(validateModelTaskRequest({ task: "unknown", productId: "own", rows: [] }).code, "INVALID_TASK");
});

test("所有模型任务使用 strict JSON Schema", () => {
  for (const task of MODEL_TASKS) {
    const format = RESPONSE_FORMATS[task];
    assert.equal(format.type, "json_schema");
    assert.equal(format.strict, true);
    assert.ok(format.name.startsWith("neigong_"));
  }
});
```

继续覆盖：重复 rowId、未知 typeId/topicId、证据 quote 不在初评或追评、截图非 `data:image/`、请求正文超过 900KB、模型 401、429、5xx、refusal、空输出、非法 JSON、Schema 缺字段。

- [ ] **Step 2: 运行 API 契约测试并确认失败**

Run: `node --test tests/neigong-api-contract.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现请求校验器与严格 Schema**

`lib/neigong/server/schemas.ts` 导出：

```ts
export const MODEL_TASKS = ["review-taxonomy", "question-topic", "top20-dimensions", "screenshot-metadata", "synthesis"] as const;
export function validateModelTaskRequest(value: unknown): ValidationResult<ModelTaskRequest>;
export function validateModelTaskResult(task: ModelTask, value: unknown): ValidationResult<ModelTaskResult>;
```

五个格式按以下结构定义；`strictObject()` 必须返回 `type: "object"`、`additionalProperties: false`、传入的 `properties` 和全部属性名组成的 `required`：

```ts
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
  persona: { type: "boolean" }, scene: { type: "boolean" }, painPoint: { type: "boolean" },
  detail: { type: "boolean" }, effect: { type: "boolean" }, delight: { type: "boolean" },
});
const dimensionEvidence = strictObject({
  persona: { type: "string" }, scene: { type: "string" }, painPoint: { type: "string" },
  detail: { type: "string" }, effect: { type: "string" }, delight: { type: "string" },
});
const top20Label = strictObject({
  rowId: { type: "string" }, dimensions: dimensionFlags, evidence: dimensionEvidence,
  score: { type: "integer", minimum: 0, maximum: 6 }, note: { type: "string" },
});

const screenshotResult = strictObject({
  productName: { type: ["string", "null"] },
  reviewTotal: { type: ["string", "null"] },
  questionTotal: { type: ["string", "null"] },
  tags: { type: "array", items: strictObject({ tag: { type: "string" }, count: { type: ["integer", "null"], minimum: 0 } }) },
  completeness: { type: "string", enum: ["complete", "partial", "missing"] },
});

const finding = strictObject({
  id: { type: "string", enum: ["F01", "F02", "F03"] },
  status: { type: "string", enum: ["available", "unavailable"] },
  title: { type: "string" }, text: { type: "string" },
  evidenceIds: { type: "array", items: { type: "string" } },
});
const action = strictObject({
  priority: { type: "string", enum: ["P0", "P1", "P2"] },
  action: { type: "string" }, reason: { type: "string" },
  findingIds: { type: "array", items: { type: "string", enum: ["F01", "F02", "F03"] } },
});

export const RESPONSE_FORMATS: Record<ModelTask, StrictJsonFormat> = {
  "review-taxonomy": { type: "json_schema", name: "neigong_review_taxonomy", strict: true, schema: strictObject({ labels: { type: "array", items: reviewLabel } }) },
  "question-topic": { type: "json_schema", name: "neigong_question_topic", strict: true, schema: strictObject({ labels: { type: "array", items: questionLabel } }) },
  "top20-dimensions": { type: "json_schema", name: "neigong_top20_dimensions", strict: true, schema: strictObject({ rows: { type: "array", items: top20Label } }) },
  "screenshot-metadata": { type: "json_schema", name: "neigong_screenshot_metadata", strict: true, schema: screenshotResult },
  synthesis: { type: "json_schema", name: "neigong_synthesis", strict: true, schema: strictObject({ findings: { type: "array", items: finding }, actions: { type: "array", maxItems: 8, items: action } }) },
};
```

分类结果只允许输入中存在的 rowId；服务端在 Schema 校验后再做引用校验。

- [ ] **Step 4: 实现服务端提示词**

`lib/neigong/server/prompts.ts` 只导出服务端函数：

```ts
export function getNeigongInstructions(task: ModelTask): string;
export function buildNeigongInput(request: ModelTaskRequest): Array<InputContent>;
```

评价分类写明 t1–t8 单选、证据来源只能 `initial`／`followup`、低信息追评不加分；问题分类写明 q1–q8 和 include/exclude；六维逐维返回 boolean 和原文依据；synthesis 只能读取代码聚合值并输出 F01–F03 与最多 8 条动作；我方事实只注入 `OWN_PRODUCT_KNOWLEDGE` 和 `COMPLAINT_DECISION_MAP`。

- [ ] **Step 5: 实现独立 Responses API 调用**

```ts
body: JSON.stringify({
  model: process.env.OPENAI_MODEL || "gpt-5.6",
  instructions,
  input: [{ role: "user", content }],
  text: { format: RESPONSE_FORMATS[task] },
  max_output_tokens: MAX_OUTPUT_TOKENS[task],
  store: false,
})
```

`MAX_OUTPUT_TOKENS` 固定为：评价分类 8000、问题分类 8000、前 20 六维 10000、截图元数据 4000、综合结论 8000。`callNeigongModel()` 解析 `output_text` 或 `output[].content[].text`；识别 `refusal`；JSON.parse 后必须再调用 `validateModelTaskResult()`。401 映射 `MODEL_AUTH` 且不可重试；429、5xx、网络错误映射可重试；Schema 错误映射 `MODEL_SCHEMA_INVALID`。

- [ ] **Step 6: 实现 Edge Route Handler**

路由先检查 `Content-Length`，再通过 `request.body.getReader()` 逐块读取；累计字节一旦超过 900KB 立即 `reader.cancel()` 并返回 413 `REQUEST_TOO_LARGE`，禁止先调用 `request.text()` 把未知大小正文整体读进内存。使用 `TextDecoder` 拼接限额内文本后再 JSON.parse。返回头固定 `Cache-Control: no-store`。缺少 API Key 返回 503 `MODEL_NOT_CONFIGURED`；不要导入旧 `/api/analyze` 路由或修改旧路由。

- [ ] **Step 7: 运行 API 契约、旧路由回归和构建**

Run: `node --test tests/neigong-api-contract.test.mjs tests/main-image-module.test.mjs && npm run build`

Expected: 全部 PASS；构建包含 `/api/neigong/analyze`；旧 `/api/analyze` 仍构建成功。

- [ ] **Step 8: 提交独立模型接口**

```bash
git add lib/neigong/server app/api/neigong/analyze/route.ts tests/neigong-api-contract.test.mjs
git commit -m "feat: add structured neigong api"
```

---

### Task 5: 实现截图压缩和可恢复批次调度

**Files:**
- Create: `lib/neigong/image.ts`
- Create: `lib/neigong/task-runner.ts`
- Create: `tests/neigong-task-runner.test.mjs`

**Interfaces:**
- Consumes: 已解析产品包；`execute(task): Promise<ModelTaskResult>` 注入函数。
- Produces: `prepareReviewScreenshot(file)`、`buildPrimaryAnalysisTasks(packs)`、`buildSynthesisTask(facts)`、`runTaskQueue(tasks, execute, options)` 和可序列化进度状态。

- [ ] **Step 1: 写并发与重试失败测试**

```js
test("最多并发两个任务且每个失败任务只自动重试一次", async () => {
  let active = 0;
  let peak = 0;
  const attempts = new Map();
  const result = await runTaskQueue(tasks(5), async (task) => {
    active += 1;
    peak = Math.max(peak, active);
    attempts.set(task.id, (attempts.get(task.id) ?? 0) + 1);
    await tick();
    active -= 1;
    if (task.id === "t3" && attempts.get(task.id) === 1) throw retryableError();
    return success(task.id);
  }, { concurrency: 2, retries: 1 });
  assert.equal(peak, 2);
  assert.equal(attempts.get("t3"), 2);
  assert.equal(result.failed.length, 0);
});
```

继续覆盖：不可重试错误不二次调用、自动重试后仍失败进入 `failed`、`retryTask(id)` 只重跑失败任务、`excludeProduct(productId)` 不删除其他产品结果、每 50 行分批、前 20 和截图各一个任务。

- [ ] **Step 2: 运行任务调度测试并确认失败**

Run: `node --test tests/neigong-task-runner.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现截图压缩**

复用 `lib/browser-image-compression.ts` 的 Canvas 思路，但只处理一张评价页截图。导出：

```ts
export const MAX_SCREENSHOT_BYTES = 560 * 1024;
export async function prepareReviewScreenshot(file: File): Promise<{ dataUrl: string; width: number; height: number; bytes: number }>;
```

只接受 JPEG、PNG、WebP；依次尝试最大边 1800/1500/1200/900/720 和 WebP 质量 0.82/0.68/0.54/0.42，直到 ≤560KB；失败抛 `SCREENSHOT_TRANSPORT_LIMIT`，由工作流降级为 `missing`，不能阻断 Excel 分析。

- [ ] **Step 4: 实现纯任务队列状态机**

```ts
export interface AnalysisTask {
  id: string;
  productId: string;
  task: ModelTask;
  payload: ModelTaskRequest;
}

export function buildPrimaryAnalysisTasks(packs: ParsedProductPack[]): AnalysisTask[];
export function buildSynthesisTask(facts: SynthesisFacts): AnalysisTask;

export async function runTaskQueue(
  tasks: AnalysisTask[],
  execute: (task: AnalysisTask) => Promise<ModelTaskResult>,
  options: { concurrency: 2; retries: 1; onProgress?: (state: QueueState) => void },
): Promise<QueueState>;

export type TaskQueueAction =
  | { type: "retry"; taskId: string }
  | { type: "exclude-product"; productId: string }
  | { type: "progress"; state: QueueState };
export function taskQueueReducer(state: QueueState, action: TaskQueueAction): QueueState;
```

结果按 task.id 存储，重试不得覆盖成功任务；排除竞品只把该 productId 的任务标为 `excluded`。页面人工重试通过同一个 reducer 恢复，不复制一套调度逻辑。

主队列只包含评价分类、问题分类、前 20 六维和截图元数据。主队列完成后，客户端先运行 `rules.ts` 得到完整性、查重和聚合事实，再用这些事实创建唯一 synthesis 任务；synthesis 成功后才能组装正式报告。不得在聚合完成前预建空 synthesis 请求。

- [ ] **Step 5: 运行调度测试**

Run: `node --test tests/neigong-task-runner.test.mjs`

Expected: 全部 PASS。

- [ ] **Step 6: 提交压缩和调度能力**

```bash
git add lib/neigong/image.ts lib/neigong/task-runner.ts tests/neigong-task-runner.test.mjs
git commit -m "feat: add recoverable neigong task queue"
```

---

### Task 6: 建立上传卡、完整性预检和进度恢复界面

**Files:**
- Create: `components/neigong/ProductPackCard.tsx`
- Create: `components/neigong/PreflightPanel.tsx`
- Create: `components/neigong/AnalysisProgress.tsx`
- Create: `components/neigong/NeigongWorkspace.tsx`
- Create: `tests/neigong-workspace.test.mjs`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `parseProductPack()`、`prepareReviewScreenshot()`、`buildPrimaryAnalysisTasks()`、`buildSynthesisTask()`、`runTaskQueue()`。
- Produces: `<NeigongWorkspace />`，由 `app/page.tsx` 在 `activeModule === "review"` 时挂载；成功后把 `ReportData` 交给报告看板。

- [ ] **Step 1: 写四阶段工作区静态失败测试**

```js
test("内功问诊工作区包含上传、预检、分析和报告四阶段", async () => {
  const source = await readFile(new URL("../components/neigong/NeigongWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /上传资料/);
  assert.match(source, /完整性检查/);
  assert.match(source, /分批分析/);
  assert.match(source, /问诊看板/);
  assert.match(source, /beforeunload/);
});
```

继续检查「我方产品」、最多三个竞品、添加竞品、确认映射后分析、手动重试、排除该竞品、刷新后丢失提示等文案。

- [ ] **Step 2: 运行工作区测试并确认失败**

Run: `node --test tests/neigong-workspace.test.mjs`

Expected: FAIL，错误包含 `ENOENT`。

- [ ] **Step 3: 实现产品数据包上传卡**

每张 `ProductPackCard` 明确三个槽位：评价 Excel、问大家 Excel、评价页截图。竞品卡允许改名和删除；我方卡不可删除；当竞品数为 3 时隐藏「添加竞品」。文件选择后立即解析 Excel，但不得调用模型。

```ts
type ProductPackCardProps = {
  productId: string;
  role: ProductRole;
  name: string;
  files: ProductPackFiles;
  onChange(next: ProductPackDraft): void;
  onRemove?: () => void;
};
```

- [ ] **Step 4: 实现完整性预检和确认门禁**

`PreflightPanel` 按产品显示文件角色、工作表名称、字段映射、rowsRead、validRows、usedRows、excludedRows、excludedOverLimit、截图状态、errors、warnings。存在 `RANK_ORDER_CONFLICT`、缺工作表、产品名为空或归属未确认时禁用「确认并开始分析」。`insufficient` 只显示警告，不阻断逐条分析。

- [ ] **Step 5: 实现进度、重试和竞品排除**

进度按「已完成批次／总批次」展示，每个失败项显示错误码和「重试此批次」。竞品失败时额外显示「排除该竞品并继续」；我方失败不得提供排除。成功任务保持绿色完成状态，人工操作不能清空它们。

- [ ] **Step 6: 实现当前会话状态和离开提醒**

`NeigongWorkspace` 使用 `useReducer` 保存 draft/preflight/running/report；不存在 localStorage/IndexedDB。只在已有解析数据或任务运行时注册 `beforeunload`：

```ts
useEffect(() => {
  if (!hasUnsavedSession) return;
  const warn = (event: BeforeUnloadEvent) => event.preventDefault();
  window.addEventListener("beforeunload", warn);
  return () => window.removeEventListener("beforeunload", warn);
}, [hasUnsavedSession]);
```

- [ ] **Step 7: 增加 `.neigong-*` 隔离样式并验证响应式布局**

桌面产品卡最多两列；≤760px 改为单列；预检宽表使用横向滚动；按钮具备 `:focus-visible`；状态不能只靠颜色表达。不得重命名现有 `.module-card`、`.upload-*` 或 `.result-*` 选择器。

- [ ] **Step 8: 运行 UI 静态测试和构建**

Run: `node --test tests/neigong-workspace.test.mjs && npm run build`

Expected: PASS；无 TypeScript 错误；尚未修改 `app/page.tsx`，所以首页行为保持原样。

- [ ] **Step 9: 提交四阶段工作区**

```bash
git add components/neigong app/globals.css tests/neigong-workspace.test.mjs
git commit -m "feat: add neigong analysis workspace"
```

---

### Task 7: 组装可审计报告并渲染六分区看板

**Files:**
- Create: `lib/neigong/report-builder.ts`
- Create: `components/neigong/ReportDashboard.tsx`
- Create: `tests/neigong-report-builder.test.mjs`
- Modify: `components/neigong/NeigongWorkspace.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `ParsedProductPack[]`、任务结果、`rules.ts` 聚合和 synthesis 结果。
- Produces: `buildReportData(input): ReportData`；只在 `validateEvidenceGraph(report).valid === true` 时显示正式报告。

- [ ] **Step 1: 写降级报告和证据链失败测试**

```js
test("89 条默认评价保留逐条结果但 F02 unavailable", () => {
  const report = buildReportData(fixture({ ownDefault: 89, ownRecent: 100, ownQuestions: 100 }));
  assert.equal(report.meta.completeness.find(({ kind }) => kind === "self_default_reviews").status, "insufficient");
  assert.equal(report.findings.find(({ id }) => id === "F02").status, "unavailable");
  assert.equal(report.top20.length, 20);
});

test("无竞品时 F03 明说只有我方诊断", () => {
  const report = buildReportData(fixture({ competitors: [] }));
  assert.match(report.findings.find(({ id }) => id === "F03").text, /未上传竞品/);
});
```

继续覆盖：截图 missing、单竞品 questions 不足被排除、其他竞品保留、F01 数字来自聚合、action ≤8、legacy.enabled=false、errors/warnings/excludedRows 不丢失。

- [ ] **Step 2: 运行报告组装测试并确认失败**

Run: `node --test tests/neigong-report-builder.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现报告组装器**

```ts
export function buildReportData(input: BuildReportInput): ReportData {
  const report = {
    meta: buildMeta(input),
    products: buildProducts(input),
    sources: input.packs.flatMap((pack) => pack.sources),
    taxonomy: [...TAXONOMY],
    topics: [...TOPICS],
    reviews: mergeReviewLabels(input),
    reviewTags: mergeScreenshotTags(input),
    questions: mergeQuestionLabels(input),
    top20: mergeTop20(input),
    aggregates: buildAggregates(input),
    findings: gateFindings(input),
    actions: gateActions(input).slice(0, 8),
    legacy: { enabled: false, status: "disabled", notice: "", rowDetailStatus: "", reviews: [], taxonomy: [], top20: [], aggregates: {} },
    excludedRows: input.packs.flatMap((pack) => pack.excludedRows),
    errors: collectErrors(input),
    warnings: collectWarnings(input),
  } satisfies ReportData;
  const validation = validateEvidenceGraph(report);
  if (!validation.valid) throw new ReportValidationError(validation.errors);
  report.meta.validation = validation;
  return report;
}
```

不得使用模型返回的总数、比例或 readiness；synthesis finding 的 evidenceIds 经过白名单过滤，非法 finding 改为 `unavailable` 并写错误。

- [ ] **Step 4: 渲染六分区看板**

`ReportDashboard` 固定渲染：数据完整性与产品对照、评价类型与展示倾向、默认前 20 六维、问大家对照、分析结论、落地清单。每个分区在无数据时显示 `unavailable` 和具体缺口；不隐藏空分区。只诊断问题，不增加「优势总结」。

- [ ] **Step 5: 接入工作区报告阶段**

所有批次完成或用户排除失败竞品后，先在客户端调用 `buildReportData()`；验证失败时停在进度页显示错误码，不渲染部分正式报告。验证成功才把 stage 切换到 `report`。

- [ ] **Step 6: 运行报告测试和构建**

Run: `node --test tests/neigong-report-builder.test.mjs tests/neigong-rules.test.mjs && npm run build`

Expected: 全部 PASS。

- [ ] **Step 7: 提交报告看板**

```bash
git add lib/neigong/report-builder.ts components/neigong/ReportDashboard.tsx components/neigong/NeigongWorkspace.tsx app/globals.css tests/neigong-report-builder.test.mjs
git commit -m "feat: render auditable neigong report"
```

---

### Task 8: 从同一报告对象导出离线 HTML 和六工作表 Excel

**Files:**
- Modify: `lib/excel-export.ts`
- Create: `lib/neigong/html-export.ts`
- Create: `lib/neigong/excel-export.ts`
- Create: `tests/neigong-exports.test.mjs`
- Modify: `components/neigong/ReportDashboard.tsx`

**Interfaces:**
- Consumes: 已通过证据图校验的 `ReportData`。
- Produces: `buildNeigongHtml(report): string`、`buildNeigongWorkbook(report): Uint8Array`；旧 `buildExcelWorkbook(markdown, title)` 签名保持不变。

- [ ] **Step 1: 写导出失败测试**

```js
test("内功问诊 Excel 固定六张工作表", () => {
  const workbook = unzipSync(buildNeigongWorkbook(validReport()));
  const xml = strFromU8(workbook["xl/workbook.xml"]);
  for (const name of ["数据完整性", "评价逐条标注", "前 20 六维", "问大家逐条标注", "分析结论", "落地清单"]) {
    assert.match(xml, new RegExp(`name="${name}"`));
  }
});

test("离线 HTML 内嵌报告且不包含密钥或外部脚本", () => {
  const html = buildNeigongHtml(validReport());
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /window\.REPORT_DATA/);
  assert.doesNotMatch(html, /OPENAI_API_KEY|api\.openai\.com/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});
```

- [ ] **Step 2: 运行导出测试并确认失败**

Run: `node --test tests/neigong-exports.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 保持旧接口并抽出通用工作簿生成器**

在 `lib/excel-export.ts` 新增：

```ts
export function buildWorkbookFromTables(tables: ExportTable[], title: string): Uint8Array;

export function buildExcelWorkbook(markdown: string, title: string): Uint8Array {
  const tables = parseMarkdownTables(markdown);
  if (!tables.length) throw new Error("没有识别到可导出的分析表格。");
  return buildWorkbookFromTables(tables, title);
}
```

只移动现有打包逻辑，不改变旧表格样式、冻结首行和筛选行为。

- [ ] **Step 4: 把 ReportData 映射为固定六表**

`buildNeigongWorkbook()` 明确列出每张表列序；评价表包含 productId、sort、rank、sourceId、sourceRow、rowId、初评、追评、typeId、typeEvidence；结论和动作表保留 findingId/evidenceId 引用。所有比例用代码聚合值格式化，不重新计算模型文本。

- [ ] **Step 5: 生成自包含 HTML**

`buildNeigongHtml()` 对 `</script>`、`<`、U+2028、U+2029 做 JSON 转义，将 `ReportData` 写入 `window.REPORT_DATA`；内嵌看板 CSS 和纯浏览器渲染函数，不加载 CDN，不包含上传原文件和 API Key。

- [ ] **Step 6: 接入两个下载按钮**

报告顶栏提供「下载 HTML」「导出 Excel」；两者都读取当前不可变 `report`。文件名使用 `内功问诊-${YYYY-MM-DD}.html/.xlsx`，生成后立即 `URL.revokeObjectURL()`。

- [ ] **Step 7: 运行新旧导出回归**

Run: `node --test tests/neigong-exports.test.mjs tests/excel-export.test.mjs`

Expected: 新导出与旧 Markdown Excel 导出全部 PASS。

- [ ] **Step 8: 提交双导出能力**

```bash
git add lib/excel-export.ts lib/neigong/html-export.ts lib/neigong/excel-export.ts components/neigong/ReportDashboard.tsx tests/neigong-exports.test.mjs
git commit -m "feat: export neigong html and workbook"
```

---

### Task 9: 替换独立入口并完成旧模块隔离回归

**Files:**
- Modify: `app/page.tsx:16-130, 302-1300`
- Modify: `tests/neigong-workspace.test.mjs`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `tests/workflow-copy.test.mjs`

**Interfaces:**
- Consumes: `<NeigongWorkspace />`。
- Produces: 用户在第 04 个入口进入新问诊；其他五个入口继续走旧上传与 `/api/analyze`。

- [ ] **Step 1: 先把入口隔离断言写进测试**

```js
assert.match(pageSource, /title: "内功问诊"/);
assert.doesNotMatch(pageSource, /title: "评价区全盘分析"/);
assert.match(pageSource, /activeModule === "review"[\s\S]*<NeigongWorkspace/);
assert.match(pageSource, /fetch\("\/api\/analyze"/);
assert.match(neigongSource, /\/api\/neigong\/analyze/);
assert.doesNotMatch(neigongSource, /\/api\/analyze/);
```

渲染 HTML 测试同时断言「内功问诊」和「全链路分析」都存在，保证不是删除全链路。

- [ ] **Step 2: 运行入口测试并确认旧文案导致失败**

Run: `node --test tests/neigong-workspace.test.mjs tests/rendered-html.test.mjs tests/workflow-copy.test.mjs`

Expected: 至少一项 FAIL，显示仍存在「评价区全盘分析」。

- [ ] **Step 3: 修改模块名称与说明**

把 `review` 卡片改为：

```ts
{
  key: "review",
  order: "04",
  title: "内功问诊",
  description: "对照默认与时间排序评价、前 20 六维和问大家，输出可追溯诊断。",
}
```

`complete` 文案和 `analysisCopy.complete` 保持不变；`lib/prompts.ts` 不改。

- [ ] **Step 4: 只在 review 分支渲染新工作区**

在模块卡片之后使用明确分支：

```tsx
{activeModule === "review" && <NeigongWorkspace />}
{activeModule !== "review" && (
  <>
```

在当前 `analysisResult` 结果区结束后、外层 `workspace` 关闭前补上：

```tsx
  </>
)}
```

`switchModule()` 切离 review 时卸载 `NeigongWorkspace`，从而清空内存；旧 `startAnalysis()` 不能处理 review 分支，也不能把 review 文件提交给 `/api/analyze`。

- [ ] **Step 5: 运行入口、所有现有 Node 测试和构建**

Run: `node --test tests/*.test.mjs && npm run build`

Expected: 全部 PASS；服务端渲染首页包含「内功问诊」；市场、竞品、详情页、买家秀、全链路仍可见。

- [ ] **Step 6: 提交入口替换**

```bash
git add app/page.tsx tests/neigong-workspace.test.mjs tests/rendered-html.test.mjs tests/workflow-copy.test.mjs
git commit -m "feat: replace review entry with neigong"
```

---

### Task 10: 更新用户文档、接手文档和项目状态

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `CLAUDE.md`
- Modify: `SOURCE_OF_TRUTH.md`
- Modify: `tools/update_usage_guide.py`
- Modify: `public/产品分析助手使用说明.docx`

**Interfaces:**
- Consumes: 已实际完成的入口、输入规则、接口、导出和验证命令。
- Produces: 与运行代码一致的用户说明和 Agent 接手入口。

- [ ] **Step 1: 更新 Word 生成脚本的失败约束**

在 `tools/update_usage_guide.py` 把分析方式行改为：

```py
("内功问诊", "上传我方与最多 3 个竞品的双工作表评价 Excel、问大家 Excel 和评价页截图；确认完整性后分批分析并导出 HTML／Excel。"),
```

新增标准目录示例：

```text
产品数据包/
├── 评价数据.xlsx（默认排序评价、时间排序评价）
├── 问大家.xlsx
└── 评价页截图.png
```

明确写入「全链路分析仍使用原通用评价逻辑」和「关闭／刷新后本次问诊状态丢失」。

- [ ] **Step 2: 生成并检查 Word 文档**

Run: `python3 tools/update_usage_guide.py`

Expected: 命令成功；`public/产品分析助手使用说明.docx` 修改时间更新；解包 `word/document.xml` 能搜索到「内功问诊」「默认排序评价」「时间排序评价」。

- [ ] **Step 3: 同步 README、CLAUDE、SOURCE_OF_TRUTH**

README 写用户流程和输入模板；CLAUDE 补充 `lib/neigong/`、`components/neigong/`、独立 API、TDD 命令和旧全链路边界；SOURCE_OF_TRUTH 更新为已存在文件并声明冲突规则。不得把 API Key、用户桌面路径或技能运行时路径写入公开用户说明。

- [ ] **Step 4: 只按真实进度更新 ROADMAP**

如果自动化测试通过但尚未用正式双工作表真实数据验收，写「功能实现与自动化验证完成，真实业务验收待补标准双工作表样例」；只有完成 Task 11 的真实人工核对后才写「业务验收完成」。

- [ ] **Step 5: 运行文档引用和全量验证**

Run: `rg -n "评价区全盘分析|内功问诊|api/neigong|SOURCE_OF_TRUTH" README.md ROADMAP.md CLAUDE.md SOURCE_OF_TRUTH.md tools/update_usage_guide.py app/page.tsx`

Expected: 独立入口只使用「内功问诊」；「评价区全盘分析」只允许出现在历史说明或明确的旧全链路边界中。

- [ ] **Step 6: 提交文档和使用说明**

```bash
git add README.md ROADMAP.md CLAUDE.md SOURCE_OF_TRUTH.md tools/update_usage_guide.py public/产品分析助手使用说明.docx
git commit -m "docs: document neigong workflow"
```

---

### Task 11: 对抗式验证、真实样例预检与最终验收

**Files:**
- Modify: `tests/neigong-excel-parser.test.mjs`
- Modify: `tests/neigong-rules.test.mjs`
- Modify: `tests/neigong-api-contract.test.mjs`
- Modify: `tests/neigong-task-runner.test.mjs`
- Modify: `tests/neigong-exports.test.mjs`
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: 完整实现和本地只读样例。
- Produces: 自动化攻击面验证、样例解析证据和不夸大的业务验收状态。

- [ ] **Step 1: 以恶意输入补齐边界测试**

增加并执行：超长单元格、公式单元格、重复 rank、负 rank、51 条 API 伪批次、900KB+ JSON、Data URL 冒充、模型返回未知 rowId、模型返回 9 条 actions、evidenceId 注入分隔符、同一任务重复完成、人工重试与排除同时触发、HTML 中 `</script><script>` 注入、Excel 公式开头 `=+-@` 文本。

Excel 导出对 `=`, `+`, `-`, `@` 开头的用户文本前置单引号，防止公式注入；HTML 导出必须把恶意文本作为 textContent 或安全转义文本处理。

- [ ] **Step 2: 运行完整自动化门禁**

Run: `node --test tests/*.test.mjs && npm run lint && npm run build && git diff --check`

Expected: 所有命令退出码 0；无 ESLint error；无格式空白错误。

- [ ] **Step 3: 用桌面样例做只读解析核对**

使用本地只读评价表与问大家样例调用解析器，只验证：评价表识别 280 条原始行和标准列，问大家使用 100 条，临时锁文件被忽略。由于评价样例只有一类排序，预检必须显示缺少对应评价来源并阻断正式分析；不能把它当正式验收通过。

- [ ] **Step 4: 用正式双工作表数据完成人工验收**

获得含「默认排序评价」「时间排序评价」的正式我方与至少一个竞品数据包后：核对各表行数和排除原因；抽查至少 20 条分类证据；独立复算默认／时间交集；逐条从 P0 action 反查 finding/evidenceId/原始行；对比网页、HTML、Excel 数字；模拟一个竞品失败并确认其余产品完成。

- [ ] **Step 5: 更新 ROADMAP 为真实状态并提交验证补丁**

若缺少正式数据，ROADMAP 写明阻塞材料和自动化已通过，不写业务完成。若正式验收通过，记录数据日期、参与竞品数和八项验收结果，不记录客户隐私或原始评价内容。

```bash
git add tests/neigong-*.test.mjs ROADMAP.md
git commit -m "test: harden neigong workflow"
```

---

## Final Verification

- [ ] `node --test tests/*.test.mjs` 全部通过。
- [ ] `npm run lint` 无 error。
- [ ] `npm run build` 成功。
- [ ] `git diff --check` 无输出。
- [ ] `git status --short` 只保留用户原有未跟踪文件，不包含本功能漏提交文件。
- [ ] 首页独立入口显示「内功问诊」，「全链路分析」仍存在且继续调用旧通用逻辑。
- [ ] 0、1、3 个竞品路径均验证；4 个竞品无法添加。
- [ ] 89／90／99／100／101 条边界均有自动化测试。
- [ ] 模型严格 JSON 失败不会回退 Markdown。
- [ ] action → finding → evidenceId → 原始行／聚合项可完整反查。
- [ ] HTML 和 Excel 与网页使用同一 `ReportData`，数字一致。
- [ ] 正式业务验收未完成前，README／ROADMAP 不宣称完成。
