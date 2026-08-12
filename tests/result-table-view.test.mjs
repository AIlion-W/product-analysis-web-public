import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("analysis results default to a rendered GFM table view", async () => {
  const source = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /ReactMarkdown/);
  assert.match(source, /remarkGfm/);
  assert.match(source, /useState<ResultView>\("report"\)/);
  assert.match(source, /表格视图/);
  assert.match(source, /编辑原文/);
  assert.match(source, /className="report-table-scroll"/);
});
