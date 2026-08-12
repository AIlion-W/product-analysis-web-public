import assert from "node:assert/strict";
import test from "node:test";
import { DIMENSIONS, TAXONOMY, TOPICS } from "../lib/neigong/catalog.ts";
import { OWN_PRODUCT_KNOWLEDGE } from "../lib/neigong/server/knowledge.ts";

test("内功问诊使用固定且互斥的分类目录", () => {
  assert.deepEqual(TAXONOMY.map(({ id }) => id), ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
  assert.deepEqual(TOPICS.map(({ id }) => id), ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"]);
  assert.ok(TOPICS.every(({ includeWhen, excludeWhen }) => includeWhen && excludeWhen));
  assert.deepEqual(DIMENSIONS, ["persona", "scene", "painPoint", "detail", "effect", "delight"]);
});

test("内置产品知识保留待补充边界", () => {
  assert.match(OWN_PRODUCT_KNOWLEDGE, /净含量 \/ 规格：.*待补充/);
  assert.match(OWN_PRODUCT_KNOWLEDGE, /售价：.*待补充/);
  assert.match(OWN_PRODUCT_KNOWLEDGE, /未列具体专利号 \/ 浓度百分比/);
  assert.match(OWN_PRODUCT_KNOWLEDGE, /气味\/香型未明确/);
});
