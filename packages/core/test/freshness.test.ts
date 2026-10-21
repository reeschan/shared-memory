import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type Config } from "../src/config.ts";
import { computeFreshness } from "../src/freshness.ts";
import type { Kind, Provenance } from "../src/frontmatter.ts";

const base = loadConfig();
const now = new Date("2026-10-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY).toISOString();

/** PC ごとの設定に依存しないよう、stale の設定は既定値を明示する */
const cfg: Config = {
  ...base,
  search: {
    ...base.search,
    stale: {
      after_days: { episodic: 30, semantic: 180 },
      provenance_multiplier: { human_confirmed: 3, agent_verified: 1, agent_inferred: 1 },
    },
  },
};

function fresh(created_at: string, kind: Kind, provenance: Provenance, last_accessed_at?: string | null) {
  return computeFreshness({ created_at, last_accessed_at, kind, provenance }, cfg, now);
}

test("semantic (agent_verified): 作成 179 日前は stale false、180 日前は true", () => {
  assert.equal(fresh(daysAgo(179), "semantic", "agent_verified").stale, false);
  assert.equal(fresh(daysAgo(180), "semantic", "agent_verified").stale, true);
});

test("episodic (agent_inferred): 29 日前は false、30 日前は true", () => {
  assert.equal(fresh(daysAgo(29), "episodic", "agent_inferred").stale, false);
  assert.equal(fresh(daysAgo(30), "episodic", "agent_inferred").stale, true);
});

test("human_confirmed は倍率 3: semantic で 539 日前 false、540 日前 true", () => {
  assert.equal(fresh(daysAgo(539), "semantic", "human_confirmed").stale, false);
  assert.equal(fresh(daysAgo(540), "semantic", "human_confirmed").stale, true);
});

test("age_days は作成日から、idle_days は last_accessed_at からの切り捨ての日数", () => {
  const f = fresh(daysAgo(100.9), "semantic", "agent_verified", daysAgo(10.5));
  assert.deepEqual(f, { age_days: 100, idle_days: 10, last_accessed_at: daysAgo(10.5), stale: false });
});

test("last_accessed_at が無ければ idle_days は作成日から数え、last_accessed_at は null", () => {
  const undef = fresh(daysAgo(42.3), "episodic", "agent_verified");
  assert.deepEqual(undef, { age_days: 42, idle_days: 42, last_accessed_at: null, stale: true });
  const nul = fresh(daysAgo(42.3), "episodic", "agent_verified", null);
  assert.deepEqual(nul, undef);
});

test("未来の日付は 0 日", () => {
  const f = fresh(daysAgo(-5), "semantic", "agent_verified", daysAgo(-2));
  assert.equal(f.age_days, 0);
  assert.equal(f.idle_days, 0);
  assert.equal(f.stale, false);
});

test("tier は使わない (同じ作成日なら kind と provenance だけで決まる)", () => {
  const a = computeFreshness(
    { created_at: daysAgo(200), kind: "semantic", provenance: "agent_inferred" },
    cfg,
    now,
  );
  assert.equal(a.stale, true);
});
