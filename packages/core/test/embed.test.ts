import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  createEmbedder,
  embeddingFingerprint,
  fingerprintParts,
  LEGACY_EMBEDDING,
} from "../src/embed.ts";
import type { Config } from "../src/config.ts";

const DIM = 4;

type Rec = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
type Reply = { status: number; headers?: Record<string, string>; body: string };
type Fake = {
  url: string;
  requests: Rec[];
  /** 既定の応答を差し替える。undefined を返すと既定の応答 */
  override?: (rec: Rec, n: number) => Reply | undefined;
  mode: { dim: number; reverse: boolean; fixed?: number[] };
  close: () => Promise<void>;
};

function vecOf(s: string, mode: Fake["mode"]): number[] {
  if (mode.fixed) return mode.fixed;
  return Array.from({ length: mode.dim }, (_, i) => s.length + i);
}

async function startFake(): Promise<Fake> {
  const fake: Fake = {
    url: "",
    requests: [],
    mode: { dim: DIM, reverse: false },
    close: () => Promise.resolve(),
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const isOllama = req.url === "/api/embed";
      const isOpenai = req.url === "/embeddings";
      if (req.method !== "POST" || (!isOllama && !isOpenai)) {
        res.writeHead(404).end("not found");
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      const rec: Rec = { method: req.method, url: req.url!, headers: req.headers, body };
      fake.requests.push(rec);
      const o = fake.override?.(rec, fake.requests.length);
      if (o) {
        res.writeHead(o.status, o.headers).end(o.body);
        return;
      }
      const input = body.input as string[];
      const vecs = input.map((s) => vecOf(s, fake.mode));
      if (isOllama) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embeddings: vecs }));
      } else {
        const data = vecs.map((embedding, index) => ({ object: "embedding", index, embedding }));
        if (fake.mode.reverse) data.reverse();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

function cfg(url: string, over: Partial<Config["embedding"]> = {}): Config["embedding"] {
  return {
    url,
    model: "qwen3-embedding:0.6b",
    dimension: DIM,
    batch_size: 2,
    provider: "ollama",
    normalize: false,
    revision: 0,
    extra_body: {},
    query: { prefix: "INST: ", params: {} },
    document: { prefix: "", params: {} },
    ...over,
  };
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

function recSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

const items = ["aa", "bbb", "cccc", "ddddd", "eeeeee"].map((t, i) => ({ hash: `h${i}abcdef`, text: t }));

test("2回目はキャッシュから返る", async () => {
  await withEnv(async (fake, dir) => {
    const e = createEmbedder(cfg(fake.url), dir);
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
  for (const provider of ["ollama", "openai"] as const) {
    await withEnv(async (fake, dir) => {
      const e = createEmbedder(cfg(fake.url, { provider, batch_size: 2 }), dir);
      await e.embedDocuments(items);
      assert.deepEqual(fake.requests.map((r) => (r.body.input as string[]).length), [2, 2, 1]);
    });
  }
});

test("ollama: /api/embed に model・input・extra_body・params を送り、prefix を付ける", async () => {
  await withEnv(async (fake, dir) => {
    const e = createEmbedder(
      cfg(fake.url, {
        extra_body: { truncate: true, keep_alive: "5m" },
        query: { prefix: "Q: ", params: { keep_alive: "1m" } },
        document: { prefix: "D: ", params: { options: { num_ctx: 512 } } },
      }),
      dir,
    );
    const v = await e.embedQuery("hello");
    assert.equal(v.length, DIM);
    const q = fake.requests[0]!;
    assert.equal(q.method, "POST");
    assert.equal(q.url, "/api/embed");
    assert.deepEqual(q.body, {
      model: "qwen3-embedding:0.6b",
      input: ["Q: hello"],
      truncate: true,
      keep_alive: "1m",
    });
    await e.embedDocuments([{ hash: "zzzz", text: "doc" }]);
    const d = fake.requests[1]!;
    assert.deepEqual(d.body, {
      model: "qwen3-embedding:0.6b",
      input: ["D: doc"],
      truncate: true,
      keep_alive: "5m",
      options: { num_ctx: 512 },
    });
  });
});

test("openai: /embeddings に model・input・extra_body・params を送り、prefix を付ける", async () => {
  await withEnv(async (fake, dir) => {
    const e = createEmbedder(
      cfg(fake.url + "/", {
        provider: "openai",
        model: "text-embedding-3-small",
        extra_body: { encoding_format: "float" },
        query: { prefix: "Q: ", params: { input_type: "query" } },
        document: { prefix: "D: ", params: { input_type: "document" } },
      }),
      dir,
    );
    await e.embedQuery("hello");
    assert.equal(fake.requests[0]!.url, "/embeddings");
    assert.deepEqual(fake.requests[0]!.body, {
      model: "text-embedding-3-small",
      input: ["Q: hello"],
      encoding_format: "float",
      input_type: "query",
    });
    await e.embedDocuments([{ hash: "zzzz", text: "doc" }]);
    assert.deepEqual(fake.requests[1]!.body, {
      model: "text-embedding-3-small",
      input: ["D: doc"],
      encoding_format: "float",
      input_type: "document",
    });
  });
});

test("openai: 応答の並びが逆でも index の順に対応する", async () => {
  await withEnv(async (fake, dir) => {
    fake.mode.reverse = true;
    const e = createEmbedder(cfg(fake.url, { provider: "openai", batch_size: 10 }), dir);
    const r = await e.embedDocuments(items);
    assert.deepEqual(
      r.vectors.map((v) => v[0]),
      [2, 3, 4, 5, 6],
    );
  });
});

test("api_key_env があれば Bearer が付き、無ければ付かない", async () => {
  await withEnv(async (fake, dir) => {
    process.env.EMBED_TEST_KEY = "sk-test-secret";
    try {
      const withKey = createEmbedder(cfg(fake.url, { provider: "openai", api_key_env: "EMBED_TEST_KEY" }), dir);
      await withKey.embedQuery("x");
      assert.equal(fake.requests[0]!.headers.authorization, "Bearer sk-test-secret");
      const noKey = createEmbedder(cfg(fake.url, { provider: "openai" }), dir);
      await noKey.embedQuery("x");
      assert.equal(fake.requests[1]!.headers.authorization, undefined);
    } finally {
      delete process.env.EMBED_TEST_KEY;
    }
  });
});

test("normalize: true で L2 正規化し、false ではそのまま。ノルム 0 はそのまま", async () => {
  await withEnv(async (fake, dir) => {
    fake.mode.fixed = [3, 4];
    const on = createEmbedder(cfg(fake.url, { dimension: 2, normalize: true }), dir);
    assert.deepEqual(await on.embedQuery("x"), [0.6, 0.8]);
    const r = await on.embedDocuments([{ hash: "nn11", text: "x" }]);
    assert.deepEqual(r.vectors[0], [0.6, 0.8]);
    // キャッシュには正規化後のベクトルが入っている
    const again = await on.embedDocuments([{ hash: "nn11", text: "x" }]);
    assert.equal(again.cached, 1);
    assert.deepEqual(again.vectors[0], [0.6, 0.8]);

    const off = createEmbedder(cfg(fake.url, { dimension: 2, normalize: false }), dir);
    assert.deepEqual(await off.embedQuery("x"), [3, 4]);

    fake.mode.fixed = [0, 0];
    assert.deepEqual(await on.embedQuery("x"), [0, 0]);
  });
});

test("次元が違う応答で throw し、API キーの値はメッセージに含まれない", async () => {
  await withEnv(async (fake, dir) => {
    process.env.EMBED_TEST_KEY = "sk-test-secret";
    try {
      fake.mode.dim = DIM + 1;
      for (const provider of ["ollama", "openai"] as const) {
        const e = createEmbedder(cfg(fake.url, { provider, api_key_env: "EMBED_TEST_KEY" }), dir);
        const calls = [() => e.embedDocuments([{ hash: "yyyy", text: "x" }]), () => e.embedQuery("x")];
        for (const call of calls) {
          await assert.rejects(call, (err: Error) => {
            assert.match(err.message, /dimension/);
            assert.ok(!err.message.includes("sk-test-secret"));
            return true;
          });
        }
      }
    } finally {
      delete process.env.EMBED_TEST_KEY;
    }
  });
});

test("HTTP エラーのメッセージは provider・status・本文の先頭 300 字で、キーの値を含まない", async () => {
  await withEnv(async (fake, dir) => {
    process.env.EMBED_TEST_KEY = "sk-test-secret";
    try {
      fake.override = () => ({ status: 401, body: "bad key sk-test-secret " + "x".repeat(400) });
      const e = createEmbedder(cfg(fake.url, { provider: "openai", api_key_env: "EMBED_TEST_KEY" }), dir);
      await assert.rejects(e.embedQuery("x"), (err: Error) => {
        assert.match(err.message, /^Embedding \(openai\) failed: HTTP 401 bad key /);
        assert.ok(!err.message.includes("sk-test-secret"));
        assert.ok(err.message.length < 400);
        return true;
      });
    } finally {
      delete process.env.EMBED_TEST_KEY;
    }
  });
});

test("文書の埋め込みで 429 が 1 回返ると sleep を挟んで再試行して成功する", async () => {
  await withEnv(async (fake, dir) => {
    fake.override = (_rec, n) => (n === 1 ? { status: 429, body: "slow down" } : undefined);
    const s = recSleep();
    const e = createEmbedder(cfg(fake.url), dir, { sleep: s.sleep });
    const r = await e.embedDocuments([{ hash: "rr11", text: "abc" }]);
    assert.equal(r.embedded, 1);
    assert.equal(fake.requests.length, 2);
    assert.deepEqual(s.calls, [1000]);
  });
});

test("Retry-After (秒) があればその値だけ待つ", async () => {
  await withEnv(async (fake, dir) => {
    fake.override = (_rec, n) => (n === 1 ? { status: 429, headers: { "retry-after": "2" }, body: "" } : undefined);
    const s = recSleep();
    const e = createEmbedder(cfg(fake.url), dir, { sleep: s.sleep });
    await e.embedDocuments([{ hash: "rr22", text: "abc" }]);
    assert.deepEqual(s.calls, [2000]);
  });
});

test("5xx が 4 回続くと throw する (再試行は最大 3 回、待ちは 1000・2000・4000)", async () => {
  await withEnv(async (fake, dir) => {
    fake.override = () => ({ status: 503, body: "unavailable" });
    const s = recSleep();
    const e = createEmbedder(cfg(fake.url), dir, { sleep: s.sleep });
    await assert.rejects(e.embedDocuments([{ hash: "rr33", text: "abc" }]), /HTTP 503 unavailable/);
    assert.equal(fake.requests.length, 4);
    assert.deepEqual(s.calls, [1000, 2000, 4000]);
  });
});

test("4xx (429 以外) は再試行しない", async () => {
  await withEnv(async (fake, dir) => {
    fake.override = () => ({ status: 400, body: "bad request" });
    const s = recSleep();
    const e = createEmbedder(cfg(fake.url), dir, { sleep: s.sleep });
    await assert.rejects(e.embedDocuments([{ hash: "rr44", text: "abc" }]), /HTTP 400/);
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(s.calls, []);
  });
});

test("rpm: 60 では 2 回目のリクエストの前に約 1000ms の sleep が呼ばれる", async () => {
  await withEnv(async (fake, dir) => {
    const s = recSleep();
    const e = createEmbedder(cfg(fake.url, { rpm: 60, batch_size: 1 }), dir, { sleep: s.sleep });
    await e.embedDocuments([
      { hash: "pp11", text: "a" },
      { hash: "pp22", text: "b" },
    ]);
    assert.equal(fake.requests.length, 2);
    assert.equal(s.calls.length, 1);
    assert.ok(s.calls[0]! > 800 && s.calls[0]! <= 1000, `sleep=${s.calls[0]}`);
  });
});

test("rpm が無ければ待たない", async () => {
  await withEnv(async (fake, dir) => {
    const s = recSleep();
    const e = createEmbedder(cfg(fake.url, { batch_size: 1 }), dir, { sleep: s.sleep });
    await e.embedDocuments(items);
    assert.deepEqual(s.calls, []);
  });
});

test("クエリの埋め込みは 500 で再試行せずに throw する", async () => {
  await withEnv(async (fake, dir) => {
    fake.override = () => ({ status: 500, body: "boom body" });
    const s = recSleep();
    const e = createEmbedder(cfg(fake.url), dir, { sleep: s.sleep });
    await assert.rejects(e.embedQuery("x"), /Embedding \(ollama\) failed: HTTP 500 boom body/);
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(s.calls, []);
  });
});

test("キャッシュは <cacheDir>/<指紋>/<hash先頭2>/<hash>.json に書かれる", async () => {
  await withEnv(async (fake, dir) => {
    const c = cfg(fake.url);
    const e = createEmbedder(c, dir);
    assert.equal(e.fingerprint, embeddingFingerprint(c));
    assert.equal(e.dimension, DIM);
    await e.embedDocuments([{ hash: "abcdef12", text: "abc" }]);
    const { readFile } = await import("node:fs/promises");
    const v = JSON.parse(await readFile(path.join(dir, e.fingerprint, "ab", "abcdef12.json"), "utf8")) as number[];
    assert.deepEqual(v, [3, 4, 5, 6]);
  });
});

test("別の指紋のキャッシュは読まれない", async () => {
  await withEnv(async (fake, dir) => {
    const a = createEmbedder(cfg(fake.url), dir);
    await a.embedDocuments([{ hash: "abcdef12", text: "abc" }]);
    const n = fake.requests.length;
    const b = createEmbedder(cfg(fake.url, { revision: 1 }), dir);
    const r = await b.embedDocuments([{ hash: "abcdef12", text: "abc" }]);
    assert.equal(r.cached, 0);
    assert.equal(fake.requests.length, n + 1);
  });
});

test("LEGACY_EMBEDDING と同じ指紋のときだけ旧パスのキャッシュを読む", async () => {
  await withEnv(async (fake, dir) => {
    const legacyVec = [9, 8, 7, 6];
    const oldFile = path.join(dir, "qwen3_embedding_0_6b", "ab", "abcdef12.json");
    await mkdir(path.dirname(oldFile), { recursive: true });
    await writeFile(oldFile, JSON.stringify(legacyVec));

    // 次元だけ DIM に変えると指紋が変わるので、旧パスは読まれない
    const other = createEmbedder(cfg(fake.url), dir);
    assert.notEqual(other.fingerprint, embeddingFingerprint(LEGACY_EMBEDDING));
    const r0 = await other.embedDocuments([{ hash: "abcdef12", text: "abc" }]);
    assert.equal(r0.cached, 0);

    // 旧キャッシュは 1024 次元のものだけ有効なので、旧パスに 1024 次元のファイルを置く
    const big = Array.from({ length: 1024 }, (_, i) => i);
    const bigFile = path.join(dir, "qwen3_embedding_0_6b", "cd", "cdef1234.json");
    await mkdir(path.dirname(bigFile), { recursive: true });
    await writeFile(bigFile, JSON.stringify(big));
    const legacy = createEmbedder({ ...LEGACY_EMBEDDING, url: fake.url }, dir);
    assert.equal(legacy.fingerprint, embeddingFingerprint(LEGACY_EMBEDDING));
    const r1 = await legacy.embedDocuments([{ hash: "cdef1234", text: "zzz" }]);
    assert.equal(r1.cached, 1);
    assert.equal(r1.embedded, 0);
    assert.deepEqual(r1.vectors[0], big);
    assert.equal(fake.requests.length, 1 /* r0 の 1 件のみ */);
  });
});

test("指紋は url・batch_size・rpm・api_key_env が違っても同じで、model・revision・document.prefix で変わる", () => {
  const base = cfg("http://a");
  const f = embeddingFingerprint(base);
  assert.match(f, /^[0-9a-f]{16}$/);
  assert.equal(embeddingFingerprint(cfg("http://b", { batch_size: 99, rpm: 10, api_key_env: "X" })), f);
  assert.notEqual(embeddingFingerprint(cfg("http://a", { model: "other" })), f);
  assert.notEqual(embeddingFingerprint(cfg("http://a", { revision: 1 })), f);
  assert.notEqual(embeddingFingerprint(cfg("http://a", { document: { prefix: "D: ", params: {} } })), f);
  assert.notEqual(embeddingFingerprint(cfg("http://a", { provider: "openai" })), f);
});

test("fingerprintParts は 8 項目で、キーの順序に依存しない", () => {
  const parts = fingerprintParts(cfg("http://a"));
  assert.deepEqual(Object.keys(parts).sort(), [
    "dimension", "document", "extra_body", "model", "normalize", "provider", "query", "revision",
  ]);
  const a = cfg("http://a", { extra_body: { x: 1, y: { p: 1, q: 2 } } });
  const b = cfg("http://a", { extra_body: { y: { q: 2, p: 1 }, x: 1 } });
  assert.equal(embeddingFingerprint(a), embeddingFingerprint(b));
});
