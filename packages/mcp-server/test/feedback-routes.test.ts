import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendHistory,
  createFeedbackSession,
  readEvalSet,
  signTest,
  writeEvalSet,
  type EvalQuestion,
  type EvalRun,
  type SearchResult,
  type SessionSearcher,
} from "@shared-memory/core";
import { BODY_MAX_CHARS, handleFeedback } from "../src/feedback-routes.ts";

// テストのデータはすべて作ったダミー (本物の記憶の ID・本文は使わない)。OpenSearch も stats の SQLite も使わない

const NOW = new Date("2026-10-21T00:00:00.000Z");
const TOKEN = "dummy-token-123";
const STATIC_DIR = fileURLToPath(new URL("../static/", import.meta.url));

let dir: string;
let server: Server;
let port: number;
let sid1: string;
let sid2: string;
let qid1: string;

function res(id: string): SearchResult {
  return {
    id,
    title: `ダミー ${id}`,
    excerpt: `ダミーの抜粋 ${id}`,
    score: 1,
    scope: "global",
    kind: "semantic",
    provenance: "agent_verified",
    created_at: "2026-01-01T00:00:00.000Z",
    freshness: { age_days: 3, idle_days: 3, last_accessed_at: null, stale: false },
  };
}

const prod: SessionSearcher = async () => [res("m-a1"), res("m-a2"), res("m-c")];
const prim: SessionSearcher = async () => [res("m-b1"), res("m-c"), res("m-b2")];

function run(i: number): EvalRun {
  const m = { ndcg10: 0.5, recall5: 0.5, mrr10: 0.5 };
  return {
    at: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    n: i,
    production: m,
    primary: m,
    diff: { mean: 0, lo: -0.1, hi: 0.1, win: 0, lose: 0, tie: 0 },
    guard: { worse: false, alert: false, reason: null },
    interleave: { wins: 0, losses: 0, ties: 0, p: 1 },
    freshness: { n: 0, production_ndcg10: null, primary_ndcg10: null, newer_above_rate: null },
    created_dist: { weeks: [`2026-W${String(i + 1).padStart(2, "0")}`], corpus: [i], gold: [0] },
    review: {
      span_days: 0,
      span_ok: false,
      human_n: 0,
      human_ok: false,
      fresh_n: 0,
      fresh_ok: false,
      signal: false,
      ready: false,
    },
  };
}

async function makeSession(id: string): Promise<string> {
  const s = await createFeedbackSession({
    dir,
    questions: [],
    logs: [{ at: "2026-10-20T00:00:00.000Z", source: "mcp", query: "ダミーの問い", filters: {}, results: [] }],
    production: prod,
    primary: prim,
    supersededAt: new Map(),
    now: NOW,
    seed: 7,
    newId: () => id,
    newToken: () => TOKEN,
  });
  qid1 = s.items[0]!.qid;
  return s.id;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "sm-fbr-"));
  sid1 = await makeSession("fb-route-1");
  sid2 = await makeSession("fb-route-2");
  const qs: EvalQuestion[] = [
    { qid: "q-1", query: "ダミー 1", asked_at: "2026-09-01T00:00:00.000Z", kind: "synthetic", labels: [] },
    {
      qid: "q-2",
      query: "ダミー 2",
      asked_at: "2026-09-01T00:00:00.000Z",
      kind: "real",
      labels: [{ source: "human", labeled_at: "2026-09-02T00:00:00.000Z", session_id: "fb-old", relevant: { "m-x": 2 } }],
    },
  ];
  await writeEvalSet(dir, qs);
  for (let i = 0; i < 13; i++) await appendHistory(dir, run(i));

  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await handleFeedback(req, res, url, { dir, staticDir: STATIC_DIR })) return;
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("fallthrough");
    })().catch((e: unknown) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

type Resp = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** パスを正規化せずにそのまま送る */
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function postJson(path: string, value: unknown, contentType = "application/json"): Promise<Resp> {
  return raw("POST", path, { "Content-Type": contentType }, typeof value === "string" ? value : JSON.stringify(value));
}

test("handleFeedback は StatsStore を受け取らない (req, res, url, { dir, staticDir }) の形", () => {
  assert.equal(handleFeedback.length, 4);
});

test("フィードバックの道でなければ何もせず false", async () => {
  const r = await raw("GET", "/health");
  assert.equal(r.status, 404);
  assert.equal(r.body, "fallthrough");
  const r2 = await raw("GET", "/feedback");
  assert.equal(r2.body, "fallthrough");
});

test("GET /feedback/<id> が HTML (CSP と no-store 付き)", async () => {
  const r = await raw("GET", `/feedback/${sid1}`);
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /^text\/html; charset=utf-8/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(String(r.headers["content-security-policy"]), /default-src 'self'.*frame-ancestors 'none'/);
  assert.match(r.body, /<html/);
});

test("GET /feedback/static/feedback.js が JS、feedback.css が CSS", async () => {
  const js = await raw("GET", "/feedback/static/feedback.js");
  assert.equal(js.status, 200);
  assert.match(String(js.headers["content-type"]), /^text\/javascript; charset=utf-8/);
  assert.equal(js.headers["cache-control"], "no-store");
  const css = await raw("GET", "/feedback/static/feedback.css");
  assert.equal(css.status, 200);
  assert.match(String(css.headers["content-type"]), /^text\/css; charset=utf-8/);
});

test("静的ファイルの許可リストに無い名前や .. を含む道は 404", async () => {
  for (const p of [
    "/feedback/static/other.js",
    "/feedback/static/..%2Fsrc%2Fapp.ts",
    "/feedback/static/..%2F..%2Fpackage.json",
    "/feedback/static/%2E%2E",
    "/feedback/static/a/../feedback.js/x",
    "/feedback/static/",
    "/feedback/static",
    "/feedback/..",
    "/feedback/%2E%2E/data",
    `/feedback/${sid1}/other`,
    `/feedback/${sid1}/data/x`,
  ]) {
    const r = await raw("GET", p);
    assert.ok(r.status === 404, `${p} が ${r.status}`);
  }
});

test("GET data は合言葉が合えば 200 で token と teams を含まず、dashboard がある", async () => {
  const r = await raw("GET", `/feedback/${sid1}/data?t=${TOKEN}`);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(!r.body.includes(TOKEN));
  const out = JSON.parse(r.body) as {
    session: Record<string, unknown> & { items: Record<string, unknown>[] };
    dashboard: {
      history: EvalRun[];
      interleave: { wins: number; losses: number; ties: number; sessions: number; p: number };
      created_dist: EvalRun["created_dist"] | null;
      eval_set: { questions: number; human: number };
    };
  };
  assert.equal(out.session.id, sid1);
  assert.ok(!("token" in out.session));
  assert.ok(out.session.items.length > 0);
  for (const it of out.session.items) {
    assert.ok(!("teams" in it));
    assert.ok(Array.isArray(it.cards));
  }
  const d = out.dashboard;
  assert.equal(d.history.length, 12);
  assert.deepEqual(
    d.history.map((h) => h.n),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.deepEqual(d.created_dist, run(12).created_dist);
  assert.deepEqual(d.interleave, { wins: 0, losses: 0, ties: 0, sessions: 0, p: 1 });
  assert.deepEqual(d.eval_set, { questions: 2, human: 1 });
});

test("GET data は合言葉が違えば 403、無ければ 403、無いセッションは 404", async () => {
  assert.equal((await raw("GET", `/feedback/${sid1}/data?t=wrong`)).status, 403);
  assert.equal((await raw("GET", `/feedback/${sid1}/data`)).status, 403);
  assert.equal((await raw("GET", `/feedback/fb-missing/data?t=${TOKEN}`)).status, 404);
});

test("POST draft と submit は Content-Type が application/json でなければ 415、JSON が壊れていれば 400", async () => {
  for (const op of ["draft", "submit"]) {
    const path = `/feedback/${sid2}/${op}?t=${TOKEN}`;
    assert.equal((await postJson(path, { draft: {} }, "text/plain")).status, 415);
    assert.equal((await raw("POST", path, {}, JSON.stringify({ draft: {} }))).status, 415);
    assert.equal((await postJson(path, "{not json")).status, 400);
    assert.equal((await postJson(path, "[1,2]")).status, 400);
    assert.equal((await postJson(path, { draft: [1] })).status, 400);
    assert.equal((await raw("GET", path)).status, 405);
  }
  assert.equal((await postJson(`/feedback/${sid2}/draft?t=${TOKEN}`, {})).status, 400);
  assert.equal((await postJson(`/feedback/${sid2}/draft?t=wrong`, { draft: {} })).status, 403);
  assert.equal((await postJson(`/feedback/fb-missing/draft?t=${TOKEN}`, { draft: {} })).status, 404);
  assert.equal((await postJson(`/feedback/${sid2}/draft?t=${TOKEN}`, { draft: {} }, "application/json; charset=utf-8")).status, 200);
});

test("draft を保存し、submit で評価セットにラベルが書かれ、2 回目の submit と確定のあとの draft は 409", async () => {
  const draft = { [qid1]: { grades: { "m-a1": 2, "m-b1": 0 }, stale_ids: [] } };
  const d = await postJson(`/feedback/${sid1}/draft?t=${TOKEN}`, { draft });
  assert.equal(d.status, 200, d.body);
  assert.deepEqual(JSON.parse(d.body), { status: "ok" });

  const s = await postJson(`/feedback/${sid1}/submit?t=${TOKEN}`, { draft });
  assert.equal(s.status, 200, s.body);
  assert.deepEqual(JSON.parse(s.body), { status: "ok", written: 1 });

  const qs = await readEvalSet(dir);
  const labeled = qs.find((q) => q.labels.some((l) => l.session_id === sid1));
  assert.ok(labeled, "評価セットにこのセッションのラベルが無い");
  const label = labeled.labels.find((l) => l.session_id === sid1)!;
  assert.equal(label.source, "human");
  assert.deepEqual(label.relevant, { "m-a1": 2 });

  assert.equal((await postJson(`/feedback/${sid1}/submit?t=${TOKEN}`, { draft })).status, 409);
  assert.equal((await postJson(`/feedback/${sid1}/draft?t=${TOKEN}`, { draft })).status, 409);

  // 確定したセッションは dashboard の interleave に数えられる
  const data = JSON.parse((await raw("GET", `/feedback/${sid1}/data?t=${TOKEN}`)).body) as {
    session: { status: string };
    dashboard: { interleave: { wins: number; losses: number; ties: number; sessions: number; p: number } };
  };
  assert.equal(data.session.status, "confirmed");
  const il = data.dashboard.interleave;
  assert.equal(il.sessions, 1);
  assert.equal(il.wins + il.losses + il.ties, 1);
  assert.equal(il.p, signTest(il.wins, il.losses));
});

test("フィードバックの処理は stats の SQLite を作らず、評価のディレクトリの外に書かない", () => {
  const names = readdirSync(dir, { recursive: true }).map(String).sort();
  for (const n of names) assert.ok(!/\.(db|sqlite|sqlite3)(-wal|-shm)?$/.test(n), `SQLite らしいファイル: ${n}`);
  assert.ok(names.includes("eval-set.jsonl"));
  assert.ok(names.includes("history.jsonl"));
});

/** readBodies を渡した handleFeedback で GET data を 1 回呼ぶ */
async function dataWith(readBodies: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>): Promise<any> {
  const srv = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await handleFeedback(req, res, url, { dir, staticDir: STATIC_DIR, readBodies })) return;
      res.writeHead(404);
      res.end();
    })();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const p = (srv.address() as AddressInfo).port;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: p, method: "GET", path: `/feedback/${sid1}/data?t=${TOKEN}` }, (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
      req.end();
    });
    return JSON.parse(body);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

test("GET data は readBodies があればカードに全文 (body) を添え、上限で切る。無いカードと読めないときは body なし", async () => {
  let asked: readonly string[] = [];
  const long = "あ".repeat(BODY_MAX_CHARS + 10);
  const d = await dataWith(async (ids) => {
    asked = ids;
    return new Map([
      ["m-a1", "  ダミーの全文\n2 行目  "],
      ["m-c", long],
    ]);
  });
  const cards = d.session.items[0].cards as { id: string; body?: string }[];
  assert.equal(new Set(asked).size, asked.length, "同じ id を何度も聞かない");
  assert.ok(asked.includes("m-a1") && asked.includes("m-c"));
  assert.equal(cards.find((c) => c.id === "m-a1")!.body, "ダミーの全文\n2 行目");
  assert.equal(cards.find((c) => c.id === "m-c")!.body, "あ".repeat(BODY_MAX_CHARS) + "…");
  assert.equal(cards.find((c) => c.id === "m-b1")!.body, undefined);

  const failed = await dataWith(async () => {
    throw new Error("読めない");
  });
  assert.ok(failed.session.items[0].cards.every((c: { body?: string }) => c.body === undefined));
});
