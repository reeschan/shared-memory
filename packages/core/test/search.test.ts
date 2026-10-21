import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type Config } from "../src/config.ts";
import { buildFilter, buildHybridQuery, rescore } from "../src/search.ts";

const cfg = loadConfig();
const now = new Date("2026-10-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY).toISOString();

/** rescore のテスト用。PC ごとの設定に依存しないよう、係数と半減期を明示的に上書きする */
function rescoreCfg(decay_floor: number, access_weight: number): Config {
  return {
    ...cfg,
    search: {
      ...cfg.search,
      half_life_days: { hot: 30, warm: 60, cold: 120, archive: 365 },
      provenance_factor: { human_confirmed: 1, agent_verified: 0.85, agent_inferred: 0.7 },
      rescore: { decay_floor, access_weight },
    },
  };
}
const soft = rescoreCfg(0.7, 0.2);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

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
  const s = rescore(0.73, { created_at: now.toISOString(), access_count: 0, tier: "hot", provenance: "human_confirmed" }, soft, now);
  assert.equal(s, 0.73);
  // 未来の日時 (経過日数が負) は 0 日扱い
  const f = rescore(0.73, { created_at: daysAgo(-3), provenance: "human_confirmed" }, soft, now);
  assert.equal(f, 0.73);
});

test("(d) rescore: 経過日数 = half_life で減衰は 0.7 + 0.3 × 0.5 = 0.85 倍 (tier ごと、last_accessed_at 優先)", () => {
  for (const tier of ["hot", "warm"] as const) {
    const hl = soft.search.half_life_days[tier];
    const s = rescore(1, { created_at: daysAgo(hl), tier, provenance: "human_confirmed" }, soft, now);
    near(s, 0.85);
  }
  const hl = soft.search.half_life_days.hot;
  const s = rescore(
    1,
    { created_at: daysAgo(1000), last_accessed_at: daysAgo(hl), tier: "hot", provenance: "human_confirmed" },
    soft,
    now,
  );
  near(s, 0.85);
});

test("(e) rescore: 減衰が 0 に近い古いメモリでも、減衰の係数は下限 0.7 で止まる", () => {
  const old = { created_at: daysAgo(100_000), access_count: 0, tier: "hot" as const, provenance: "human_confirmed" as const };
  near(rescore(1, old, soft, now), 0.7);
  // 一次スコアが変わっても係数は 0.7 のまま
  near(rescore(0.4, old, soft, now), 0.7 * 0.4);
});

test("(f) rescore: access_count 0 ではアクセスの係数が 1", () => {
  const now0 = { created_at: now.toISOString(), access_count: 0, tier: "hot" as const, provenance: "human_confirmed" as const };
  for (const w of [0, 0.2, 0.9]) {
    near(rescore(0.6, now0, rescoreCfg(1.0, w), now), 0.6);
  }
});

test("(g) rescore: access_count 2 ならアクセスの係数は 1 + 0.2 × ln 3", () => {
  const c = rescoreCfg(1.0, 0.2);
  const s = rescore(0.5, { created_at: now.toISOString(), access_count: 2, tier: "hot", provenance: "human_confirmed" }, c, now);
  near(s, 0.5 * (1 + 0.2 * Math.log(3)));
});

test("(h) rescore: 出所の係数が掛かる", () => {
  const c = rescoreCfg(1.0, 0.2);
  const base = { created_at: now.toISOString(), access_count: 2, tier: "hot" as const };
  const h = rescore(0.8, { ...base, provenance: "human_confirmed" }, c, now);
  const v = rescore(0.8, { ...base, provenance: "agent_verified" }, c, now);
  const i = rescore(0.8, { ...base, provenance: "agent_inferred" }, c, now);
  near(v / h, 0.85);
  near(i / h, 0.7);
});

test("(i) rescore: access_count が多いほど高い", () => {
  const c = rescoreCfg(0.7, 0.2);
  const scores = [0, 1, 5, 50].map((n) =>
    rescore(0.5, { created_at: daysAgo(3), access_count: n, provenance: "agent_verified" }, c, now),
  );
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i]! > scores[i - 1]!, String(scores));
  near(scores[1]! / scores[0]!, 1 + 0.2 * Math.log(2));
});

test("(j) rescore: decay_floor 1.0・access_weight 0 なら一次スコア × 出所の係数だけ", () => {
  const c = rescoreCfg(1.0, 0);
  const base = { created_at: daysAgo(100_000), access_count: 7, tier: "hot" as const };
  near(rescore(0.8, { ...base, provenance: "human_confirmed" }, c, now), 0.8);
  near(rescore(0.8, { ...base, provenance: "agent_verified" }, c, now), 0.8 * 0.85);
  near(rescore(0.8, { ...base, provenance: "agent_inferred" }, c, now), 0.8 * 0.7);
});
