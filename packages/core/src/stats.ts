import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Tier } from "./frontmatter.ts";

export type Stat = {
  memory_id: string;
  access_count: number;
  last_accessed_at: string | null;
  tier: Tier;
};

export class StatsStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS access_stats (
        memory_id        TEXT PRIMARY KEY,
        access_count     INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        tier             TEXT NOT NULL DEFAULT 'hot'
      )`,
    );
  }

  get(id: string): Stat | undefined {
    const row = this.db
      .prepare("SELECT memory_id, access_count, last_accessed_at, tier FROM access_stats WHERE memory_id = ?")
      .get(id);
    return row === undefined ? undefined : toStat(row);
  }

  all(): Map<string, Stat> {
    const rows = this.db
      .prepare("SELECT memory_id, access_count, last_accessed_at, tier FROM access_stats")
      .all();
    const map = new Map<string, Stat>();
    for (const row of rows) {
      const s = toStat(row);
      map.set(s.memory_id, s);
    }
    return map;
  }

  recordAccess(id: string, nowIso: string): Stat {
    this.db
      .prepare(
        `INSERT INTO access_stats (memory_id, access_count, last_accessed_at, tier)
         VALUES (?, 1, ?, 'hot')
         ON CONFLICT(memory_id) DO UPDATE SET
           access_count = access_count + 1,
           last_accessed_at = excluded.last_accessed_at,
           tier = 'hot'`,
      )
      .run(id, nowIso);
    const s = this.get(id);
    if (s === undefined) throw new Error(`stats row missing: ${id}`);
    return s;
  }

  setTiers(entries: { memory_id: string; tier: Tier }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO access_stats (memory_id, access_count, last_accessed_at, tier)
       VALUES (?, 0, NULL, ?)
       ON CONFLICT(memory_id) DO UPDATE SET tier = excluded.tier`,
    );
    this.db.exec("BEGIN");
    try {
      for (const e of entries) stmt.run(e.memory_id, e.tier);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

function toStat(row: Record<string, unknown>): Stat {
  return {
    memory_id: String(row.memory_id),
    access_count: Number(row.access_count),
    last_accessed_at: row.last_accessed_at === null ? null : String(row.last_accessed_at),
    tier: row.tier as Tier,
  };
}
