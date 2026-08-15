# 产品分析助手数据真源

## 速查表

| 要找什么 | 权威文件 |
|---|---|
| 内功问诊页面入口 | `app/page.tsx` |
| 四阶段问诊工作区 | `components/neigong/NeigongWorkspace.tsx` |
| 前后端共享数据协议 | `lib/neigong/types.ts` |
| 评价类型、问题主题和六维目录 | `lib/neigong/catalog.ts` |
| Excel 解析、字段映射和样本计数 | `lib/neigong/excel-parser.ts` |
| XLSX 解压前安全预算 | `lib/neigong/xlsx-archive.ts` |
| 截图预处理和传输限制 | `lib/neigong/image.ts` |
| 分批任务、并发、重试和排除状态 | `lib/neigong/task-runner.ts` |
| 综合报告重试、取消和 stale 门禁 | `lib/neigong/synthesis-orchestrator.ts` |
| 报告构建和确定性聚合 | `lib/neigong/report-builder.ts` |
| readiness 与 finding → evidence 校验 | `lib/neigong/rules.ts` |
| 网页与 HTML 的中文展示口径 | `lib/neigong/report-presentation.ts` |
| 我方产品与客诉知识 | `lib/neigong/server/knowledge.ts` |
| 模型提示词与严格 Schema | `lib/neigong/server/prompts.ts`、`lib/neigong/server/schemas.ts` |
| 独立内功问诊接口 | `app/api/neigong/analyze/route.ts` |
| Nuwa 强制鉴权代理入口 | `app/api/nuwa/analyze/route.ts`、`app/api/nuwa/neigong/analyze/route.ts` |
| 动态知识边界与代理 Token 鉴权 | `lib/server/knowledge-context.ts` |
| Nuwa 网站默认模型运行配置边界 | `lib/server/nuwa-model-runtime.ts` |
| 六表 Excel 导出 | `lib/neigong/excel-export.ts` |
| 六区离线 HTML 导出 | `lib/neigong/html-export.ts` |
| 用户操作说明生成器与成品 | `tools/update_usage_guide.py`、`public/产品分析助手使用说明.docx` |
| 自动化验收 | `tests/neigong-*.test.mjs` |
| 产品设计与实施记录 | `docs/superpowers/specs/2026-08-10-neigong-wenzhen-web-design.md`、`docs/superpowers/plans/2026-08-10-neigong-wenzhen-web.md` |

## 冲突规则

1. 网页运行时只以本项目代码和当前自动化测试为准，不依赖本机 skills 或外部目录。
2. 字段协议冲突时以 `lib/neigong/types.ts` 为准；上传表头别名、规范化与额外列容错以 `lib/neigong/excel-parser.ts` 为准；固定分类冲突时以 `lib/neigong/catalog.ts` 为准；门槛、聚合与证据链冲突时以 `lib/neigong/rules.ts` 和 `lib/neigong/report-builder.ts` 为准；业务展示标签冲突时以 `lib/neigong/report-presentation.ts` 为准；接口输入冲突时以 `lib/neigong/server/schemas.ts` 为准。
3. 设计文档和实施计划记录决策背景，不覆盖已经通过测试的运行代码。用户说明、README 或接手文档与代码不一致时，先修正文档和测试，不在调用点兼容第二套字段或规则。
4. 动态知识只能作为通用分析的非权威补充资料；不得进入内功问诊的固定提示词、严格 Schema、原始行引用与证据链。
