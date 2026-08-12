# 产品分析助手 Agent 接手说明

## 项目定位

这是一个简约的单页商品分析网站，不是完整业务系统。核心业务顺序是「先看市场，再拆竞品」，也允许运营直接进入详情页分析、内功问诊、买家秀专项分析或全链路分析。

## 关键文件

- `app/page.tsx`：6 个入口与页面级模块切换；`review` 分支只挂载 `NeigongWorkspace`，其他入口保留原通用工作区。
- `components/neigong/`：内功问诊四阶段 UI，包括产品数据包、完整性检查、任务进度和六区报告看板。
- `lib/neigong/`：共享类型、固定目录、Excel 解析、截图预处理、任务队列、客户端、报告构建、证据校验及 HTML／Excel 导出。
- `lib/neigong/xlsx-archive.ts`：浏览器端 XLSX 压缩文件、中央目录、entry 展开大小、总展开大小和压缩比预算；必须在 `unzipSync` 前失败关闭。
- `lib/neigong/synthesis-orchestrator.ts`：综合报告自动重试 1 次、人工重试、并发阻断、取消和 stale 回写门禁；不得重跑主队列。
- `app/api/neigong/analyze/route.ts`：内功问诊独立 JSON API；执行请求限流、严格 Schema 校验和模型任务调用。
- `app/api/analyze/route.ts`：原通用上传、ZIP 解压、全链路资料分流与专项分析接口。
- `lib/prompts.ts`：原市场、竞品、详情页、评价区、买家秀和全链路提示词。
- `lib/excel-export.ts`：原 GFM 结果导出，以及内功问诊工作簿复用的底层构建器。
- `public/产品分析助手使用说明.docx`：网站页头下载的用户说明；由 `tools/update_usage_guide.py` 局部更新。
- `SOURCE_OF_TRUTH.md`：数据协议、规则、入口、导出和文档的权威路径索引。

## 内功问诊约束

- 我方产品固定存在，最多添加 3 个竞品；每个产品有默认排序评价 Excel、时间排序评价 Excel、问大家 Excel、评价页截图 4 个槽位。
- 两个评价 Excel 分别读取第一个工作表，数据角色由上传框决定；`reviewFile` 只为旧版合并工作簿契约与回归测试保留，新 UI 不得使用。评价表头先做 NFKC 与首尾空格规范化，常见业务别名映射到固定字段；额外非分析列只记 `IGNORED_COLUMN` warning，缺少必需字段或同一字段出现多个候选列仍失败关闭。评价和问大家每个来源最多保留 100 条有效行。
- `lib/neigong/catalog.ts` 的评价类型、问题主题和六维目录是固定目录；不得由模型新增、改名或合并。
- 0／1–89／90–99／100 条依次对应 missing／insufficient／provisional／complete。F01 正式诊断要求我方两类评价各不少于 90 条；F02 在默认评价 20 条时保留前 20 明细、90 条时才可正式诊断；F03 要求我方问大家不少于 90 条，竞品逐个按 90 条门槛纳入。
- Excel 在浏览器解析，文件不发送到服务器；XLSX 压缩文件最大 10MB，并在解压前限制中央目录声明的单 entry／总展开大小和压缩比；模型只接收最小逐条文本、压缩后的截图或严格 `SynthesisFacts`。
- 主任务默认并发 4 个批次，运行时上限同为 4，失败自动重试 1 次。服务端模型调用默认 120 秒超时，超时必须主动 abort 并返回可重试的 `MODEL_TIMEOUT`，不得无限停留在运行态；部署环境可用 `NEIGONG_MODEL_TIMEOUT_MS` 调整。多个失败批次可一次并行重试，已成功批次不得重跑；只能排除失败竞品，不能排除我方产品。
- synthesis 只向客户端返回 `id/status/evidenceIds`；标题、诊断正文与 action 由代码确定性生成。retryable synthesis 失败自动重试 1 次，最终失败允许只重跑 synthesis。
- `buildReportData` 必须重算数值聚合，并在 `validateEvidenceGraph` 通过后才能进入 `report` 阶段。校验失败不得显示部分正式报告。
- F02 的低覆盖率与 F03 的主题集中度只能表述为运营关注信号，不得直接写成产品缺陷或已证明的信息缺口；对应 action 只能落到邀评问题、问答与详情页证据优化。
- HTML 和 Excel 必须来自同一份已校验 `ReportData`，不得再次调用模型。网页和 HTML 的中文业务标签以 `lib/neigong/report-presentation.ts` 为准，六维名称以 `lib/neigong/catalog.ts` 为准；内部 evidenceId／rowId 仅放入可展开审计区。Excel 固定 6 个工作表，分析结论以「是否触发关注线／规则代码」表达内部阈值信号，所有不可信文本必须防公式注入。
- 页面状态只存在内存；刷新或关闭页面会丢失本次解析、队列和报告。

## 原模块边界

- 全链路分析仍使用原通用评价逻辑，只编排市场、竞品、详情页、评价区和买家秀 5 个旧专项；不得暗中改接内功问诊。
- 原市场、竞品、详情页、买家秀和全链路结果仍固定为两张 GFM 表格，并保留原文编辑、Markdown 和旧 Excel 导出。
- 多竞品通用分析必须先确认竞品归属；未归类文件不得静默分配。
- Sites 通用上传约 1MB，前端按 850KB 预算提前阻止；内功问诊独立 JSON API 的正文上限为 900KB，不要混用两个限制。
- 上传文件只用于单次请求，不引入账号、数据库、持久化或历史项目管理。
- 提示词、默认产品知识和模型凭据只能留在服务器端或运行时安全配置，禁止发往前端或写入仓库。

## 验证

```bash
node --test tests/neigong-*.test.mjs
node --test tests/*.test.mjs
npm run lint
npm run build
git diff --check
```

修改 `tools/update_usage_guide.py` 后，必须用项目约定的文档运行时重新生成 DOCX，并渲染全部页面做视觉检查；不要把 QA PNG 提交到 Git。
