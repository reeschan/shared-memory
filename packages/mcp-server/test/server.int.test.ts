import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/app.ts";
import { makeTestEnv, type TestEnv } from "../../core/test/int-helpers.ts";

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
