import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the homepage presents the market-to-competitor workflow", async () => {
  const source = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );

  for (const label of [
    "市场分析",
    "多竞品对比分析",
    "详情页分析",
    "内功问诊",
    "买家秀专项分析",
    "全链路分析",
  ]) {
    assert.match(source, new RegExp(label));
  }

  assert.match(source, /营销文案/);
  assert.match(source, /视觉表达/);
  assert.match(source, /页面框架/);
  assert.match(source, /先看市场，再拆竞品/);
  assert.match(source, /一次上传，横向识别多个竞品/);
  assert.match(source, /待归类资料/);
  assert.match(source, /开始生成多竞品对比方案/);
  assert.match(source, /competitorManifest/);
  assert.doesNotMatch(source, /title: "评价区全盘分析"/);
});
