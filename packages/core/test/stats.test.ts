import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsStore } from "../src/stats.ts";

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
