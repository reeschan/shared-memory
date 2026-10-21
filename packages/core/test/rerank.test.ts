import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createReranker } from "../src/rerank.ts";
import type { Config } from "../src/config.ts";

type Recorded = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: Record<string, any> };
type Handler = (rec: Recorded, res: http.ServerResponse) => void;

async function withServer(handler: Handler, fn: (url: string, requests: Recorded[]) => Promise<void>): Promise<void> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec: Recorded = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw) };
      requests.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(url, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function cfg(url: string, over: Partial<Config["rerank"]> = {}): Config["rerank"] {
  return {
    enabled: true,
    flavor: "cohere",
    url,
    model: "rerank-m",
    candidates: 20,
    max_docs_per_request: 0,
    doc_max_chars: 2000,
    timeout_ms: 3000,
    extra_body: {},
    ...over,
  };
}

/** 文書の長さが長いほど高い点数を返す偽の応答 */
function scoreByLength(docs: string[]): { index: number; s: number }[] {
  return docs.map((d, index) => ({ index, s: d.length }));
}

const docs = ["a", "bbbb", "cc", "ddd"];

function assertComplete(hits: { index: number; score: number }[], n: number): void {
  assert.deepEqual([...hits.map((h) => h.index)].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1]!.score >= hits[i]!.score);
}

test("enabled: false なら undefined", () => {
  assert.equal(createReranker(cfg("http://127.0.0.1:1", { enabled: false })), undefined);
});

test("documents が空ならリクエストを出さず []", async () => {
  await withServer((_r, res) => json(res, {}), async (url, requests) => {
    const rr = createReranker(cfg(url))!;
    assert.deepEqual(await rr.rerank("q", []), []);
    assert.equal(requests.length, 0);
  });
});

test("cohere: /v1/rerank に top_n と extra_body を送り results を読む", async () => {
  await withServer(
    (rec, res) => json(res, { results: scoreByLength(rec.body.documents).map((x) => ({ index: x.index, relevance_score: x.s })) }),
    async (url, requests) => {
      const rr = createReranker(cfg(url + "/", { extra_body: { foo: 1 } }))!;
      const hits = await rr.rerank("q", docs);
      assert.equal(requests[0]!.method, "POST");
      assert.equal(requests[0]!.url, "/v1/rerank");
      assert.deepEqual(requests[0]!.body, { model: "rerank-m", query: "q", documents: docs, top_n: 4, foo: 1 });
      assert.deepEqual(hits, [
        { index: 1, score: 4 },
        { index: 3, score: 3 },
        { index: 2, score: 2 },
        { index: 0, score: 1 },
      ]);
      assertComplete(hits, 4);
    },
  );
});

test("voyage: /v1/rerank に top_k を送り data を読む", async () => {
  await withServer(
    (rec, res) => json(res, { data: scoreByLength(rec.body.documents).map((x) => ({ index: x.index, relevance_score: x.s })) }),
    async (url, requests) => {
      const rr = createReranker(cfg(url, { flavor: "voyage", extra_body: { truncation: true } }))!;
      const hits = await rr.rerank("q", docs);
      assert.equal(requests[0]!.url, "/v1/rerank");
      assert.deepEqual(requests[0]!.body, { model: "rerank-m", query: "q", documents: docs, top_k: 4, truncation: true });
      assert.deepEqual(hits.map((h) => h.index), [1, 3, 2, 0]);
      assertComplete(hits, 4);
    },
  );
});

test("tei: /rerank に texts を送り、最上位の配列の score を読む", async () => {
  await withServer(
    (rec, res) => json(res, scoreByLength(rec.body.texts).map((x) => ({ index: x.index, score: x.s }))),
    async (url, requests) => {
      const rr = createReranker(cfg(url, { flavor: "tei", extra_body: { raw_scores: false } }))!;
      const hits = await rr.rerank("q", docs);
      assert.equal(requests[0]!.url, "/rerank");
      assert.deepEqual(requests[0]!.body, { query: "q", texts: docs, raw_scores: false });
      assert.deepEqual(hits.map((h) => h.index), [1, 3, 2, 0]);
      assertComplete(hits, 4);
    },
  );
});

test("tei: 既定の上限は 32 件ごと", async () => {
  await withServer(
    (rec, res) => json(res, rec.body.texts.map((t: string, index: number) => ({ index, score: t.length }))),
    async (url, requests) => {
      const rr = createReranker(cfg(url, { flavor: "tei" }))!;
      const many = Array.from({ length: 40 }, (_, i) => "x".repeat(i + 1));
      const hits = await rr.rerank("q", many);
      assert.deepEqual(requests.map((r) => r.body.texts.length), [32, 8]);
      assertComplete(hits, 40);
      assert.equal(hits[0]!.index, 39);
    },
  );
});

test("sarashina: /rerank に送り data[0].result の document_id と relevance_score を読む", async () => {
  await withServer(
    (rec, res) =>
      json(res, {
        data: [{ result: scoreByLength(rec.body.documents).map((x) => ({ document_id: x.index, relevance_score: x.s })) }],
      }),
    async (url, requests) => {
      const rr = createReranker(cfg(url, { flavor: "sarashina", extra_body: { top_n: 99 } }))!;
      const hits = await rr.rerank("q", docs);
      assert.equal(requests[0]!.url, "/rerank");
      assert.deepEqual(requests[0]!.body, { model: "rerank-m", query: "q", documents: docs, top_n: 99 });
      assert.deepEqual(hits.map((h) => h.index), [1, 3, 2, 0]);
      assertComplete(hits, 4);
    },
  );
});

test("sarashina: relevance_score が無ければ score を読む", async () => {
  await withServer(
    (rec, res) => json(res, { data: [{ result: scoreByLength(rec.body.documents).map((x) => ({ document_id: x.index, score: x.s })) }] }),
    async (url) => {
      const hits = await createReranker(cfg(url, { flavor: "sarashina" }))!.rerank("q", docs);
      assert.deepEqual(hits.map((h) => h.index), [1, 3, 2, 0]);
    },
  );
});

test("sarashina: 点数が無ければ返ってきた順に高い点数を割り当てる", async () => {
  await withServer(
    (_rec, res) => json(res, { data: [{ result: [{ document_id: 2 }, { document_id: 0 }, { document_id: 3 }, { document_id: 1 }] }] }),
    async (url) => {
      const hits = await createReranker(cfg(url, { flavor: "sarashina" }))!.rerank("q", docs);
      assert.deepEqual(hits.map((h) => h.index), [2, 0, 3, 1]);
      assertComplete(hits, 4);
    },
  );
});

function sarashinaEcho(rec: Recorded, res: http.ServerResponse): void {
  json(res, { data: [{ result: rec.body.documents.map((d: string, i: number) => ({ document_id: i, relevance_score: d.length })) }] });
}

test("sarashina: 25 件は 20 件と 5 件に分かれ、2 回目の index に 20 が足される", async () => {
  await withServer(sarashinaEcho, async (url, requests) => {
    const rr = createReranker(cfg(url, { flavor: "sarashina" }))!;
    const many = Array.from({ length: 25 }, (_, i) => "x".repeat(i + 1));
    const hits = await rr.rerank("q", many);
    assert.deepEqual(requests.map((r) => r.body.documents.length), [20, 5]);
    assertComplete(hits, 25);
    assert.equal(hits[0]!.index, 24);
    assert.equal(hits[0]!.score, 25);
  });
});

test("max_docs_per_request: 10 なら 10 件ずつに分かれる", async () => {
  await withServer(sarashinaEcho, async (url, requests) => {
    const rr = createReranker(cfg(url, { flavor: "sarashina", max_docs_per_request: 10 }))!;
    const many = Array.from({ length: 25 }, (_, i) => `d${i}`);
    const hits = await rr.rerank("q", many);
    assert.deepEqual(requests.map((r) => r.body.documents.length), [10, 10, 5]);
    assertComplete(hits, 25);
  });
});

test("path を設定すると既定のパスの代わりに使われる", async () => {
  await withServer(
    (rec, res) => json(res, { results: rec.body.documents.map((_: string, index: number) => ({ index, relevance_score: 1 })) }),
    async (url, requests) => {
      await createReranker(cfg(url, { path: "/custom/r" }))!.rerank("q", docs);
      assert.equal(requests[0]!.url, "/custom/r");
    },
  );
});

test("doc_max_chars でコードポイント単位に切って送る", async () => {
  await withServer(
    (rec, res) => json(res, { results: rec.body.documents.map((_: string, index: number) => ({ index, relevance_score: 1 })) }),
    async (url, requests) => {
      await createReranker(cfg(url, { doc_max_chars: 5 }))!.rerank("q", ["abcdefghij", "😀😀😀😀😀😀😀", "ab"]);
      assert.deepEqual(requests[0]!.body.documents, ["abcde", "😀😀😀😀😀", "ab"]);
    },
  );
});

test("api_key_env があれば authorization: Bearer が付き、なければ付かない", async () => {
  const name = "RERANK_TEST_KEY_023";
  await withServer(
    (rec, res) => json(res, { results: rec.body.documents.map((_: string, index: number) => ({ index, relevance_score: 1 })) }),
    async (url, requests) => {
      process.env[name] = "secret-value-123";
      try {
        await createReranker(cfg(url, { api_key_env: name }))!.rerank("q", docs);
      } finally {
        delete process.env[name];
      }
      assert.equal(requests[0]!.headers.authorization, "Bearer secret-value-123");
      await createReranker(cfg(url))!.rerank("q", docs);
      assert.equal(requests[1]!.headers.authorization, undefined);
    },
  );
});

test("応答が timeout_ms より遅いと例外", async () => {
  await withServer(
    (_rec, res) => {
      setTimeout(() => json(res, { results: [] }), 1000).unref();
    },
    async (url) => {
      await assert.rejects(() => createReranker(cfg(url, { timeout_ms: 100 }))!.rerank("q", docs));
    },
  );
});

test("HTTP 500 で例外。メッセージに状態と本文があり、API キーの値は含まれない", async () => {
  const name = "RERANK_TEST_KEY_023B";
  await withServer(
    (_rec, res) => {
      res.writeHead(500).end("boom body secret-value-456 " + "z".repeat(400));
    },
    async (url) => {
      process.env[name] = "secret-value-456";
      try {
        await assert.rejects(
          () => createReranker(cfg(url, { api_key_env: name }))!.rerank("q", docs),
          (e: Error) => {
            assert.match(e.message, /^Rerank \(cohere\) failed: HTTP 500 boom body/);
            assert.ok(!e.message.includes("secret-value-456"));
            assert.ok(e.message.length < 400);
            return true;
          },
        );
      } finally {
        delete process.env[name];
      }
    },
  );
});

test("形の不正な応答で例外", async () => {
  const bodies: [Config["rerank"]["flavor"], unknown][] = [
    ["cohere", { nope: 1 }],
    ["cohere", { results: [{ index: 99, relevance_score: 1 }] }],
    ["cohere", { results: [{ index: 0 }] }],
    ["voyage", { results: [] }],
    ["tei", { data: [] }],
    ["sarashina", { data: [] }],
    ["sarashina", { data: [{ result: [{ document_id: 100, relevance_score: 1 }] }] }],
  ];
  for (const [flavor, body] of bodies) {
    await withServer(
      (_rec, res) => json(res, body),
      async (url) => {
        await assert.rejects(() => createReranker(cfg(url, { flavor }))!.rerank("q", docs), /^Error: Rerank \(\w+\): unexpected response$/);
      },
    );
  }
  await withServer(
    (_rec, res) => {
      res.writeHead(200).end("not json");
    },
    async (url) => {
      await assert.rejects(() => createReranker(cfg(url))!.rerank("q", docs), /unexpected response/);
    },
  );
});
