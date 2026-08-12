import assert from "node:assert/strict";
import test from "node:test";

async function loadContract() {
  try {
    return await import("../lib/main-image.ts");
  } catch {
    return null;
  }
}

const image = (name = "main.png") => ({
  name,
  size: 1024,
  type: "image/png",
});

test("requires at least one image from each side", async () => {
  const contract = await loadContract();
  assert.ok(contract, "main-image input contract should exist");

  assert.deepEqual(contract.validateMainImageFiles([], [image()]), {
    ok: false,
    error: "请上传我方主副图。",
  });
  assert.deepEqual(contract.validateMainImageFiles([image()], []), {
    ok: false,
    error: "请上传竞品主副图。",
  });
});

test("accepts one to five supported images per side", async () => {
  const contract = await loadContract();
  assert.ok(contract, "main-image input contract should exist");

  const result = contract.validateMainImageFiles(
    [image("own-1.jpg"), image("own-2.webp")],
    [image("competitor-1.png")],
  );

  assert.deepEqual(result, { ok: true });
});

test("rejects more than five images or non-image files", async () => {
  const contract = await loadContract();
  assert.ok(contract, "main-image input contract should exist");

  assert.deepEqual(
    contract.validateMainImageFiles(
      Array.from({ length: 6 }, (_, index) => image(`own-${index}.png`)),
      [image()],
    ),
    {
      ok: false,
      error: "我方主副图最多上传 5 张。",
    },
  );

  assert.deepEqual(
    contract.validateMainImageFiles(
      [image()],
      [{ name: "brief.pdf", size: 1024, type: "application/pdf" }],
    ),
    {
      ok: false,
      error: "「brief.pdf」不是支持的图片格式，请上传 JPG、PNG 或 WebP。",
    },
  );
});

test("rejects oversized image-analysis payloads before model encoding", async () => {
  const contract = await loadContract();
  assert.ok(contract, "main-image input contract should exist");

  assert.deepEqual(
    contract.validateMainImageFiles(
      [{ ...image("large.png"), size: 12 * 1024 * 1024 + 1 }],
      [image()],
    ),
    {
      ok: false,
      error: "「large.png」超过 12MB，请压缩后重新上传。",
    },
  );

  assert.deepEqual(
    contract.validateMainImageFiles(
      Array.from({ length: 4 }, (_, index) => ({
        ...image(`own-${index}.png`),
        size: 11 * 1024 * 1024,
      })),
      [image()],
    ),
    {
      ok: false,
      error: "双方图片总大小超过 40MB，请压缩后重新上传。",
    },
  );
});
