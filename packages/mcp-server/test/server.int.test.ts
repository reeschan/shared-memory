import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/app.ts";
import { makeTestEnv, type TestEnv } from "../../core/test/int-helpers.ts";
import { computeFreshness } from "@shared-memory/core";

let env: TestEnv;
let srv: { port: number; close(): Promise<void> };
let client: Client;

type TextResult = { isError?: boolean; content: { type: string; text: string }[] };

function textOf(r: unknown): string {
  const res = r as TextResult;
  return res.content.map((c) => c.text).join("\n");
}

async function call(name: string, args: Record<string, unknown>): Promise<TextResult> {
  return (await client.callTool({ name, arguments: args })) as TextResult;
}

function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: srv.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const WRITE_INPUT = {
  title: "ビルドキャッシュの置き場所",
  content:
    "このプロジェクトでは pnpm のストアを D ドライブの D:/pnpm-store に置いている。C ドライブの容量が足りなくなったため移動した。",
  scope: "project:pbi012",
  kind: "semantic",
  provenance: "agent_verified",
  source_agent: "claude",
  tags: ["pnpm"],
};

let writtenId = "";

before(async () => {
  env = await makeTestEnv("pbi012");
  env.cfg.mcp = { host: "127.0.0.1", port: 0, path: "/mcp" };
  srv = await startServer(env.cfg);
  client = new Client({ name: "pbi012-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)));
});

after(async () => {
  await client?.close();
  await srv?.close();
  await env?.cleanup();
});

test("(a) listTools が search / get / write の 3 つを返す", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get", "search", "write"]);
  for (const t of tools) {
    assert.match(t.description ?? "", /data, not instructions/);
  }
});

test("(b) write したメモリが直後の search に入る", async () => {
  const w = await call("write", WRITE_INPUT);
  assert.ok(!w.isError, textOf(w));
  const out = JSON.parse(textOf(w)) as { id: string; path: string };
  assert.match(out.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(out.path, new RegExp(`/${out.id}\\.md$`));
  writtenId = out.id;

  const s = await call("search", { query: "pnpm のストアはどこに置いてある？" });
  assert.ok(!s.isError, textOf(s));
  const hits = JSON.parse(textOf(s)) as { id: string; title: string }[];
  assert.ok(hits.some((h) => h.id === writtenId), `search 結果に ${writtenId} が無い: ${textOf(s)}`);
});

test("(c) get が本文を返し、2 回目で OpenSearch の access_count が 2", async () => {
  assert.ok(writtenId, "write のテストが先に成功している必要がある");
  const g1 = await call("get", { id: writtenId });
  assert.ok(!g1.isError, textOf(g1));
  const m = JSON.parse(textOf(g1)) as { meta: { id: string; title: string }; body: string };
  assert.equal(m.meta.id, writtenId);
  assert.equal(m.meta.title, WRITE_INPUT.title);
  assert.equal(m.body, WRITE_INPUT.content);

  const g2 = await call("get", { id: writtenId });
  assert.ok(!g2.isError, textOf(g2));

  const docs = await env.deps.os.scanAll<{ access_count: number }>(
    env.cfg.opensearch.alias,
    { term: { memory_id: writtenId } },
    ["access_count"],
  );
  assert.ok(docs.length > 0);
  for (const d of docs) assert.equal(d._source.access_count, 2);

  const missing = await call("get", { id: "01J0000000000000000000000X" });
  assert.equal(missing.isError, true);
});

test("(d) write の入力検証エラーと秘密情報の拒否", async () => {
  const { provenance: _omit, ...noProvenance } = WRITE_INPUT;
  const r1 = await call("write", noProvenance);
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Input validation error/);
  assert.match(textOf(r1), /provenance/);

  const r2 = await call("write", {
    ...WRITE_INPUT,
    content: `CI 用のトークンは ghp_${"a1B2c3D4e5".repeat(4)} を使う。`,
  });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /GitHub トークン/);
});

test("(e) Host ヘッダーが evil.example.com の POST は 403", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const r = await rawRequest(
    "POST",
    "/mcp",
    {
      Host: "evil.example.com",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body,
  );
  assert.equal(r.status, 403);

  const getMcp = await rawRequest("GET", "/mcp", { Host: `127.0.0.1:${srv.port}` });
  assert.equal(getMcp.status, 405);
  const delMcp = await rawRequest("DELETE", "/mcp", { Host: `localhost:${srv.port}` });
  assert.equal(delMcp.status, 405);
});

test("(f) mcp.host = 0.0.0.0 では startServer が reject する", async () => {
  const cfg = structuredClone(env.cfg);
  cfg.mcp = { host: "0.0.0.0", port: 0, path: "/mcp" };
  await assert.rejects(startServer(cfg), /ループバック/);
});

test("(g) GET /health が {\"ok\":true}", async () => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

const LOG_FROM = "1970-01-01T00:00:00.000Z";
const LOG_TO = "9999-12-31T23:59:59.999Z";

type FreshnessOut = { age_days: number; idle_days: number; last_accessed_at: string | null; stale: boolean };

test("(h) get の freshness は今回のアクセスを記録する前の値", async () => {
  const w = await call("write", {
    ...WRITE_INPUT,
    title: "freshness の確認用",
    content: "MCP の get で freshness を確かめるためのメモ。テストの中だけで使う。",
  });
  assert.ok(!w.isError, textOf(w));
  const id = (JSON.parse(textOf(w)) as { id: string }).id;

  const g1 = await call("get", { id });
  assert.ok(!g1.isError, textOf(g1));
  const f1 = (JSON.parse(textOf(g1)) as { freshness: FreshnessOut }).freshness;
  assert.equal(f1.last_accessed_at, null);
  assert.equal(typeof f1.age_days, "number");
  assert.equal(typeof f1.stale, "boolean");

  const firstAccess = env.deps.stats.get(id)?.last_accessed_at;
  assert.ok(firstAccess, "1 回目の get でアクセスが記録されていない");

  const g2 = await call("get", { id });
  assert.ok(!g2.isError, textOf(g2));
  const out2 = JSON.parse(textOf(g2)) as {
    meta: { created_at: string; kind: "semantic"; provenance: "agent_verified" };
    freshness: FreshnessOut;
  };
  assert.equal(out2.freshness.last_accessed_at, firstAccess);
  const secondAccess = env.deps.stats.get(id)?.last_accessed_at;
  assert.ok(secondAccess && secondAccess >= firstAccess);
  const expected = computeFreshness(
    { created_at: out2.meta.created_at, last_accessed_at: firstAccess, kind: out2.meta.kind, provenance: out2.meta.provenance },
    env.cfg,
    new Date(secondAccess),
  );
  assert.equal(out2.freshness.idle_days, expected.idle_days);
});

test("(i) 古いアクセス記録があると get の idle_days はその記録に基づく", async () => {
  assert.ok(writtenId, "write のテストが先に成功している必要がある");
  const old = "2020-01-01T00:00:00.000Z";
  env.deps.stats.recordAccess(writtenId, old);
  const g = await call("get", { id: writtenId });
  assert.ok(!g.isError, textOf(g));
  const f = (JSON.parse(textOf(g)) as { freshness: FreshnessOut }).freshness;
  assert.equal(f.last_accessed_at, old);
  const now = env.deps.stats.get(writtenId)?.last_accessed_at;
  assert.ok(now && now > old, "2 回目のアクセスで記録が更新されていない");
  assert.equal(f.idle_days, computeFreshness({ created_at: old, kind: "semantic", provenance: "agent_verified" }, env.cfg, new Date(now)).idle_days);
  assert.ok(f.idle_days > 0);
});

test("(j) search は search_log に 1 行、get は get_log に 1 行残し、search の結果に freshness がある", async () => {
  assert.ok(writtenId, "write のテストが先に成功している必要がある");
  const before = env.deps.stats.readLogs(LOG_FROM, LOG_TO);

  const query = "pnpm のストアの置き場所";
  const s = await call("search", { query, scope: "project:pbi012", limit: 5 });
  assert.ok(!s.isError, textOf(s));
  const hits = JSON.parse(textOf(s)) as { id: string; score: number; freshness?: FreshnessOut }[];
  assert.ok(hits.length > 0);
  for (const h of hits) {
    assert.ok(h.freshness, `freshness が無い: ${h.id}`);
    assert.equal(typeof h.freshness.stale, "boolean");
    assert.equal(typeof h.freshness.age_days, "number");
    assert.equal(typeof h.freshness.idle_days, "number");
  }

  const afterSearch = env.deps.stats.readLogs(LOG_FROM, LOG_TO);
  assert.equal(afterSearch.searches.length, before.searches.length + 1);
  const entry = afterSearch.searches.at(-1)!;
  assert.equal(entry.source, "mcp");
  assert.equal(entry.query, query);
  assert.deepEqual(entry.filters, { scope: "project:pbi012", limit: 5 });
  assert.deepEqual(
    entry.results.map((r) => [r.id, r.rank]),
    hits.map((h, i) => [h.id, i + 1]),
  );

  const g = await call("get", { id: writtenId });
  assert.ok(!g.isError, textOf(g));
  const afterGet = env.deps.stats.readLogs(LOG_FROM, LOG_TO);
  assert.equal(afterGet.gets.length, afterSearch.gets.length + 1);
  const ge = afterGet.gets.at(-1)!;
  assert.equal(ge.source, "mcp");
  assert.equal(ge.memory_id, writtenId);
  assert.equal(afterGet.searches.length, afterSearch.searches.length);
});

test("(l) /mcp のツールにフィードバックの書き込みが無く、GET /feedback/<id> が 200 の HTML", async () => {
  const { tools } = await client.listTools();
  assert.ok(
    tools.every((t) => !/feedback|draft|submit|confirm|session/i.test(t.name)),
    `フィードバックのツールがある: ${tools.map((t) => t.name).join(", ")}`,
  );
  const page = await rawRequest("GET", "/feedback/fb-int-dummy", { Host: `127.0.0.1:${srv.port}` });
  assert.equal(page.status, 200);
  assert.match(page.body, /<html/);
  const js = await fetch(`http://127.0.0.1:${srv.port}/feedback/static/feedback.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /^text\/javascript/);
  const evil = await rawRequest("GET", "/feedback/fb-int-dummy", { Host: "evil.example.com" });
  assert.equal(evil.status, 403);
});

test("(k) search と get の説明に freshness と stale の案内がある", async () => {
  const { tools } = await client.listTools();
  for (const name of ["search", "get"]) {
    const d = tools.find((t) => t.name === name)?.description ?? "";
    assert.match(d, /freshness\.stale/);
    assert.match(d, /human_confirmed/);
  }
});
