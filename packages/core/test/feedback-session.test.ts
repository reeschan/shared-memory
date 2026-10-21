import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvalSet, writeEvalSet, type EvalQuestion } from "../src/evalset.ts";
import {
  SESSIONS_DIR,
  confirmSession,
  createFeedbackSession,
  interleaveTotals,
  loadSession,
  publicView,
  saveDraft,
  type SessionSearcher,
} from "../src/feedback-session.ts";
import { interleaveOutcome, teamDraft } from "../src/interleave.ts";
import type { AsOf, SearchInput, SearchResult } from "../src/search.ts";
import type { SearchLogEntry } from "../src/stats.ts";

// テストのデータはすべて作ったダミー (本物の記憶の ID・本文は使わない)

const NOW = new Date("2026-10-21T00:00:00.000Z");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sm-fb-"));
}

function res(id: string, over: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    title: `タイトル ${id}`,
    excerpt: `抜粋 ${id}`,
    score: 1,
    scope: "global",
    kind: "semantic",
    provenance: "agent_verified",
    created_at: "2026-01-01T00:00:00.000Z",
    freshness: { age_days: 3, idle_days: 3, last_accessed_at: null, stale: false },
    ...over,
  };
}

function log(query: string, at: string, filters: SearchLogEntry["filters"] = {}): SearchLogEntry {
  return { at, source: "mcp", query, filters, results: [] };
}

type Call = { input: SearchInput; asOf: AsOf };

/** query (小文字・空白を詰めたもの) → 結果。無ければ [] */
function fake(table: Record<string, SearchResult[]>): { fn: SessionSearcher; calls: Call[] } {
  const calls: Call[] = [];
  const fn: SessionSearcher = async (input, asOf) => {
    calls.push({ input, asOf });
    return table[input.query.trim().replace(/\s+/g, " ").toLowerCase()] ?? [];
  };
  return { fn, calls };
}

const SAME = [res("m-x"), res("m-y")];
const A_DIFF = [res("m-a1"), res("m-a2"), res("m-c")];
const B_DIFF = [res("m-b1"), res("m-c"), res("m-b2")];

function evq(qid: string, query: string, over: Partial<EvalQuestion> = {}): EvalQuestion {
  return { qid, query, asked_at: "2026-09-01T00:00:00.000Z", kind: "synthetic", labels: [], ...over };
}

const SUP = new Map<string, string>([["m-old", "2026-05-01T00:00:00.000Z"]]);

async function make(dir: string, over: Partial<Parameters<typeof createFeedbackSession>[0]> = {}) {
  const prod = fake({ diff1: A_DIFF, diff2: A_DIFF, same1: SAME });
  const prim = fake({ diff1: B_DIFF, diff2: B_DIFF, same1: SAME });
  const s = await createFeedbackSession({
    dir,
    questions: [],
    logs: [
      log("Diff1", "2026-10-15T00:00:00.000Z"),
      log("  diff1 ", "2026-10-18T00:00:00.000Z", { scope: "global", tags: ["t1"], limit: 5 }),
      log("diff1", "2026-10-16T00:00:00.000Z", { scope: "global", tags: ["t1"] }),
      log("diff2", "2026-10-17T00:00:00.000Z"),
      log("same1", "2026-10-20T00:00:00.000Z"),
    ],
    production: prod.fn,
    primary: prim.fn,
    supersededAt: SUP,
    now: NOW,
    seed: 7,
    newId: () => "fb-test-1",
    newToken: () => "secret-token",
    ...over,
  });
  return { s, prod, prim };
}

test("選び方: 同じ問いは最新にまとまり、上位が違う問い・新しい問いが先に並ぶ", async () => {
  const dir = tmp();
  const { s, prod, prim } = await make(dir);
  // "Diff1" (filters 無し) と "diff1" (scope+tags) は別の問い。scope+tags の 2 つは最新 (10-18) にまとまる
  assert.deepEqual(
    s.items.map((it) => [it.query, it.asked_at, it.differs]),
    [
      ["  diff1 ", "2026-10-18T00:00:00.000Z", true],
      ["diff2", "2026-10-17T00:00:00.000Z", true],
      ["Diff1", "2026-10-15T00:00:00.000Z", true],
      ["same1", "2026-10-20T00:00:00.000Z", false],
    ],
  );
  assert.ok(s.items.every((it) => it.kind === "real"));
  assert.deepEqual(s.items[0]!.filters, { scope: "global", tags: ["t1"] });
  assert.equal(s.items[1]!.filters, undefined);
  // 検索の関数に渡る asOf.at はログの at、filters はそのまま、limit は 10
  for (const c of [prod.calls, prim.calls]) {
    assert.equal(c.length, 4);
    const call = c.find((x) => x.input.query === "  diff1 ")!;
    assert.equal(call.asOf.at.toISOString(), "2026-10-18T00:00:00.000Z");
    assert.equal(call.asOf.supersededAt, SUP);
    assert.deepEqual(call.input, { query: "  diff1 ", scope: "global", tags: ["t1"], limit: 10 });
  }
  assert.equal(prod.calls.find((x) => x.input.query === "same1")!.asOf.at.toISOString(), "2026-10-20T00:00:00.000Z");
});

test("選び方: limit (既定 10) を超えない", async () => {
  const dir = tmp();
  const logs = Array.from({ length: 12 }, (_, i) => log(`q${i}`, `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`));
  const p = fake({});
  const s = await createFeedbackSession({
    dir, questions: [], logs, production: p.fn, primary: p.fn, supersededAt: new Map(), now: NOW, seed: 1,
    newId: () => "fb-lim",
  });
  assert.equal(s.items.length, 10);
  // 全部同じ (differs false) なので新しい順
  assert.equal(s.items[0]!.query, "q11");
  assert.equal(s.items[9]!.query, "q2");
  const s3 = await createFeedbackSession({
    dir, questions: [], logs, production: p.fn, primary: p.fn, supersededAt: new Map(), now: NOW, seed: 1,
    limit: 3, newId: () => "fb-lim3",
  });
  assert.equal(s3.items.length, 3);
});

test("選び方: 実クエリが足りなければ人のラベルが無い評価セットの問いで埋める (上位が違うものを先に)", async () => {
  const dir = tmp();
  const prod = fake({ real1: SAME, e2: SAME, e3: A_DIFF, e5: A_DIFF });
  const prim = fake({ real1: SAME, e2: SAME, e3: B_DIFF, e5: B_DIFF });
  const questions = [
    evq("s01", "e1", { labels: [{ source: "human", labeled_at: "2026-09-02T00:00:00.000Z", relevant: { "m-x": 2 } }] }),
    evq("s02", "e2", { labels: [{ source: "agent", labeled_at: "2026-09-02T00:00:00.000Z", relevant: { "m-x": 2 } }] }),
    evq("s03", "e3", { asked_at: "2026-08-01T00:00:00.000Z", kind: "real", filters: { scope: "global" } }),
    evq("s04", "REAL1"),
    evq("s05", "e5", { asked_at: "2026-08-05T00:00:00.000Z" }),
  ];
  const s = await createFeedbackSession({
    dir, questions, logs: [log("real1", "2026-10-19T00:00:00.000Z")], production: prod.fn, primary: prim.fn,
    supersededAt: new Map(), now: NOW, seed: 3, limit: 3, newId: () => "fb-fill",
  });
  assert.deepEqual(s.items.map((it) => [it.qid, it.query]), [["s04", "real1"], ["s05", "e5"], ["s03", "e3"]]);
  const e3 = s.items[2]!;
  assert.equal(e3.asked_at, "2026-08-01T00:00:00.000Z");
  assert.equal(e3.kind, "real");
  assert.deepEqual(e3.filters, { scope: "global" });
  assert.equal(prod.calls.find((c) => c.input.query === "e3")!.asOf.at.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.deepEqual(prod.calls.find((c) => c.input.query === "e3")!.input, { query: "e3", scope: "global", limit: 10 });
  // 人のラベルがある e1 は測らない
  assert.equal(prod.calls.some((c) => c.input.query === "e1"), false);
  // limit に届いたので e2 (上位が同じ) は入らない
  assert.equal(s.items.some((it) => it.query === "e2"), false);
});

test("cards と teams は teamDraft どおりで、カードの中身は SearchResult から来る", async () => {
  const dir = tmp();
  const stale = res("m-c", { title: "C の題", excerpt: "C の抜粋", created_at: "2025-01-02T00:00:00.000Z", provenance: "human_confirmed", scope: "repo:dummy", freshness: { age_days: 400, idle_days: 1, last_accessed_at: null, stale: true } });
  const a = [res("m-a1"), stale, res("m-a2")];
  const b = [res("m-b1"), stale];
  const prod = fake({ q: a });
  const prim = fake({ q: b });
  const s = await createFeedbackSession({
    dir, questions: [], logs: [log("q", "2026-10-19T00:00:00.000Z"), log("other", "2026-10-18T00:00:00.000Z")],
    production: prod.fn, primary: prim.fn, supersededAt: new Map(), now: NOW, seed: 42, newId: () => "fb-cards",
  });
  for (let i = 0; i < s.items.length; i++) {
    const it = s.items[i]!;
    const ra = it.query === "q" ? a : [];
    const rb = it.query === "q" ? b : [];
    const il = teamDraft(ra.map((r) => r.id), rb.map((r) => r.id), 42 + i, 10);
    assert.deepEqual(it.cards.map((c) => c.id), il.ids);
    assert.deepEqual(it.teams, il.teams);
    assert.equal(it.cards.length, it.teams.length);
  }
  const card = s.items[0]!.cards.find((c) => c.id === "m-c")!;
  assert.deepEqual(card, {
    id: "m-c", title: "C の題", excerpt: "C の抜粋", created_at: "2025-01-02T00:00:00.000Z",
    provenance: "human_confirmed", scope: "repo:dummy", stale: true, age_days: 400,
  });
  assert.equal(s.seed, 42);
  assert.equal(s.status, "open");
  assert.deepEqual(s.draft, {});
  assert.equal(s.created_at, NOW.toISOString());
});

test("既定の id と合言葉の形", async () => {
  const dir = tmp();
  const p = fake({});
  const s = await createFeedbackSession({
    dir, questions: [], logs: [], production: p.fn, primary: p.fn, supersededAt: new Map(), now: new Date("2026-10-21T01:02:03.000Z"),
  });
  assert.match(s.id, /^fb-20261021010203-[0-9a-f]{6}$/);
  assert.match(s.token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(Number.isInteger(s.seed) && s.seed >= 1);
  assert.deepEqual(s.items, []);
});

test("<dir>/sessions/<id>.json に保存され loadSession で戻る。id が不正・無いなら undefined", async () => {
  const dir = tmp();
  const { s } = await make(dir);
  const file = join(dir, SESSIONS_DIR, "fb-test-1.json");
  assert.ok(existsSync(file));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), s);
  assert.deepEqual(await loadSession(dir, "fb-test-1"), s);
  assert.equal(await loadSession(dir, "../fb-test-1"), undefined);
  assert.equal(await loadSession(dir, "fb.test"), undefined);
  assert.equal(await loadSession(dir, ""), undefined);
  assert.equal(await loadSession(dir, "x".repeat(65)), undefined);
  assert.equal(await loadSession(dir, "fb-none"), undefined);
});

test("saveDraft: ok / forbidden / not_found / closed", async () => {
  const dir = tmp();
  const { s } = await make(dir);
  const qid = s.items[0]!.qid;
  const draft = { [qid]: { grades: { "m-a1": 2 as const, "m-b1": 0 as const }, stale_ids: ["m-c"] } };
  assert.deepEqual(await saveDraft(dir, "fb-test-1", "secret-token", draft), { status: "ok" });
  assert.deepEqual((await loadSession(dir, "fb-test-1"))!.draft, draft);
  assert.deepEqual(await saveDraft(dir, "fb-test-1", "secret-tokeX", draft), { status: "forbidden" });
  assert.deepEqual(await saveDraft(dir, "fb-test-1", "short", draft), { status: "forbidden" });
  assert.deepEqual(await saveDraft(dir, "fb-test-1", "", draft), { status: "forbidden" });
  assert.deepEqual(await saveDraft(dir, "fb-nothing", "secret-token", draft), { status: "not_found" });
  assert.deepEqual(await saveDraft(dir, "../bad", "secret-token", draft), { status: "not_found" });
  assert.equal((await confirmSession(dir, "fb-test-1", "secret-token")).status, "ok");
  assert.deepEqual(await saveDraft(dir, "fb-test-1", "secret-token", draft), { status: "closed" });
});

test("confirmSession: 判定のある問いだけ評価セットに書き、outcomes を記録して confirmed にする", async () => {
  const dir = tmp();
  await writeEvalSet(dir, [evq("s01", "DIFF2", { labels: [{ source: "agent", labeled_at: "2026-09-01T00:00:00.000Z", relevant: { "m-a1": 1 } }] })]);
  const { s } = await make(dir);
  const [d1, d2, , same] = s.items;
  assert.equal(same!.differs, false);
  // 上位が同じ問い: a と b が同じ並びでも team-draft は片方に点が入るので、そうなる判定を作る
  const sameGrades = { [same!.cards[0]!.id]: 2 as const };
  assert.notEqual(interleaveOutcome({ ids: same!.cards.map((c) => c.id), teams: same!.teams }, sameGrades), "tie");
  const g1 = { "m-a1": 2 as const, "m-b1": 0 as const, "m-c": 1 as const };
  const g2 = { "m-b1": 2 as const, "m-b2": 1 as const };
  const draft = {
    [d1!.qid]: { grades: g1, stale_ids: ["m-a2"] },
    [d2!.qid]: { grades: g2, stale_ids: [] },
    [same!.qid]: { grades: sameGrades, stale_ids: [] },
  };
  const r = await confirmSession(dir, "fb-test-1", "secret-token", draft);
  assert.deepEqual(r, { status: "ok", written: 3 });

  const after = (await loadSession(dir, "fb-test-1"))!;
  assert.equal(after.status, "confirmed");
  assert.ok(typeof after.confirmed_at === "string" && !Number.isNaN(Date.parse(after.confirmed_at)));
  assert.deepEqual(after.outcomes, {
    [d1!.qid]: interleaveOutcome({ ids: d1!.cards.map((c) => c.id), teams: d1!.teams }, g1),
    [d2!.qid]: interleaveOutcome({ ids: d2!.cards.map((c) => c.id), teams: d2!.teams }, g2),
    [same!.qid]: "tie",
  });
  assert.deepEqual(after.draft, draft);

  const qs = await readEvalSet(dir);
  // 既存の s01 (DIFF2) にラベルが足され、diff1 (scope+tags) と same1 は新しい問いになる。Diff1 (判定なし) は書かない
  assert.equal(qs.length, 3);
  const s01 = qs.find((q) => q.qid === "s01")!;
  assert.equal(s01.labels.length, 2);
  assert.deepEqual(s01.labels[1], {
    source: "human", labeled_at: after.confirmed_at, session_id: "fb-test-1", relevant: { "m-b1": 2, "m-b2": 1 }, stale_ids: [],
  });
  const n1 = qs.find((q) => q.query === "  diff1 ")!;
  assert.equal(n1.kind, "real");
  assert.equal(n1.asked_at, "2026-10-18T00:00:00.000Z");
  assert.deepEqual(n1.filters, { scope: "global", tags: ["t1"] });
  assert.deepEqual(n1.labels[0]!.relevant, { "m-a1": 2, "m-c": 1 });
  assert.deepEqual(n1.labels[0]!.stale_ids, ["m-a2"]);
  assert.ok(qs.some((q) => q.query === "same1"));
  assert.equal(qs.some((q) => q.query === "Diff1"), false);

  assert.deepEqual(await confirmSession(dir, "fb-test-1", "secret-token", draft), { status: "closed" });
  assert.deepEqual(await confirmSession(dir, "fb-test-1", "wrong-token!", draft), { status: "forbidden" });
  assert.deepEqual(await confirmSession(dir, "fb-none", "secret-token"), { status: "not_found" });
  assert.equal((await readEvalSet(dir)).length, 3);
});

test("confirmSession: draft を渡さなければ保存した下書きを使う。判定が無ければ書かない", async () => {
  const dir = tmp();
  const { s } = await make(dir);
  const qid = s.items[1]!.qid;
  await saveDraft(dir, "fb-test-1", "secret-token", { [qid]: { grades: { "m-a1": 1 }, stale_ids: [] }, other: { grades: { "m-x": 2 }, stale_ids: [] } });
  assert.deepEqual(await confirmSession(dir, "fb-test-1", "secret-token"), { status: "ok", written: 1 });
  assert.equal((await readEvalSet(dir)).length, 1);

  const dir2 = tmp();
  await make(dir2);
  assert.deepEqual(await confirmSession(dir2, "fb-test-1", "secret-token", {}), { status: "ok", written: 0 });
  assert.deepEqual((await loadSession(dir2, "fb-test-1"))!.outcomes, {});
  assert.equal(existsSync(join(dir2, "eval-set.jsonl")), false);
});

test("publicView に token と teams が含まれない", async () => {
  const dir = tmp();
  const { s } = await make(dir);
  const v = publicView(s);
  assert.equal("token" in v, false);
  assert.ok(v.items.length > 0);
  for (const it of v.items) assert.equal("teams" in it, false);
  assert.equal(JSON.stringify(v).includes("secret-token"), false);
  assert.equal(v.id, s.id);
  assert.deepEqual(v.items[0]!.cards, s.items[0]!.cards);
  // 元のセッションは変えない
  assert.equal(s.token, "secret-token");
  assert.ok(Array.isArray(s.items[0]!.teams));
});

test("interleaveTotals は確定したセッションだけを数える", async () => {
  const dir = tmp();
  assert.deepEqual(await interleaveTotals(dir), { wins: 0, losses: 0, ties: 0, sessions: 0 });
  const { s } = await make(dir);
  await make(dir, { newId: () => "fb-test-2" });
  await make(dir, { newId: () => "fb-test-3" });
  const it = s.items[0]!;
  // a が出したカードだけに点を付ける → a の勝ち。b だけ → b の勝ち
  const aIds = it.cards.filter((_, i) => it.teams[i] === "a").map((c) => c.id);
  const bIds = it.cards.filter((_, i) => it.teams[i] === "b").map((c) => c.id);
  const it2 = s.items[1]!;
  const bIds2 = it2.cards.filter((_, i) => it2.teams[i] === "b").map((c) => c.id);
  await confirmSession(dir, "fb-test-1", "secret-token", {
    [it.qid]: { grades: { [aIds[0]!]: 2 }, stale_ids: [] },
    [it2.qid]: { grades: { [bIds2[0]!]: 2 }, stale_ids: [] },
    [s.items[3]!.qid]: { grades: { "m-x": 2 }, stale_ids: [] },
  });
  await confirmSession(dir, "fb-test-2", "secret-token", {
    [it.qid]: { grades: { [bIds[0]!]: 1 }, stale_ids: [] },
  });
  // fb-test-3 は open のまま (下書きだけ)
  await saveDraft(dir, "fb-test-3", "secret-token", { [it.qid]: { grades: { [aIds[0]!]: 2 }, stale_ids: [] } });
  assert.deepEqual(await interleaveTotals(dir), { wins: 1, losses: 2, ties: 1, sessions: 2 });
});

test("下書きの保存と確定は 1 つずつ流れ、確定のあとに古い下書きの保存がセッションを open に戻さない。同時の確定は 1 回だけ通る", async () => {
  const dir = tmp();
  const { s } = await make(dir);
  const qid = s.items[0]!.qid;
  const draft = { [qid]: { grades: { "m-a1": 2 as const }, stale_ids: [] } };
  // 確定の直前に送られた下書きの保存と、確定と、確定のあとに届いた下書きの保存を同時に走らせる
  const results = await Promise.all([
    saveDraft(dir, "fb-test-1", "secret-token", draft),
    confirmSession(dir, "fb-test-1", "secret-token", draft),
    saveDraft(dir, "fb-test-1", "secret-token", {}),
    confirmSession(dir, "fb-test-1", "secret-token", draft),
  ]);
  assert.deepEqual(results.map((r) => r.status), ["ok", "ok", "closed", "closed"]);
  const back = (await loadSession(dir, "fb-test-1"))!;
  assert.equal(back.status, "confirmed");
  assert.ok(back.outcomes !== undefined && Object.keys(back.outcomes).length === 1);
  // 人のラベルは 1 回だけ書かれる
  const labels = (await readEvalSet(dir)).flatMap((q) => q.labels.filter((l) => l.source === "human"));
  assert.equal(labels.length, 1);
  // 一時ファイルは残らない
  assert.deepEqual(readdirSync(join(dir, SESSIONS_DIR)).filter((f) => f.endsWith(".tmp")), []);
});

test("同じセッションへの下書きの保存を並べても失敗しない (一時ファイルがぶつからない)", async () => {
  const dir = tmp();
  const { s } = await make(dir);
  const qid = s.items[0]!.qid;
  const saves = Array.from({ length: 8 }, (_, i) =>
    saveDraft(dir, "fb-test-1", "secret-token", { [qid]: { grades: { "m-a1": (i % 3) as 0 | 1 | 2 }, stale_ids: [] } }),
  );
  assert.ok((await Promise.all(saves)).every((r) => r.status === "ok"));
  assert.equal((await loadSession(dir, "fb-test-1"))!.draft[qid]!.grades["m-a1"], 7 % 3);
});
