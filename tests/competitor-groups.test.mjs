import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

async function loadModule() {
  return await import("../lib/competitor-groups.ts");
}

test("recognizes competitors from folders and file prefixes", async () => {
  const { inferCompetitorName } = await loadModule();

  assert.equal(
    inferCompetitorName("竞品资料/海飞丝/主图/01.png"),
    "海飞丝",
  );
  assert.equal(
    inferCompetitorName("上传资料/清扬/详情页/02.png"),
    "清扬",
  );
  assert.equal(inferCompetitorName("欧莱雅_营销文案.pdf"), "欧莱雅");
  assert.equal(inferCompetitorName("页面展示主图_01.png"), null);
});

test("groups entries and keeps unresolved files visible", async () => {
  const {
    buildCompetitorManifest,
    buildCompetitorRecognition,
    createCompetitorEntry,
  } = await loadModule();
  const entries = [
    createCompetitorEntry({ path: "竞品资料/海飞丝/主图1.png" }),
    createCompetitorEntry({ path: "竞品资料/清扬/详情页.pdf" }),
    createCompetitorEntry({ path: "页面展示主图_01.png" }),
  ];

  const firstPass = buildCompetitorRecognition(entries);
  assert.deepEqual(
    firstPass.groups.map((group) => group.name),
    ["海飞丝", "清扬"],
  );
  assert.equal(firstPass.unclassified.length, 1);

  const resolved = buildCompetitorRecognition(entries, {
    [entries[2].id]: "海飞丝",
  });
  assert.equal(resolved.unclassified.length, 0);
  assert.equal(resolved.groups[0].entries.length, 2);
  assert.deepEqual(buildCompetitorManifest(resolved).unclassified, []);
});

test("lists ZIP entries and recognizes each competitor before upload", async () => {
  const { buildCompetitorRecognition, listZipCompetitorEntries } =
    await loadModule();
  const archive = zipSync({
    "竞品资料/": new Uint8Array(),
    "竞品资料/海飞丝/": new Uint8Array(),
    "竞品资料/海飞丝/主图/01.png": strToU8("image-a"),
    "竞品资料/清扬/详情页/01.pdf": strToU8("document-b"),
    "竞品资料/页面展示主图_01.png": strToU8("unknown"),
  });

  const entries = listZipCompetitorEntries(archive, "多竞品资料.zip");
  const recognition = buildCompetitorRecognition(entries);

  assert.deepEqual(
    recognition.groups.map((group) => group.name),
    ["海飞丝", "清扬"],
  );
  assert.equal(recognition.unclassified.length, 1);
  assert.equal(recognition.totalEntries, 3);
});
