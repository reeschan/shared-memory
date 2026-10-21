import type { Config } from "./config.ts";
import type { Kind, Provenance } from "./frontmatter.ts";

/** 記憶の古さ。age_days は作成日から、idle_days は最後に読まれた日 (なければ作成日) からの日数 */
export type Freshness = {
  age_days: number;
  idle_days: number;
  last_accessed_at: string | null;
  stale: boolean;
};

export type FreshnessSource = {
  created_at: string;
  last_accessed_at?: string | null;
  kind: Kind;
  provenance: Provenance;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** from から now までの切り捨ての日数。未来の日付や読めない日付は 0 */
function daysSince(from: string, now: Date): number {
  const t = Date.parse(from);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** 作成からの日数が kind ごとの閾値 × 出所ごとの倍率以上なら stale とする (tier は見ない) */
export function computeFreshness(src: FreshnessSource, cfg: Config, now: Date): Freshness {
  const lastAccessed = src.last_accessed_at ?? null;
  const age_days = daysSince(src.created_at, now);
  const idle_days = daysSince(lastAccessed ?? src.created_at, now);
  const { after_days, provenance_multiplier } = cfg.search.stale;
  const threshold = after_days[src.kind] * (provenance_multiplier[src.provenance] ?? 1);
  return { age_days, idle_days, last_accessed_at: lastAccessed, stale: age_days >= threshold };
}
