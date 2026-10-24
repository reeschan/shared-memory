import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { loadConfig, type Config } from "../src/config.ts";
import { WORKSPACE_SCOPE_PREFIX } from "../src/frontmatter.ts";
import { buildFilter, buildHybridQuery, primaryOnlyConfig, rescore, supersededAtMap } from "../src/search.ts";

const cfg = loadConfig();
const now = new Date("2026-10-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY).toISOString();

/** scope を付けない検索に入る、作業空間を除く条件 */
const NO_WORKSPACES = { bool: { must_not: [{ prefix: { scope: WORKSPACE_SCOPE_PREFIX } }] } };
const hasNoWorkspaces = (filter: object[]): boolean => filter.some((c) => isDeepStrictEqual(c, NO_WORKSPACES));

/** rescore のテスト用。PC ごとの設定に依存しないよう、係数と半減期を明示的に上書きする */
function rescoreCfg(decay_floor: number, access_weight: number): Config {
  return {
    ...cfg,
    search: {
      ...cfg.search,
      half_life_days: 90,
      provenance_factor: { human_confirmed: 1, agent_verified: 0.85, agent_inferred: 0.7 },
      rescore: { decay_floor, access_weight },
    },
  };
}
const soft = rescoreCfg(0.7, 0.2);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test("(a) buildFilter: 未指定なら 3 条件 (作業空間の除外を含む)、全部指定で 5 条件", () => {
  const f0 = buildFilter(cfg, { query: "x" });
  assert.deepEqual(f0, [
    { term: { is_superseded: false } },
    { terms: { tier: cfg.search.searchable_tiers } },
    NO_WORKSPACES,
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

test("(d) rescore: 経過日数 = half_life で減衰は 0.7 + 0.3 × 0.5 = 0.85 倍 (tier によらず、last_accessed_at 優先)", () => {
  const hl = soft.search.half_life_days;
  for (const tier of ["hot", "warm", "cold", "archive"] as const) {
    const s = rescore(1, { created_at: daysAgo(hl), tier, provenance: "human_confirmed" }, soft, now);
    near(s, 0.85);
  }
  const s = rescore(
    1,
    { created_at: daysAgo(1000), last_accessed_at: daysAgo(hl), tier: "hot", provenance: "human_confirmed" },
    soft,
    now,
  );
  near(s, 0.85);
});

test("(d2) rescore: 同じ経過日数なら tier が違っても同じスコア", () => {
  for (const d of [0, 6, 7, 8, 29, 31, 181, 400]) {
    const scores = (["hot", "warm", "cold", "archive"] as const).map((tier) =>
      rescore(0.9, { created_at: daysAgo(d), access_count: 3, tier, provenance: "agent_verified" }, soft, now),
    );
    for (const s of scores) assert.equal(s, scores[0], `${d} 日: ${scores}`);
  }
});

test("(d3) rescore: 経過日数が増えるとスコアは狭義に単調減少 (tier が変わる日をまたいでも)", () => {
  // runDecay の既定 (warm 7 日・cold 30 日) で tier が変わる前後の日数。tier も実際に合わせて変える
  const points: [number, "hot" | "warm" | "cold" | "archive"][] = [
    [6, "hot"], [7, "warm"], [8, "warm"], [29, "warm"], [31, "cold"], [179, "cold"], [181, "archive"],
  ];
  const scores = points.map(([d, tier]) =>
    rescore(1, { created_at: daysAgo(d), tier, provenance: "human_confirmed" }, soft, now),
  );
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i]! < scores[i - 1]!, String(scores));
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

test("(k) buildFilter: asOf があれば is_superseded の term を外し、created_at の range (lte が asOf.at の ISO) を足す", () => {
  const at = new Date("2026-09-01T12:34:56.000Z");
  const asOf = { at, supersededAt: new Map<string, string>() };
  const f0 = buildFilter(cfg, { query: "x" }, asOf);
  assert.deepEqual(f0, [
    { terms: { tier: cfg.search.searchable_tiers } },
    { range: { created_at: { lte: "2026-09-01T12:34:56.000Z" } } },
    NO_WORKSPACES,
  ]);
  const f1 = buildFilter(cfg, { query: "x", scope: "project:demo", kind: "semantic", tags: ["a"] }, asOf);
  assert.deepEqual(f1.slice(2), [
    { term: { scope: "project:demo" } },
    { term: { kind: "semantic" } },
    { terms: { tags: ["a"] } },
  ]);
  // asOf を渡さなければ今までと同じ
  assert.deepEqual(buildFilter(cfg, { query: "x" }, undefined), buildFilter(cfg, { query: "x" }));
  const q = buildHybridQuery(cfg, { query: "x" }, [0.1], asOf) as any;
  assert.deepEqual(q.query.hybrid.queries[0].bool.filter, f0);
  assert.deepEqual(q.query.hybrid.queries[1].knn.embedding.filter, { bool: { filter: f0 } });
});

test("(n) buildFilter: scope なしでは作業空間の除外が入る。include_workspaces: true なら入らない", () => {
  const f0 = buildFilter(cfg, { query: "x" });
  assert.deepEqual(f0.at(-1), NO_WORKSPACES);
  assert.equal(hasNoWorkspaces(f0), true);

  const f1 = buildFilter(cfg, { query: "x", include_workspaces: true });
  assert.deepEqual(f1, [
    { term: { is_superseded: false } },
    { terms: { tier: cfg.search.searchable_tiers } },
  ]);
  assert.equal(hasNoWorkspaces(f1), false);
});

test("(o) buildFilter: scope 指定 (作業空間でも global でも) では除外が入らず、scope の term が入る", () => {
  for (const scope of ["project:work.shared-memory.main.W-001", "global"]) {
    const f0 = buildFilter(cfg, { query: "x", scope });
    assert.equal(hasNoWorkspaces(f0), false);
    assert.deepEqual(f0.at(-1), { term: { scope } });
    // scope があるときは include_workspaces を見ない
    assert.deepEqual(buildFilter(cfg, { query: "x", scope, include_workspaces: true }), f0);
  }
});

test("(p) buildFilter: asOf 付きの scope なしでも作業空間の除外が入る", () => {
  const asOf = { at: new Date("2026-09-01T12:34:56.000Z"), supersededAt: new Map<string, string>() };
  const f0 = buildFilter(cfg, { query: "x" }, asOf);
  assert.deepEqual(f0.at(-1), NO_WORKSPACES);
  assert.equal(hasNoWorkspaces(f0), true);
  // scope を明示すれば asOf 付きでも除外は入らない
  const f1 = buildFilter(cfg, { query: "x", scope: "project:work.shared-memory.main.W-001" }, asOf);
  assert.equal(hasNoWorkspaces(f1), false);
});

test("(l) primaryOnlyConfig: decay_floor 1・access_weight 0・provenance_factor 全 1 を返し、元の cfg は変えない", () => {
  const before = structuredClone(soft);
  const p = primaryOnlyConfig(soft);
  assert.deepEqual(p.search.rescore, { decay_floor: 1, access_weight: 0 });
  assert.deepEqual(p.search.provenance_factor, { human_confirmed: 1, agent_verified: 1, agent_inferred: 1 });
  assert.deepEqual(soft, before);
  // ほかは cfg のまま
  assert.equal(p.search.half_life_days, soft.search.half_life_days);
  assert.deepEqual(p.search.searchable_tiers, soft.search.searchable_tiers);
  assert.deepEqual(p.rerank, soft.rerank);
  // rescore は一次スコアそのものになる
  const s = rescore(0.8, { created_at: daysAgo(10_000), access_count: 9, provenance: "agent_inferred" }, p, now);
  assert.equal(s, 0.8);
});

test("(m) supersededAtMap: 置き換えられた id → 置き換えた側の created_at。複数あれば最も早いものを取る", () => {
  const A = "01AAAAAAAAAAAAAAAAAAAAAAAA";
  const B = "01BBBBBBBBBBBBBBBBBBBBBBBB";
  const m = supersededAtMap([
    { meta: { id: "x1", created_at: "2026-05-03T00:00:00.000Z", supersedes: A } },
    { meta: { id: "x2", created_at: "2026-05-01T00:00:00.000Z", supersedes: A } },
    { meta: { id: "x3", created_at: "2026-05-02T00:00:00.000Z", supersedes: A } },
    { meta: { id: "y1", created_at: "2026-06-01T00:00:00.000Z", supersedes: B } },
    { meta: { id: A, created_at: "2026-01-01T00:00:00.000Z" } },
  ]);
  assert.deepEqual([...m.entries()].sort(), [
    [A, "2026-05-01T00:00:00.000Z"],
    [B, "2026-06-01T00:00:00.000Z"],
  ]);
  // scanMemories の Memory (メタが平らに並ぶ形) もそのまま受ける
  const flat = supersededAtMap([
    { id: "x1", created_at: "2026-05-03T00:00:00.000Z", supersedes: A },
    { id: "x2", created_at: "2026-05-01T00:00:00.000Z", supersedes: A },
    { id: B, created_at: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.deepEqual([...flat.entries()], [[A, "2026-05-01T00:00:00.000Z"]]);
});
