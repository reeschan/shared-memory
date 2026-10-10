import { readdir, readFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import type { MemoryMeta, Tier } from "./frontmatter.ts";
import { computeSuperseded, scanMemories } from "./indexing.ts";
import type { OpenSearchClient } from "./opensearch.ts";
import type { Stat, StatsStore } from "./stats.ts";

export type TierDeps = { os: OpenSearchClient; stats: StatsStore };

const DAY_MS = 86400000;
/** symbol_ref の確認で読むファイルの上限サイズ */
const MAX_SCAN_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);

export function computeTier(
  meta: MemoryMeta,
  stat: Stat | undefined,
  superseded: boolean,
  cfg: Config,
  now: Date,
): Tier {
  if (superseded) return "archive";
  const since = stat?.last_accessed_at ?? meta.created_at;
  const days = (now.getTime() - Date.parse(since)) / DAY_MS;
  const t = cfg.tiers;
  let tier: Tier;
  if (days >= t.archive_after_days) tier = "archive";
  else if (days >= t.cold_after_days) tier = "cold";
  else if (days >= t.warm_after_days) tier = "warm";
  else tier = "hot";
  if (meta.provenance === "human_confirmed" && (tier === "cold" || tier === "archive")) return "warm";
  return tier;
}

export async function syncTiers(
  cfg: Config,
  deps: TierDeps,
  changes: { memory_id: string; tier: Tier }[],
): Promise<number> {
  if (changes.length === 0) return 0;
  deps.stats.setTiers(changes);
  const byTier = new Map<Tier, string[]>();
  for (const c of changes) {
    const ids = byTier.get(c.tier) ?? [];
    ids.push(c.memory_id);
    byTier.set(c.tier, ids);
  }
  let updated = 0;
  for (const [tier, ids] of byTier) {
    if (ids.length === 0) continue;
    updated += await deps.os.updateByQuery(
      cfg.opensearch.alias,
      { terms: { memory_id: ids } },
      { source: "ctx._source.tier = params.tier", params: { tier } },
    );
  }
  return updated;
}

export async function runDecay(
  cfg: Config,
  deps: TierDeps,
  now: Date = new Date(),
): Promise<{ total: number; changed: { memory_id: string; from: Tier; to: Tier }[] }> {
  const { memories } = await scanMemories(cfg);
  const superseded = computeSuperseded(memories);
  const stats = deps.stats.all();
  const changed: { memory_id: string; from: Tier; to: Tier }[] = [];
  for (const m of memories) {
    const stat = stats.get(m.id);
    const from: Tier = stat?.tier ?? "hot";
    const to = computeTier(m, stat, superseded.has(m.id), cfg, now);
    if (from !== to) changed.push({ memory_id: m.id, from, to });
  }
  await syncTiers(cfg, deps, changed.map((c) => ({ memory_id: c.memory_id, tier: c.to })));
  return { total: memories.length, changed };
}

/** dir 配下のファイルを列挙する (.git / node_modules を除く) */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkFiles(p);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

/** dir 配下のテキストファイルのどれかに name が現れるか */
async function nameExistsIn(dir: string, name: string): Promise<boolean> {
  for await (const file of walkFiles(dir)) {
    try {
      const st = await fsStat(file);
      if (st.size > MAX_SCAN_BYTES) continue;
      const buf = await readFile(file);
      if (buf.includes(0)) continue; // バイナリっぽい
      if (buf.toString("utf8").includes(name)) return true;
    } catch {
      // 読めないファイルは飛ばす
    }
  }
  return false;
}

export async function runGc(
  cfg: Config,
  deps: TierDeps,
  _now: Date = new Date(),
): Promise<{
  archived: string[];
  brokenSymbolRefs: { memory_id: string; symbol_ref: string; reason: string }[];
}> {
  const { memories } = await scanMemories(cfg);
  const superseded = computeSuperseded(memories);
  const stats = deps.stats.all();

  const archived = memories
    .filter((m) => superseded.has(m.id) && (stats.get(m.id)?.tier ?? "hot") !== "archive")
    .map((m) => m.id);
  await syncTiers(cfg, deps, archived.map((id) => ({ memory_id: id, tier: "archive" as Tier })));

  const brokenSymbolRefs: { memory_id: string; symbol_ref: string; reason: string }[] = [];
  for (const m of memories) {
    if (!m.symbol_ref || !m.scope.startsWith("repo:")) continue;
    const repo = m.scope.slice("repo:".length);
    const dir = Object.hasOwn(cfg.repos, repo) ? cfg.repos[repo] : undefined;
    if (dir === undefined) {
      brokenSymbolRefs.push({ memory_id: m.id, symbol_ref: m.symbol_ref, reason: "repos に未登録" });
      continue;
    }
    const name = m.symbol_ref.slice(m.symbol_ref.lastIndexOf("/") + 1);
    if (name === "" || !(await nameExistsIn(dir, name))) {
      brokenSymbolRefs.push({
        memory_id: m.id,
        symbol_ref: m.symbol_ref,
        reason: `${dir} 配下に ${name} が見つからない`,
      });
    }
  }
  return { archived, brokenSymbolRefs };
}
