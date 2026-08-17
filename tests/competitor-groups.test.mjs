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

// Windows 简体中文 built-in compression stores entry names in GBK and leaves the
// UTF-8 general-purpose flag clear. Decoding those as UTF-8 produced replacement
// characters, so every competitor folder collapsed into an unreadable group name.
const GBK_BYTES = {
  竞: [0xbe, 0xba], 品: [0xc6, 0xb7], 资: [0xd7, 0xca], 料: [0xc1, 0xcf],
  海: [0xba, 0xa3], 飞: [0xb7, 0xc9], 丝: [0xcb, 0xbf],
  清: [0xc7, 0xe5], 扬: [0xd1, 0xef],
  主: [0xd6, 0xf7], 图: [0xcd, 0xbc],
};

function gbkEncode(value) {
  const bytes = [];
  for (const character of value) {
    const mapped = GBK_BYTES[character];
    if (mapped) bytes.push(...mapped);
    else if (character.codePointAt(0) < 0x80) bytes.push(character.codePointAt(0));
    else throw new Error(`test GBK table is missing ${character}`);
  }
  return Uint8Array.from(bytes);
}

function buildZipWithNames(names, { utf8Flag }) {
  const encodeName = (name) => (utf8Flag ? new TextEncoder().encode(name) : gbkEncode(name));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const name of names) {
    const nameBytes = encodeName(name);
    const data = strToU8("x");
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(6, utf8Flag ? 0x800 : 0, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(8, utf8Flag ? 0x800 : 0, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, names.length, true);
  endView.setUint16(10, names.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = [...locals, ...centrals, end];
  const archive = new Uint8Array(total.reduce((size, part) => size + part.length, 0));
  let cursor = 0;
  for (const part of total) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}

test("GBK 字节表与 TextDecoder 一致，保证下面的 ZIP 夹具可信", () => {
  const decoder = new TextDecoder("gbk");
  for (const [character, bytes] of Object.entries(GBK_BYTES)) {
    assert.equal(decoder.decode(Uint8Array.from(bytes)), character);
  }
});

test("Windows 简体中文 ZIP（GBK 文件名、未置 UTF-8 标志）仍能识别竞品分组", async () => {
  const { buildCompetitorRecognition, listZipCompetitorEntries } = await loadModule();
  const names = ["竞品资料/海飞丝/主图1.png", "竞品资料/清扬/主图1.png"];

  for (const utf8Flag of [true, false]) {
    const archive = buildZipWithNames(names, { utf8Flag });
    const entries = listZipCompetitorEntries(archive, "多竞品资料.zip");

    assert.deepEqual(entries.map((entry) => entry.path), names);
    assert.deepEqual(
      buildCompetitorRecognition(entries).groups.map((group) => group.name),
      ["海飞丝", "清扬"],
    );
  }
});
