import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Embedder } from "../src/embed.ts";

test("本物の Ollama で embedQuery が 1024 次元を返す", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "embed-int-"));
  try {
    const e = new Embedder(
      {
        url: "http://127.0.0.1:11434",
        model: "qwen3-embedding:0.6b",
        dimension: 1024,
        batch_size: 16,
        query_instruction:
          "Instruct: Given a question or keywords, retrieve memory notes that answer or relate to it\nQuery: ",
      },
      dir,
    );
    const v = await e.embedQuery("テスト");
    assert.equal(v.length, 1024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
