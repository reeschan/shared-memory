import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Embedder } from "../src/embed.ts";
import type { Config } from "../src/config.ts";

const DIM = 4;

type Req = { model: string; input: string[] };
type Fake = {
  url: string;
  requests: Req[];
  mode: { status: number; dim: number };
  close: () => Promise<void>;
};

async function startFake(): Promise<Fake> {
  const requests: Req[] = [];
  const mode = { status: 200, dim: DIM };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/api/embed") {
        res.writeHead(404).end("not found");
        return;
      }
      const parsed = JSON.parse(body) as Req;
      requests.push(parsed);
      if (mode.status !== 200) {
        res.writeHead(mode.status).end("boom body");
        return;
      }
      const embeddings = parsed.input.map((s) => Array.from({ length: mode.dim }, (_, i) => s.length + i));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embeddings }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    mode,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function cfg(url: string, batch = 2): Config["embedding"] {
  return { url, model: "qwen3-embedding:0.6b", dimension: DIM, batch_size: batch, query_instruction: "INST: " };
}

async function withEnv(fn: (fake: Fake, dir: string) => Promise<void>): Promise<void> {
  const fake = await startFake();
  const dir = await mkdtemp(path.join(tmpdir(), "embed-test-"));
  try {
    await fn(fake, dir);
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const items = ["aa", "bbb", "cccc", "ddddd", "eeeeee"].map((t, i) => ({ hash: `h${i}abcdef`, text: t }));

test("2回目はキャッシュから返る", async () => {
  await withEnv(async (fake, dir) => {
    const e = new Embedder(cfg(fake.url), dir);
    const r1 = await e.embedDocuments(items);
    assert.equal(r1.embedded, 5);
    assert.equal(r1.cached, 0);
    const n = fake.requests.length;
    const r2 = await e.embedDocuments(items);
    assert.equal(fake.requests.length, n);
    assert.equal(r2.cached, items.length);
    assert.equal(r2.embedded, 0);
    assert.deepEqual(r2.vectors, r1.vectors);
    assert.equal(r1.vectors[1]![0], 3);
  });
});

test("batch_size ごとに分けて送る", async () => {
  await withEnv(async (fake, dir) => {
    const e = new Embedder(cfg(fake.url, 2), dir);
    await e.embedDocuments(items);
    assert.deepEqual(fake.requests.map((r) => r.input.length), [2, 2, 1]);
  });
});

test("embedQuery は先頭に query_instruction を付け、embedDocuments は付けない", async () => {
  await withEnv(async (fake, dir) => {
    const e = new Embedder(cfg(fake.url), dir);
    const v = await e.embedQuery("hello");
    assert.equal(v.length, DIM);
    assert.deepEqual(fake.requests[0]!.input, ["INST: hello"]);
    await e.embedDocuments([{ hash: "zzzz", text: "doc" }]);
    assert.deepEqual(fake.requests[1]!.input, ["doc"]);
    assert.equal(fake.requests[1]!.model, "qwen3-embedding:0.6b");
  });
});

test("次元が違う応答で throw", async () => {
  await withEnv(async (fake, dir) => {
    fake.mode.dim = DIM + 1;
    const e = new Embedder(cfg(fake.url), dir);
    await assert.rejects(() => e.embedDocuments([{ hash: "yyyy", text: "x" }]), /dimension/);
    await assert.rejects(() => e.embedQuery("x"), /dimension/);
  });
});

test("HTTP 500 で本文つきで throw", async () => {
  await withEnv(async (fake, dir) => {
    fake.mode.status = 500;
    const e = new Embedder(cfg(fake.url), dir);
    await assert.rejects(() => e.embedQuery("x"), /500.*boom body/);
  });
});
