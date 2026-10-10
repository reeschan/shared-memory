import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.ts";
import type { MemoryMeta } from "../src/frontmatter.ts";
import type { Stat } from "../src/stats.ts";
import { computeTier } from "../src/tiers.ts";

const cfg = { tiers: { warm_after_days: 7, cold_after_days: 30, archive_after_days: 180 } } as Config;
const now = new Date("2026-10-10T00:00:00.000Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

function meta(createdDaysAgo: number, extra: Partial<MemoryMeta> = {}): MemoryMeta {
  return {
    id: "01J0000000000000000000000A",
    title: "t",
    scope: "global",
    kind: "semantic",
    provenance: "agent_verified",
    source_agent: "claude",
    created_at: daysAgo(createdDaysAgo),
    ...extra,
  };
}

function stat(lastDaysAgo: number | null): Stat {
  return {
    memory_id: "01J0000000000000000000000A",
    access_count: 1,
    last_accessed_at: lastDaysAgo === null ? null : daysAgo(lastDaysAgo),
    tier: "hot",
  };
}

test("経過 3 日は hot", () => {
  assert.equal(computeTier(meta(3), undefined, false, cfg, now), "hot");
});

test("経過 10 日は warm", () => {
  assert.equal(computeTier(meta(10), undefined, false, cfg, now), "warm");
});

test("経過 40 日は cold", () => {
  assert.equal(computeTier(meta(40), undefined, false, cfg, now), "cold");
});

test("経過 200 日は archive", () => {
  assert.equal(computeTier(meta(200), undefined, false, cfg, now), "archive");
});

test("境界: ちょうど 7 / 30 / 180 日でそれぞれ warm / cold / archive", () => {
  assert.equal(computeTier(meta(7), undefined, false, cfg, now), "warm");
  assert.equal(computeTier(meta(30), undefined, false, cfg, now), "cold");
  assert.equal(computeTier(meta(180), undefined, false, cfg, now), "archive");
});

test("last_accessed_at があればそちらを使う", () => {
  assert.equal(computeTier(meta(200), stat(3), false, cfg, now), "hot");
  assert.equal(computeTier(meta(3), stat(40), false, cfg, now), "cold");
});

test("last_accessed_at が null なら created_at を使う", () => {
  assert.equal(computeTier(meta(40), stat(null), false, cfg, now), "cold");
});

test("human_confirmed は 200 日でも warm (40 日も warm、3 日は hot のまま)", () => {
  const hc = { provenance: "human_confirmed" as const };
  assert.equal(computeTier(meta(200, hc), undefined, false, cfg, now), "warm");
  assert.equal(computeTier(meta(40, hc), undefined, false, cfg, now), "warm");
  assert.equal(computeTier(meta(3, hc), undefined, false, cfg, now), "hot");
});

test("superseded は human_confirmed でも archive (経過 0 日でも)", () => {
  assert.equal(computeTier(meta(0, { provenance: "human_confirmed" }), undefined, true, cfg, now), "archive");
  assert.equal(computeTier(meta(1), stat(0), true, cfg, now), "archive");
});
