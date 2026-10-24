import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Kind, Tier } from "./frontmatter.ts";

export type Stat = {
  memory_id: string;
  access_count: number;
  last_accessed_at: string | null;
  tier: Tier;
};

/** 検索ログ・get ログを何日残すか。 */
export const LOG_RETENTION_DAYS = 90;

export type LogSource = "mcp" | "cli";

export type SearchLogEntry = {
  at: string;
  source: LogSource;
  query: string;
  filters: { scope?: string; kind?: Kind; tags?: string[]; limit?: number; include_workspaces?: boolean };
  /** rank は 1 始まり。 */
  results: { id: string; rank: number; score: number }[];
};

export type GetLogEntry = {
  at: string;
  source: LogSource;
  memory_id: string;
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
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS search_log (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      TEXT NOT NULL,
        source  TEXT NOT NULL,
        query   TEXT NOT NULL,
        filters TEXT NOT NULL,
        results TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_log_at ON search_log(at);
      CREATE TABLE IF NOT EXISTS get_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        at        TEXT NOT NULL,
        source    TEXT NOT NULL,
        memory_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS get_log_at ON get_log(at);`,
    );
  }

  logSearch(e: SearchLogEntry): void {
    const filters: SearchLogEntry["filters"] = {};
    if (e.filters.scope !== undefined) filters.scope = e.filters.scope;
    if (e.filters.kind !== undefined) filters.kind = e.filters.kind;
    if (e.filters.tags !== undefined) filters.tags = e.filters.tags;
    if (e.filters.limit !== undefined) filters.limit = e.filters.limit;
    if (e.filters.include_workspaces === true) filters.include_workspaces = true;
    const results = e.results.map((r) => ({ id: r.id, rank: r.rank, score: r.score }));
    this.db
      .prepare("INSERT INTO search_log (at, source, query, filters, results) VALUES (?, ?, ?, ?, ?)")
      .run(e.at, e.source, e.query, JSON.stringify(filters), JSON.stringify(results));
  }

  logGet(e: GetLogEntry): void {
    this.db
      .prepare("INSERT INTO get_log (at, source, memory_id) VALUES (?, ?, ?)")
      .run(e.at, e.source, e.memory_id);
  }

  /** at が fromIso 以上 toIso 未満の行を、時刻の昇順 (同時刻は書いた順) で返す。 */
  readLogs(fromIso: string, toIso: string): { searches: SearchLogEntry[]; gets: GetLogEntry[] } {
    const searchRows = this.db
      .prepare(
        "SELECT at, source, query, filters, results FROM search_log WHERE at >= ? AND at < ? ORDER BY at, id",
      )
      .all(fromIso, toIso);
    const getRows = this.db
      .prepare("SELECT at, source, memory_id FROM get_log WHERE at >= ? AND at < ? ORDER BY at, id")
      .all(fromIso, toIso);
    return {
      searches: searchRows.map((row) => ({
        at: String(row.at),
        source: row.source as LogSource,
        query: String(row.query),
        filters: JSON.parse(String(row.filters)) as SearchLogEntry["filters"],
        results: JSON.parse(String(row.results)) as SearchLogEntry["results"],
      })),
      gets: getRows.map((row) => ({
        at: String(row.at),
        source: row.source as LogSource,
        memory_id: String(row.memory_id),
      })),
    };
  }

  /** at が beforeIso より前の行を消し、消した件数を返す。 */
  pruneLogs(beforeIso: string): { searches: number; gets: number } {
    this.db.exec("BEGIN");
    try {
      const s = this.db.prepare("DELETE FROM search_log WHERE at < ?").run(beforeIso);
      const g = this.db.prepare("DELETE FROM get_log WHERE at < ?").run(beforeIso);
      this.db.exec("COMMIT");
      return { searches: Number(s.changes), gets: Number(g.changes) };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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
