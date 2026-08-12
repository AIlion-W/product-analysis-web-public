import assert from "node:assert/strict";
import test from "node:test";

import {
  getCompleteSummaryPrompt,
  getSystemPrompt,
  isAnalysisModule,
  isSpecialistModule,
  MODULE_LABELS,
} from "../lib/prompts.ts";

test("routes main-image requests as a specialist analysis module", () => {
  assert.equal(isAnalysisModule("main-image"), true);
  assert.equal(isSpecialistModule("main-image"), true);
  assert.equal(MODULE_LABELS["main-image"], "主副图对比分析");
});

test("routes market and multi-competitor analysis as specialist modules", () => {
  assert.equal(isAnalysisModule("market"), true);
  assert.equal(isSpecialistModule("market"), true);
  assert.equal(MODULE_LABELS.market, "市场分析");

  assert.equal(isAnalysisModule("competitor"), true);
  assert.equal(isSpecialistModule("competitor"), true);
  assert.equal(MODULE_LABELS.competitor, "竞品分析");
});

test("market analysis selects a benchmark competitor before execution", () => {
  const prompt = getSystemPrompt("market");

  assert.match(prompt, /市场格局表/);
  assert.match(prompt, /对标竞品筛选表/);
  assert.match(prompt, /可与我方正面对抗的优先竞品/);
  assert.match(prompt, /不得编造市场份额/);
});

test("competitor analysis supports copy, visual and structure dimensions", () => {
  const prompt = getSystemPrompt("competitor");

  assert.match(prompt, /营销文案/);
  assert.match(prompt, /视觉表达/);
  assert.match(prompt, /页面框架/);
  assert.match(prompt, /多竞品拆解表/);
  assert.match(prompt, /竞品对抗执行表/);
});

test("main-image analysis uses the fixed two-table operator format", () => {
  const prompt = getSystemPrompt("main-image");

  assert.match(prompt, /只输出以下两张表/);
  assert.match(
    prompt,
    /阵营｜图片编号｜主图\/副图｜标题\/可见文案｜风格｜核心差异化｜功效｜成分｜其他\/附加｜问题与机会/,
  );
  assert.match(
    prompt,
    /图序｜主图\/副图｜标题｜风格｜核心差异化｜功效｜成分｜画面要求｜参考竞品图｜待补素材/,
  );
  assert.match(prompt, /不得从图片推断流量、转化率、销量/);
  assert.match(prompt, /表头行、分隔行和数据行缺一不可/);
  assert.doesNotMatch(prompt, /## 四、四象限策略结论/);
});

test("every analysis path is constrained to one main table and one action table", () => {
  for (const moduleKey of ["market", "competitor", "detail", "review", "buyer"]) {
    const prompt = getSystemPrompt(moduleKey);
    assert.match(prompt, /只输出以下两张表/);
    assert.match(prompt, /不要增加第三张表/);
  }

  const completePrompt = getCompleteSummaryPrompt();
  assert.match(completePrompt, /只输出以下两张表/);
  assert.match(completePrompt, /不要增加第三张表/);
  assert.match(completePrompt, /市场分析、竞品分析、详情页、评价区和买家秀/);
});
