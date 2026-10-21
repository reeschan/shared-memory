import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEmbedder } from "../src/embed.ts";
import { loadConfig } from "../src/config.ts";

test("設定の dimension と同じ長さのベクトルを返す", async () => {
  const cfg = loadConfig();
  const dir = await mkdtemp(path.join(tmpdir(), "embed-int-"));
  try {
    const e = createEmbedder(cfg.embedding, dir);
    const v = await e.embedQuery("テスト");
    assert.equal(v.length, cfg.embedding.dimension);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
