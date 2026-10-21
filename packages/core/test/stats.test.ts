import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsStore, LOG_RETENTION_DAYS, type SearchLogEntry, type GetLogEntry } from "../src/stats.ts";

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "stats-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("存在しない親ディレクトリにも DB を作れる", () => {
  withTmp((dir) => {
    const p = join(dir, "a", "b", "stats.sqlite");
    const s = new StatsStore(p);
    s.close();
    assert.ok(existsSync(p));
  });
});

test("recordAccess を 2 回で count=2、last は 2 回目、tier=hot", () => {
  withTmp((dir) => {
    const s = new StatsStore(join(dir, "s.sqlite"));
    assert.equal(s.get("x"), undefined);
    s.recordAccess("x", "2026-01-01T00:00:00.000Z");
    const r = s.recordAccess("x", "2026-01-02T00:00:00.000Z");
    assert.deepEqual(r, {
      memory_id: "x",
      access_count: 2,
      last_accessed_at: "2026-01-02T00:00:00.000Z",
      tier: "hot",
    });
    assert.deepEqual(s.get("x"), r);
    s.close();
  });
});

test("setTiers は count と last を保持し、行が無ければ count=0 で作る", () => {
  withTmp((dir) => {
    const s = new StatsStore(join(dir, "s.sqlite"));
    s.recordAccess("x", "2026-01-01T00:00:00.000Z");
    s.setTiers([
      { memory_id: "x", tier: "cold" },
      { memory_id: "y", tier: "warm" },
    ]);
    assert.deepEqual(s.get("x"), {
      memory_id: "x",
      access_count: 1,
      last_accessed_at: "2026-01-01T00:00:00.000Z",
      tier: "cold",
    });
    assert.deepEqual(s.get("y"), {
      memory_id: "y",
      access_count: 0,
      last_accessed_at: null,
      tier: "warm",
    });
    s.close();
  });
});

test("all() が全行を Map で返す", () => {
  withTmp((dir) => {
    const s = new StatsStore(join(dir, "s.sqlite"));
    s.recordAccess("a", "2026-01-01T00:00:00.000Z");
    s.setTiers([{ memory_id: "b", tier: "archive" }]);
    const m = s.all();
    assert.ok(m instanceof Map);
    assert.equal(m.size, 2);
    assert.equal(m.get("a")?.access_count, 1);
    assert.equal(m.get("b")?.tier, "archive");
    s.close();
  });
});

test("close 後に同じパスで開き直すと値が残っている", () => {
  withTmp((dir) => {
    const p = join(dir, "s.sqlite");
    const s1 = new StatsStore(p);
    s1.recordAccess("x", "2026-01-01T00:00:00.000Z");
    s1.setTiers([{ memory_id: "x", tier: "warm" }]);
    s1.close();
    const s2 = new StatsStore(p);
    assert.deepEqual(s2.get("x"), {
      memory_id: "x",
      access_count: 1,
      last_accessed_at: "2026-01-01T00:00:00.000Z",
      tier: "warm",
    });
    s2.close();
  });
});

function searchEntry(at: string, query: string, filters: SearchLogEntry["filters"] = {}): SearchLogEntry {
  return {
    at,
    source: "mcp",
    query,
    filters,
    results: [
      { id: "m1", rank: 1, score: 0.9 },
      { id: "m2", rank: 2, score: 0.5 },
    ],
  };
}

test("LOG_RETENTION_DAYS は 90", () => {
  assert.equal(LOG_RETENTION_DAYS, 90);
});

test("logSearch で書いた行を readLogs で読むと query・filters・results がそのまま戻る", () => {
  withTmp((dir) => {
    const s = new StatsStore(join(dir, "s.sqlite"));
    const full = searchEntry("2026-01-01T00:00:00.000Z", "検索 クエリ", {
      scope: "global",
      kind: "semantic",
      tags: ["a", "b"],
      limit: 5,
    });
    const partial: SearchLogEntry = {
      at: "2026-01-01T00:00:01.000Z",
      source: "cli",
      query: "only scope",
      filters: { scope: "repo:x" },
      results: [],
    };
    const none = searchEntry("2026-01-01T00:00:02.000Z", "no filters");
    s.logSearch(full);
    s.logSearch(partial);
    s.logSearch(none);
    const { searches, gets } = s.readLogs("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    assert.deepEqual(searches, [full, partial, none]);
    assert.deepEqual(Object.keys(searches[1]!.filters), ["scope"]);
    assert.deepEqual(Object.keys(searches[2]!.filters), []);
    assert.deepEqual(gets, []);
    s.close();
  });
});

test("logSearch は undefined のフィルタを保存しない", () => {
  withTmp((dir) => {
    const s = new StatsStore(join(dir, "s.sqlite"));
    s.logSearch(searchEntry("2026-01-01T00:00:00.000Z", "q", { scope: undefined, limit: 3 }));
    const { searches } = s.readLogs("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    assert.deepEqual(searches[0]!.filters, { limit: 3 });
    s.close();
  });
});

test("readLogs は from 以上 to 未満の行を時刻の昇順で、search と get を別々に返す", () => {
  withTmp((dir) => {
    const s = new StatsStore(join(dir, "s.sqlite"));
    // 書く順と時刻の順をずらす
    s.logSearch(searchEntry("2026-01-03T00:00:00.000Z", "q3"));
    s.logSearch(searchEntry("2026-01-01T00:00:00.000Z", "q1"));
    s.logSearch(searchEntry("2026-01-02T00:00:00.000Z", "q2"));
    s.logSearch(searchEntry("2025-12-31T23:59:59.999Z", "q0"));
    const g = (at: string, id: string): GetLogEntry => ({ at, source: "cli", memory_id: id });
    s.logGet(g("2026-01-02T12:00:00.000Z", "b"));
    s.logGet(g("2026-01-01T12:00:00.000Z", "a"));
    s.logGet(g("2026-01-03T00:00:00.000Z", "c"));
    const r = s.readLogs("2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    assert.deepEqual(
      r.searches.map((e) => e.query),
      ["q1", "q2"],
    );
    assert.deepEqual(r.gets, [g("2026-01-01T12:00:00.000Z", "a"), g("2026-01-02T12:00:00.000Z", "b")]);
    s.close();
  });
});

test("pruneLogs(before) は before より前の行だけを消し、件数を返す", () => {
  withTmp((dir) => {
    const s = new StatsStore(join(dir, "s.sqlite"));
    s.logSearch(searchEntry("2026-01-01T00:00:00.000Z", "old1"));
    s.logSearch(searchEntry("2026-01-02T00:00:00.000Z", "old2"));
    s.logSearch(searchEntry("2026-01-03T00:00:00.000Z", "keep"));
    s.logGet({ at: "2026-01-01T00:00:00.000Z", source: "mcp", memory_id: "a" });
    s.logGet({ at: "2026-01-03T00:00:00.000Z", source: "mcp", memory_id: "b" });
    s.logGet({ at: "2026-01-04T00:00:00.000Z", source: "mcp", memory_id: "c" });
    assert.deepEqual(s.pruneLogs("2026-01-03T00:00:00.000Z"), { searches: 2, gets: 1 });
    const r = s.readLogs("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    assert.deepEqual(
      r.searches.map((e) => e.query),
      ["keep"],
    );
    assert.deepEqual(
      r.gets.map((e) => e.memory_id),
      ["b", "c"],
    );
    assert.deepEqual(s.pruneLogs("2026-01-03T00:00:00.000Z"), { searches: 0, gets: 0 });
    s.close();
  });
});

test("close 後に同じパスで開き直してもログと access_stats が残っている", () => {
  withTmp((dir) => {
    const p = join(dir, "s.sqlite");
    const s1 = new StatsStore(p);
    const e = searchEntry("2026-01-01T00:00:00.000Z", "q", { tags: ["t"] });
    s1.logSearch(e);
    s1.logGet({ at: "2026-01-01T00:00:01.000Z", source: "cli", memory_id: "x" });
    s1.recordAccess("x", "2026-01-01T00:00:01.000Z");
    s1.close();
    const s2 = new StatsStore(p);
    const r = s2.readLogs("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    assert.deepEqual(r.searches, [e]);
    assert.deepEqual(r.gets, [{ at: "2026-01-01T00:00:01.000Z", source: "cli", memory_id: "x" }]);
    assert.equal(s2.get("x")?.access_count, 1);
    s2.close();
  });
});
