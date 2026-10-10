import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { buildFilter, buildHybridQuery, rescore } from "../src/search.ts";

const cfg = loadConfig();
const now = new Date("2026-10-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY).toISOString();

test("(a) buildFilter: 未指定なら 2 条件、全部指定で 5 条件", () => {
  const f0 = buildFilter(cfg, { query: "x" });
  assert.deepEqual(f0, [
    { term: { is_superseded: false } },
    { terms: { tier: cfg.search.searchable_tiers } },
  ]);
  const f1 = buildFilter(cfg, { query: "x", scope: "project:demo", kind: "semantic", tags: ["a", "b"] });
  assert.equal(f1.length, 5);
  assert.deepEqual(f1.slice(2), [
    { term: { scope: "project:demo" } },
    { term: { kind: "semantic" } },
    { terms: { tags: ["a", "b"] } },
  ]);
});

test("(b) buildHybridQuery: queries は BM25 → kNN の順で、両方に同じ filter", () => {
  const input = { query: "埋め込みモデル", scope: "global" };
  const vec = [0.1, 0.2, 0.3];
  const q = buildHybridQuery(cfg, input, vec) as any;
  const filter = buildFilter(cfg, input);
  assert.equal(q.size, cfg.search.candidates);
  assert.deepEqual(q._source, { excludes: ["embedding"] });
  assert.deepEqual(Object.keys(q.query), ["hybrid"]);
  const [bm25, knn] = q.query.hybrid.queries;
  assert.equal(q.query.hybrid.queries.length, 2);
  assert.deepEqual(bm25.bool.must.multi_match, { query: "埋め込みモデル", fields: ["title^2", "content"] });
  assert.deepEqual(bm25.bool.filter, filter);
  assert.deepEqual(knn.knn.embedding.vector, vec);
  assert.equal(knn.knn.embedding.k, cfg.search.candidates);
  assert.deepEqual(knn.knn.embedding.filter, { bool: { filter } });
});

test("(c) rescore: 経過 0 日・access 0・human_confirmed ならハイブリッドスコアと同じ", () => {
  const s = rescore(0.73, { created_at: now.toISOString(), access_count: 0, tier: "hot", provenance: "human_confirmed" }, cfg, now);
  assert.equal(s, 0.73);
  // 未来の日時 (経過日数が負) は 0 日扱い
  const f = rescore(0.73, { created_at: daysAgo(-3), provenance: "human_confirmed" }, cfg, now);
  assert.equal(f, 0.73);
});

test("(d) rescore: 経過日数 = half_life でちょうど半分 (tier ごと、last_accessed_at 優先)", () => {
  for (const tier of ["hot", "warm"] as const) {
    const hl = cfg.search.half_life_days[tier];
    const s = rescore(1, { created_at: daysAgo(hl), tier, provenance: "human_confirmed" }, cfg, now);
    assert.ok(Math.abs(s - 0.5) < 1e-12, `${tier}: ${s}`);
  }
  const hl = cfg.search.half_life_days.hot;
  const s = rescore(
    1,
    { created_at: daysAgo(1000), last_accessed_at: daysAgo(hl), tier: "hot", provenance: "human_confirmed" },
    cfg,
    now,
  );
  assert.ok(Math.abs(s - 0.5) < 1e-12);
});

test("(e) rescore: agent_inferred は human_confirmed の 0.7 倍", () => {
  const base = { created_at: daysAgo(5), access_count: 2, tier: "hot" as const };
  const h = rescore(0.8, { ...base, provenance: "human_confirmed" }, cfg, now);
  const i = rescore(0.8, { ...base, provenance: "agent_inferred" }, cfg, now);
  assert.ok(Math.abs(i / h - 0.7) < 1e-12);
  const v = rescore(0.8, { ...base, provenance: "agent_verified" }, cfg, now);
  assert.ok(Math.abs(v / h - 0.85) < 1e-12);
});

test("(f) rescore: access_count が多いほど高い", () => {
  const scores = [0, 1, 5, 50].map((n) =>
    rescore(0.5, { created_at: daysAgo(3), access_count: n, provenance: "agent_verified" }, cfg, now),
  );
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i]! > scores[i - 1]!, String(scores));
  assert.ok(Math.abs(scores[1]! / scores[0]! - (1 + Math.log(2))) < 1e-12);
});
