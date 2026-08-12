import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const componentUrl = (name) => new URL(`../components/neigong/${name}.tsx`, import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function renderProductPackCard() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "neigong-product-pack-card-"));
  const outfile = join(temporaryDirectory, "ProductPackCard.mjs");
  try {
    await build({
      absWorkingDir: projectRoot,
      entryPoints: ["components/neigong/ProductPackCard.tsx"],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      jsx: "automatic",
      logLevel: "silent",
    });
    const { ProductPackCard } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    return renderToStaticMarkup(createElement(ProductPackCard, {
      productId: "self",
      role: "self",
      name: "我方产品",
      files: { product: { productId: "self", role: "self", name: "我方产品" } },
      onChange() {},
    }));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function renderAnalysisProgress(props = {}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "neigong-analysis-progress-"));
  const outfile = join(temporaryDirectory, "AnalysisProgress.mjs");
  try {
    await build({
      absWorkingDir: projectRoot,
      entryPoints: ["components/neigong/AnalysisProgress.tsx"],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      jsx: "automatic",
      logLevel: "silent",
    });
    const { AnalysisProgress } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    return renderToStaticMarkup(createElement(AnalysisProgress, {
      products: [],
      onRetry() {},
      onRetryAll() {},
      onExclude() {},
      ...props,
    }));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test("首页只在 review 分支挂载内功问诊，并隔离新旧分析接口", async () => {
  const [pageSource, neigongSource, clientSource] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(componentUrl("NeigongWorkspace"), "utf8"),
    readFile(new URL("../lib/neigong/client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(pageSource, /title: "内功问诊"/);
  assert.doesNotMatch(pageSource, /title: "评价区全盘分析"/);
  assert.match(
    pageSource,
    /activeModule === "review"\s*&&\s*<NeigongWorkspace\s*\/>/,
  );
  assert.match(
    pageSource,
    /activeModule !== "review"\s*&&\s*\(\s*<>[\s\S]*STEP 2/,
  );
  assert.match(pageSource, /if \(activeModule === "review"\) return;/);
  assert.match(pageSource, /createAsyncSessionGuard/);
  assert.match(
    pageSource,
    /useEffect\(\(\) => \(\) => analysisSession\.current\.cancel\(\), \[\]\)/,
  );
  assert.match(pageSource, /analysisSession\.current\.cancel\(\)/);
  assert.match(pageSource, /signal:\s*run\.signal/);
  assert.match(pageSource, /fetch\("\/api\/analyze"/);
  assert.match(neigongSource, /executeAnalysisTask/);
  assert.doesNotMatch(neigongSource, /"\/api\/analyze"/);
  assert.match(clientSource, /"\/api\/neigong\/analyze"/);
  assert.match(clientSource, /signal/);
  assert.doesNotMatch(clientSource, /"\/api\/analyze"/);
});

test("内功问诊工作区包含上传、预检、分析和报告四阶段", async () => {
  const source = await readFile(componentUrl("NeigongWorkspace"), "utf8");

  assert.match(source, /上传资料/);
  assert.match(source, /完整性检查/);
  assert.match(source, /分批分析/);
  assert.match(source, /问诊看板/);
  assert.match(source, /beforeunload/);
  assert.match(source, /刷新后，当前解析结果和分析进度将丢失/);
});

test("分批分析界面说明主队列最多四路并行", async () => {
  const markup = await renderAnalysisProgress();

  assert.match(markup, /最多 4 个批次并行/);
});

test("多个失败批次空闲时显示并行重试全部按钮", async () => {
  const failedTask = (id) => ({
    id,
    productId: "self",
    task: "review-taxonomy",
    status: "failed",
    attempts: 1,
    error: { code: "MODEL_SCHEMA_INVALID", message: "模型返回格式无效", retryable: false },
  });
  const tasks = { first: failedTask("first"), second: failedTask("second") };
  const markup = await renderAnalysisProgress({
    queue: {
      tasks,
      results: {},
      pending: [],
      running: [],
      completed: [],
      failed: ["first", "second"],
      excluded: [],
    },
  });

  assert.match(markup, /并行重试全部 2 个失败批次/);
});

test("上传区固定我方产品和最多三个竞品，并提供两个独立评价文件槽位", async () => {
  const [workspace, workspaceState, card, renderedCard] = await Promise.all([
    readFile(componentUrl("NeigongWorkspace"), "utf8"),
    readFile(new URL("../lib/neigong/workspace-state.ts", import.meta.url), "utf8"),
    readFile(componentUrl("ProductPackCard"), "utf8"),
    renderProductPackCard(),
  ]);

  assert.match(workspaceState, /我方产品/);
  assert.match(workspaceState, /MAX_COMPETITORS\s*=\s*3/);
  assert.match(workspace, /添加竞品/);
  assert.match(renderedCard, /默认排序评价 Excel/);
  assert.match(renderedCard, /时间排序评价 Excel/);
  assert.doesNotMatch(renderedCard, /包含「默认排序评价」「时间排序评价」/);
  assert.match(card, /问大家 Excel/);
  assert.match(card, /评价页截图/);
  assert.equal((renderedCard.match(/type="file"/g) ?? []).length, 4);
  assert.match(card, /const file = event\.currentTarget\.files\?\.\[0\];\s*event\.currentTarget\.value = "";\s*onSelect\(file\)/s);
  assert.doesNotMatch(workspace, /localStorage|indexedDB|IndexedDB/);
});

test("预检门禁、失败恢复和竞品排除具有明确操作", async () => {
  const [workspace, preflight, progress, orchestrator] = await Promise.all([
    readFile(componentUrl("NeigongWorkspace"), "utf8"),
    readFile(componentUrl("PreflightPanel"), "utf8"),
    readFile(componentUrl("AnalysisProgress"), "utf8"),
    readFile(new URL("../lib/neigong/queue-orchestrator.ts", import.meta.url), "utf8"),
  ]);

  assert.match(preflight, /确认映射后分析/);
  assert.match(preflight, /RANK_ORDER_CONFLICT/);
  assert.match(preflight, /insufficient/);
  assert.match(progress, /重试此批次/);
  assert.match(progress, /排除该竞品并继续/);
  assert.match(progress, /queue\.pending\.length\s*===\s*0\s*&&\s*queue\.running\.length\s*===\s*0/);
  assert.match(progress, /actionsEnabled/);
  assert.match(workspace, /queueOrchestrator\.retry/);
  assert.match(workspace, /queueOrchestrator\.exclude/);
  assert.match(orchestrator, /guard\.cancel\(\);[\s\S]{0,160}type: "exclude-product"/);
  assert.match(orchestrator, /if \(!isCurrent\(run, options\.isDisposed\)\) return undefined;[\s\S]{0,80}options\.onFinish\(queue\)/);
  assert.match(workspace, /role !== "competitor"/);
});

test("主分析完成只进入等待综合报告，真实 ReportData 到达后才显示看板", async () => {
  const [workspace, workspaceState] = await Promise.all([
    readFile(componentUrl("NeigongWorkspace"), "utf8"),
    readFile(new URL("../lib/neigong/workspace-state.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workspaceState, /ready-for-synthesis/);
  assert.match(workspaceState, /case "report-ready"/);
  assert.match(workspace, /主分析完成，等待综合报告/);
  assert.match(workspace, /state\.stage === "report" && state\.report/);
  assert.doesNotMatch(workspace, /所有主分析批次已完成。[\s\S]*报告组件待接入/);
});

test("综合阶段组装严格 facts、执行 synthesis 并只在验证后 dispatch 正式报告", async () => {
  const workspace = await readFile(componentUrl("NeigongWorkspace"), "utf8");

  assert.match(workspace, /buildSynthesisFacts/);
  assert.match(workspace, /buildSynthesisTask/);
  assert.match(workspace, /executeAnalysisTask\(synthesisTask, signal\)/);
  assert.match(workspace, /buildReportData/);
  assert.match(workspace, /type: "report-ready"/);
  assert.match(workspace, /type: "report-failed"/);
  assert.doesNotMatch(workspace, /app\/api\/analyze/);
  assert.match(workspace, /createSynthesisOrchestrator/);
  assert.match(workspace, /重试综合报告/);
  assert.match(workspace, /不会重跑 Excel 主任务/);
  assert.doesNotMatch(workspace, /synthesisRun\.current/);
});

test("报告看板固定渲染六个问题诊断分区且空数据使用中文说明", async () => {
  const dashboard = await readFile(componentUrl("ReportDashboard"), "utf8");
  const sections = [
    "数据完整性与产品对照",
    "评价类型与展示倾向",
    "默认前 20 条六维覆盖",
    "分析结论",
    "落地清单",
  ];

  for (const section of sections) assert.match(dashboard, new RegExp(section));
  assert.match(dashboard, /questionSectionTitle\(report\)/);
  assert.match(dashboard, /数据不足/);
  assert.match(dashboard, /具体缺口/);
  assert.doesNotMatch(dashboard, /优势总结/);
});

test("工作区默认使用 ReportDashboard，不再显示 renderer 待接入占位", async () => {
  const workspace = await readFile(componentUrl("NeigongWorkspace"), "utf8");

  assert.match(workspace, /<ReportDashboard report=\{state\.report\}/);
  assert.doesNotMatch(workspace, /等待报告看板 renderer 接入真实 ReportData/);
});

test("删除竞品会使在途解析 token 失效", async () => {
  const workspace = await readFile(componentUrl("NeigongWorkspace"), "utf8");

  assert.match(workspace, /delete parseTokens\.current\[productId\]/);
  assert.match(workspace, /removeCompetitor/);
});

test("工作区卸载、新分析和 synthesis 都具备取消与 stale dispatch 门禁", async () => {
  const workspace = await readFile(componentUrl("NeigongWorkspace"), "utf8");

  assert.match(workspace, /disposed\.current = true/);
  assert.match(workspace, /queueOrchestrator\.cancel\(\)/);
  assert.match(workspace, /synthesisOrchestrator\.cancel\(\)/);
  assert.match(workspace, /analysisSession\.cancel\(\)/);
  assert.match(workspace, /signal:\s*run\.signal/);
  assert.match(workspace, /executeAnalysisTask\(synthesisTask, signal\)/);
  assert.match(workspace, /!disposed\.current && analysisSession\.isCurrent\(run\)/);
});

test("预检展示 parser 记录的实际文件、工作表和表头映射", async () => {
  const preflight = await readFile(componentUrl("PreflightPanel"), "utf8");

  assert.match(preflight, /parsed\.sourceMappings/);
  assert.match(preflight, /mapping\?\.sheetName/);
  assert.match(preflight, /column\.header/);
  assert.match(preflight, /column\.field/);
  assert.doesNotMatch(preflight, /sheet:\s*"第 1 个工作表"/);
});

test("阶段与队列进度向辅助技术报告当前步骤和全部计数", async () => {
  const [workspace, progress] = await Promise.all([
    readFile(componentUrl("NeigongWorkspace"), "utf8"),
    readFile(componentUrl("AnalysisProgress"), "utf8"),
  ]);

  assert.match(workspace, /aria-current=\{[^}]*"step"/);
  assert.match(progress, /aria-live="polite"[\s\S]{0,300}已完成批次[\s\S]{0,160}失败[\s\S]{0,160}已排除/);
  assert.match(progress, /role=\{queue\?\.failed\.length \? "alert"/);
});

test("内功问诊样式隔离、宽表可滚动并在 760px 切换单列", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.neigong-product-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(css, /\.neigong-table-scroll\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.neigong-[^,{]+:focus-visible/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*\.neigong-product-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
});
