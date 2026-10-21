import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type Config } from "../src/config.ts";
import type { Embedder } from "../src/embed.ts";
import type { Provenance } from "../src/frontmatter.ts";
import type { OpenSearchClient } from "../src/opensearch.ts";
import type { Reranker } from "../src/rerank.ts";
import { buildHybridQuery, searchMemories, type AsOf } from "../src/search.ts";

const base = loadConfig();
const now = new Date("2026-10-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY).toISOString();

/** PC ごとの設定に依存しないよう、テストに効く値は明示的に上書きする */
function makeCfg(opts: { candidates?: number; decayFloor?: number } = {}): Config {
  return {
    ...base,
    rerank: { ...base.rerank, enabled: true, candidates: opts.candidates ?? 3 },
    search: {
      ...base.search,
      half_life_days: 90,
      provenance_factor: { human_confirmed: 1, agent_verified: 0.85, agent_inferred: 0.7 },
      rescore: { decay_floor: opts.decayFloor ?? 1, access_weight: 0 },
      default_limit: 10,
      stale: {
        after_days: { episodic: 30, semantic: 180 },
        provenance_multiplier: { human_confirmed: 3, agent_verified: 1, agent_inferred: 1 },
      },
    },
  };
}

type Row = {
  score: number;
  id: string;
  content: string;
  title?: string;
  created_at?: string;
  last_accessed_at?: string;
  provenance?: Provenance;
};

/** search メソッドだけを持つ偽の OpenSearch。渡した行をそのまま hits として返す */
function fakeOs(rows: Row[]): { os: OpenSearchClient; calls: { index: string; body: unknown }[] } {
  const calls: { index: string; body: unknown }[] = [];
  const os = {
    async search(index: string, body: unknown) {
      calls.push({ index, body });
      return {
        hits: rows.map((r, i) => ({
          _id: `${r.id}-${i}`,
          _score: r.score,
          _source: {
            memory_id: r.id,
            title: r.title ?? `title-${r.id}`,
            content: r.content,
            scope: "global",
            kind: "semantic",
            provenance: r.provenance ?? "human_confirmed",
            created_at: r.created_at ?? now.toISOString(),
            ...(r.last_accessed_at !== undefined ? { last_accessed_at: r.last_accessed_at } : {}),
            tier: "hot",
            access_count: 0,
          },
        })),
      };
    },
  };
  return { os: os as unknown as OpenSearchClient, calls };
}

const embedder: Embedder = {
  fingerprint: "test-fingerprint",
  dimension: 3,
  async embedDocuments() {
    return { vectors: [], cached: 0, embedded: 0 };
  },
  async embedQuery() {
    return [0.1, 0.2, 0.3];
  },
};

/** 文書の添字ごとに点数を返す偽の Reranker。省略時は先頭ほど高い点にする */
function fakeReranker(scores?: number[]): { reranker: Reranker; calls: { query: string; documents: string[] }[] } {
  const calls: { query: string; documents: string[] }[] = [];
  const reranker: Reranker = {
    async rerank(query, documents) {
      calls.push({ query, documents });
      const values = scores ?? documents.map((_, i) => documents.length - i);
      return documents
        .map((_, index) => ({ index, score: values[index] ?? 0 }))
        .sort((a, b) => b.score - a.score);
    },
  };
  return { reranker, calls };
}

function failingReranker(): { reranker: Reranker; calls: { query: string; documents: string[] }[] } {
  const calls: { query: string; documents: string[] }[] = [];
  const reranker: Reranker = {
    async rerank(query, documents) {
      calls.push({ query, documents });
      throw new Error("upstream down");
    },
  };
  return { reranker, calls };
}

test("reranker が無いとき: 代表チャンクを rescore 後のスコアの降順で limit 件返し、rerank_score は付かない", async () => {
  const cfg = makeCfg();
  const { os } = fakeOs([
    { score: 2, id: "m1", content: "m1 low", provenance: "agent_inferred" },
    { score: 5, id: "m1", content: "m1 high", title: "M1", provenance: "agent_inferred" },
    { score: 4, id: "m2", content: "m2 body" },
    { score: 1, id: "m3", content: "m3 body" },
  ]);
  const results = await searchMemories(cfg, { os, embedder }, { query: "q", limit: 2 }, now);
  assert.deepEqual(results.map((r) => r.id), ["m2", "m1"]);
  assert.deepEqual(results.map((r) => r.score), [4, 3.5]);
  assert.equal(results[1]!.excerpt, "m1 high");
  for (const r of results) assert.equal("rerank_score" in r, false);
});

test("reranker があるとき: 一次スコア上位 candidates の代表チャンクをその順で渡し、リランクの点数の降順で返す", async () => {
  const cfg = makeCfg({ candidates: 3 });
  const { os } = fakeOs([
    { score: 5, id: "m1", content: "m1 high", title: "M1" },
    { score: 1, id: "m1", content: "m1 low", title: "M1" },
    { score: 4, id: "m2", content: "m2 body" },
    { score: 3, id: "m3", content: "m3 body" },
    { score: 2, id: "m4", content: "m4 body" },
  ]);
  const fake = fakeReranker([0.1, 0.9, 0.5]);
  const results = await searchMemories(
    cfg,
    { os, embedder, reranker: fake.reranker },
    { query: "find memories", limit: 10 },
    now,
  );

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.query, "find memories");
  assert.deepEqual(fake.calls[0]!.documents, ["m1 high", "m2 body", "m3 body"]);

  assert.deepEqual(results.map((r) => r.id), ["m2", "m3", "m1", "m4"]);
  assert.deepEqual(results.map((r) => r.rerank_score), [0.9, 0.5, 0.1, undefined]);
  // score は rescore 後のスコアのまま (リランクの点数ではない)
  assert.deepEqual(results.map((r) => r.score), [4, 3, 5, 2]);
  assert.equal("rerank_score" in results[3]!, false);
});

test("rerank.candidates の候補は rescore の順ではなく一次スコアで選ぶ", async () => {
  const cfg = makeCfg({ candidates: 1, decayFloor: 0.1 });
  const { os } = fakeOs([
    { score: 10, id: "m1", content: "m1 body", created_at: daysAgo(10_000) },
    { score: 9, id: "m2", content: "m2 body", created_at: now.toISOString() },
    { score: 3, id: "m3", content: "m3 body", created_at: now.toISOString() },
  ]);
  const fake = fakeReranker([0.7]);
  const results = await searchMemories(cfg, { os, embedder, reranker: fake.reranker }, { query: "q" }, now);

  // rescore なら m2 が最上位だが、一次スコアが高い m1 が候補になる
  assert.deepEqual(fake.calls[0]!.documents, ["m1 body"]);
  assert.deepEqual(results.map((r) => r.id), ["m1", "m2", "m3"]);
  assert.equal(results[0]!.rerank_score, 0.7);
  assert.ok(Math.abs(results[0]!.score - 1) < 1e-6, String(results[0]!.score));
  assert.deepEqual(results.slice(1).map((r) => r.score), [9, 3]);
  assert.equal("rerank_score" in results[1]!, false);
});

test("reranker が例外を投げると、reranker が無いときと同じ順位に戻り、log に rerank failed を含むメッセージが 1 回渡る", async () => {
  const cfg = makeCfg({ candidates: 2, decayFloor: 0.1 });
  const { os } = fakeOs([
    { score: 10, id: "m1", content: "m1 body", created_at: daysAgo(10_000) },
    { score: 9, id: "m2", content: "m2 body", created_at: now.toISOString() },
    { score: 3, id: "m3", content: "m3 body", created_at: now.toISOString() },
  ]);
  const logs: string[] = [];
  const failing = failingReranker();
  const results = await searchMemories(
    cfg,
    { os, embedder, reranker: failing.reranker, log: (msg) => logs.push(msg) },
    { query: "q", limit: 10 },
    now,
  );
  const plain = await searchMemories(cfg, { os, embedder }, { query: "q", limit: 10 }, now);

  assert.deepEqual(results.map((r) => r.id), plain.map((r) => r.id));
  assert.deepEqual(results.map((r) => r.score), plain.map((r) => r.score));
  assert.deepEqual(results.map((r) => r.id), ["m2", "m3", "m1"]);
  for (const r of results) assert.equal("rerank_score" in r, false);
  assert.equal(failing.calls.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /rerank failed/);
});

test("limit が candidates より小さくても、候補全部をリランクして上位 limit 件だけを返す", async () => {
  const cfg = makeCfg({ candidates: 3 });
  const { os } = fakeOs([
    { score: 5, id: "m1", content: "m1 body" },
    { score: 4, id: "m2", content: "m2 body" },
    { score: 3, id: "m3", content: "m3 body" },
    { score: 2, id: "m4", content: "m4 body" },
  ]);
  const fake = fakeReranker([0.2, 0.9, 0.5]);
  const results = await searchMemories(
    cfg,
    { os, embedder, reranker: fake.reranker },
    { query: "q", limit: 2 },
    now,
  );

  assert.equal(fake.calls[0]!.documents.length, 3);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.id), ["m2", "m3"]);
  assert.deepEqual(results.map((r) => r.rerank_score), [0.9, 0.5]);
});

const freshnessRows = (): Row[] => [
  { score: 5, id: "old", content: "old body", title: "Old", created_at: daysAgo(200), provenance: "agent_verified" },
  {
    score: 4,
    id: "new",
    content: "new body",
    title: "New",
    created_at: daysAgo(10),
    last_accessed_at: daysAgo(3),
    provenance: "agent_verified",
  },
];

test("reranker が無いとき: 各結果に freshness が付き、作成日が古いヒットは stale true、既存のフィールドは変わらない", async () => {
  const cfg = makeCfg();
  const { os } = fakeOs(freshnessRows());
  const results = await searchMemories(cfg, { os, embedder }, { query: "q" }, now);

  assert.deepEqual(results.map((r) => r.id), ["old", "new"]);
  const [oldR, newR] = results;
  assert.deepEqual(oldR!.freshness, { age_days: 200, idle_days: 200, last_accessed_at: null, stale: true });
  assert.deepEqual(newR!.freshness, { age_days: 10, idle_days: 3, last_accessed_at: daysAgo(3), stale: false });
  const { freshness: _f, ...rest } = oldR!;
  assert.deepEqual(rest, {
    id: "old",
    title: "Old",
    excerpt: "old body",
    score: 5 * 0.85,
    scope: "global",
    kind: "semantic",
    provenance: "agent_verified",
    created_at: daysAgo(200),
  });
});

test("reranker があるとき: リランクした結果とその外の結果のどちらにも freshness が付き、既存のフィールドは変わらない", async () => {
  const cfg = makeCfg({ candidates: 1 });
  const { os } = fakeOs(freshnessRows());
  const fake = fakeReranker([0.8]);
  const results = await searchMemories(cfg, { os, embedder, reranker: fake.reranker }, { query: "q" }, now);

  assert.deepEqual(results.map((r) => r.id), ["old", "new"]);
  const [oldR, newR] = results;
  assert.deepEqual(oldR!.freshness, { age_days: 200, idle_days: 200, last_accessed_at: null, stale: true });
  assert.deepEqual(newR!.freshness, { age_days: 10, idle_days: 3, last_accessed_at: daysAgo(3), stale: false });
  const { freshness: _f, ...rest } = oldR!;
  assert.deepEqual(rest, {
    id: "old",
    title: "Old",
    excerpt: "old body",
    score: 5 * 0.85,
    scope: "global",
    kind: "semantic",
    provenance: "agent_verified",
    created_at: daysAgo(200),
    rerank_score: 0.8,
  });
  assert.equal("rerank_score" in newR!, false);
});

const asOfAt = new Date(now.getTime() - 110 * DAY);
const asOfOf = (supersededAt: [string, string][] = []): AsOf => ({ at: asOfAt, supersededAt: new Map(supersededAt) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const filtersOf = (body: any): object[][] => [
  body.query.hybrid.queries[0].bool.filter,
  body.query.hybrid.queries[1].knn.embedding.filter.bool.filter,
];

test("asOf があるとき: フィルターに is_superseded の term が無く、created_at の range (lte が asOf.at の ISO) がある", async () => {
  const cfg = makeCfg();
  const { os, calls } = fakeOs([{ score: 1, id: "m1", content: "m1 body" }]);
  await searchMemories(cfg, { os, embedder }, { query: "q", scope: "global" }, now, { asOf: asOfOf() });
  assert.equal(calls.length, 1);
  for (const filter of filtersOf(calls[0]!.body)) {
    assert.equal(JSON.stringify(filter).includes("is_superseded"), false);
    assert.deepEqual(filter, [
      { terms: { tier: cfg.search.searchable_tiers } },
      { range: { created_at: { lte: asOfAt.toISOString() } } },
      { term: { scope: "global" } },
    ]);
  }
});

test("asOf があるとき: supersededAt の時刻が asOf.at 以前のヒットは除き、asOf.at より後なら残す", async () => {
  const cfg = makeCfg();
  const { os } = fakeOs([
    { score: 5, id: "before", content: "before body" },
    { score: 4, id: "before", content: "before body 2" },
    { score: 3, id: "equal", content: "equal body" },
    { score: 2, id: "after", content: "after body" },
    { score: 1, id: "never", content: "never body" },
  ]);
  const asOf = asOfOf([
    ["before", new Date(asOfAt.getTime() - DAY).toISOString()],
    ["equal", asOfAt.toISOString()],
    ["after", new Date(asOfAt.getTime() + 1000).toISOString()],
  ]);
  const results = await searchMemories(cfg, { os, embedder }, { query: "q" }, now, { asOf });
  assert.deepEqual(results.map((r) => r.id), ["after", "never"]);

  const fake = fakeReranker();
  const reranked = await searchMemories(cfg, { os, embedder, reranker: fake.reranker }, { query: "q" }, now, { asOf });
  assert.deepEqual(fake.calls[0]!.documents, ["after body", "never body"]);
  assert.deepEqual(reranked.map((r) => r.id), ["after", "never"]);
});

test("asOf があるとき: rescore と freshness の「今」は asOf.at になる", async () => {
  const cfg = makeCfg({ decayFloor: 0 });
  // now から 200 日前に作成 = asOf.at から 90 日前 (半減期ちょうど)
  const { os } = fakeOs([{ score: 5, id: "m1", content: "m1 body", created_at: daysAgo(200) }]);
  const [r] = await searchMemories(cfg, { os, embedder }, { query: "q" }, now, { asOf: asOfOf() });
  assert.deepEqual(r!.freshness, { age_days: 90, idle_days: 90, last_accessed_at: null, stale: false });
  assert.ok(Math.abs(r!.score - 2.5) < 1e-9, String(r!.score));

  const [plain] = await searchMemories(cfg, { os, embedder }, { query: "q" }, now);
  assert.equal(plain!.freshness.age_days, 200);
  assert.ok(plain!.score < 2.5);
});

test("asOf が無いとき: OpenSearch に送るクエリは今までと同じ (is_superseded の term があり、range は無い)", async () => {
  const cfg = makeCfg();
  const input = { query: "q", scope: "global", tags: ["a"] };
  const { os, calls } = fakeOs([{ score: 1, id: "m1", content: "m1 body" }]);
  await searchMemories(cfg, { os, embedder }, input, now);
  await searchMemories(cfg, { os, embedder }, input, now, {});
  const expected = buildHybridQuery(cfg, input, [0.1, 0.2, 0.3]);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.deepEqual(c.body, expected);
    for (const filter of filtersOf(c.body)) {
      assert.deepEqual(filter, [
        { term: { is_superseded: false } },
        { terms: { tier: cfg.search.searchable_tiers } },
        { term: { scope: "global" } },
        { terms: { tags: ["a"] } },
      ]);
    }
  }
});
