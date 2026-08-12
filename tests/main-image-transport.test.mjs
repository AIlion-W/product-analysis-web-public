import assert from "node:assert/strict";
import test from "node:test";

import * as mainImage from "../lib/main-image.ts";

test("plans ten main images within the production request budget", () => {
  assert.equal(typeof mainImage.createMainImageUploadPlan, "function");

  const files = Array.from({ length: 10 }, (_, index) => ({
    name: `image-${index + 1}.jpg`,
    size: 500 * 1024,
    type: "image/jpeg",
  }));
  const plan = mainImage.createMainImageUploadPlan(files);

  assert.equal(plan.needsCompression, true);
  assert.equal(plan.totalSourceBytes, 5_120_000);
  assert.ok(plan.targetBytesPerFile * files.length <= plan.maxUploadBytes);
  assert.ok(plan.maxUploadBytes < 1024 * 1024);
});

test("compresses every selected image to fit the shared request budget", async () => {
  assert.equal(typeof mainImage.fitMainImageFilesToUploadBudget, "function");

  const files = Array.from({ length: 10 }, (_, index) => ({
    name: `image-${index + 1}.jpg`,
    size: 500 * 1024,
    type: "image/jpeg",
  }));
  const compressed = await mainImage.fitMainImageFilesToUploadBudget(
    files,
    async (file, targetBytes) => ({
      ...file,
      name: file.name.replace(/\.jpg$/, ".webp"),
      size: targetBytes,
      type: "image/webp",
    }),
  );

  assert.equal(compressed.length, 10);
  assert.equal(compressed[0].name, "image-1.webp");
  assert.ok(
    compressed.reduce((sum, file) => sum + file.size, 0) <=
      mainImage.MAX_MAIN_IMAGE_UPLOAD_BYTES,
  );
});
