// sm feedback と通知の単体テスト。CLI のプロセスも OpenSearch も使わず、一時ディレクトリ・一時の SQLite・
// 偽物の検索の関数で feedback-command.ts と notify.ts の関数を呼ぶ。
// テストのデータはすべて作ったダミー (本物の記憶の ID・本文は使わない)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSIONS_DIR,
  StatsStore,
  loadConfig,
  loadSession,
  writeEvalSet,
  type Config,
  type EvalRun,
  type SearchInput,
  type SearchResult,
  type SessionSearcher,
} from "@shared-memory/core";
import {
  NO_QUESTIONS_MESSAGE,
  runFeedbackCommand,
  type FeedbackCommandDeps,
} from "../src/feedback-command.ts";
import { TOAST_SCRIPT, evalNotice, notify, openCommand } from "../src/notify.ts";

const base = loadConfig();
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-18T01:00:00.000Z");

function tmpCfg(): { cfg: Config; stats: StatsStore; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "sm-feedback-cli-"));
  const dbPath = join(root, "state.db");
  const cfg: Config = {
    ...base,
    memories_dir: join(root, "memories"),
    state_db: dbPath,
    eval: { dir: join(root, "eval") },
    mcp: { ...base.mcp, host: "127.0.0.1", port: 17820 },
  };
  return { cfg, stats: new StatsStore(dbPath), dbPath };
}

function result(id: string): SearchResult {
  return {
    id,
    title: `ダミーの記憶 ${id}`,
    excerpt: `ダミーの本文 ${id}`,
    score: 1,
    scope: "global",
    kind: "semantic",
    provenance: "agent_verified",
    created_at: "2026-10-01T00:00:00.000Z",
    freshness: { age_days: 10, idle_days: 10, last_accessed_at: null, stale: false },
  };
}

function fakeSearcher(ids: string[]): { fn: SessionSearcher; calls: SearchInput[] } {
  const calls: SearchInput[] = [];
  return {
    fn: async (input) => {
      calls.push(input);
      return ids.map(result);
    },
    calls,
  };
}

function deps(stats: StatsStore, over: Partial<FeedbackCommandDeps> = {}) {
  const prod = fakeSearcher(["d-1", "d-2", "d-3"]);
  const prim = fakeSearcher(["d-3", "d-2", "d-1"]);
  const d: FeedbackCommandDeps = {
    production: prod.fn,
    primary: prim.fn,
    stats,
    loadSupersededAt: async () => new Map(),
    now: NOW,
    newId: () => "fb-test-0001",
    newToken: () => "tok_ABC-123",
    ...over,
  };
  return { d, prod, prim };
}

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function log(stats: StatsStore, at: string, source: "mcp" | "cli", query: string): void {
  stats.logSearch({ at, source, query, filters: { limit: 5 }, results: [{ id: "d-1", rank: 1, score: 1 }] });
}

/** StatsStore のログとアクセスの件数 */
function counts(stats: StatsStore): { searches: number; gets: number; access: number } {
  const l = stats.readLogs("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z");
  const access = [...stats.all().values()].reduce((s, x) => s + x.access_count, 0);
  return { searches: l.searches.length, gets: l.gets.length, access: stats.all().size + access };
}

test("runFeedbackCommand: 過去 7 日 (既定) の source mcp の search だけを材料にする", async () => {
  const { cfg, stats } = tmpCfg();
  log(stats, ago(1), "mcp", "今週の MCP の問い");
  log(stats, ago(6.9), "mcp", "六日前の MCP の問い");
  log(stats, ago(8), "mcp", "八日前の MCP の問い");
  log(stats, ago(2), "cli", "CLI の問い");
  stats.logGet({ at: ago(1), source: "mcp", memory_id: "d-1" });
  const { d, prod, prim } = deps(stats);
  const r = await runFeedbackCommand(cfg, d);
  assert.equal(r.status, "created");
  if (r.status !== "created") return;
  const queries = r.session.items.map((i) => i.query).sort();
  assert.deepEqual(queries, ["今週の MCP の問い", "六日前の MCP の問い"].sort());
  assert.deepEqual(prod.calls.map((c) => c.query).sort(), queries);
  assert.deepEqual(prim.calls.map((c) => c.query).sort(), queries);
  assert.ok(r.session.items.every((i) => i.kind === "real"));
  stats.close();
});

test("runFeedbackCommand: --days で期間を変えられる", async () => {
  const { cfg, stats } = tmpCfg();
  log(stats, ago(1), "mcp", "今週の MCP の問い");
  log(stats, ago(8), "mcp", "八日前の MCP の問い");
  log(stats, ago(20), "mcp", "二十日前の MCP の問い");
  const { d } = deps(stats);
  const r = await runFeedbackCommand(cfg, d, { days: 10 });
  assert.equal(r.status, "created");
  if (r.status !== "created") return;
  assert.deepEqual(r.session.items.map((i) => i.query).sort(), ["今週の MCP の問い", "八日前の MCP の問い"].sort());
  await assert.rejects(runFeedbackCommand(cfg, d, { days: 0 }));
  stats.close();
});

test("runFeedbackCommand: セッションが <evalDir>/sessions/ にでき、URL が http://<host>:<port>/feedback/<id>?t=<token>", async () => {
  const { cfg, stats } = tmpCfg();
  log(stats, ago(1), "mcp", "URL を確かめる問い");
  const { d } = deps(stats);
  const r = await runFeedbackCommand(cfg, d);
  assert.equal(r.status, "created");
  if (r.status !== "created") return;
  assert.equal(r.url, "http://127.0.0.1:17820/feedback/fb-test-0001?t=tok_ABC-123");
  assert.ok(existsSync(join(cfg.eval.dir, SESSIONS_DIR, "fb-test-0001.json")));
  const saved = await loadSession(cfg.eval.dir, "fb-test-0001");
  assert.equal(saved?.token, "tok_ABC-123");
  assert.equal(saved?.status, "open");
  assert.equal(saved?.items.length, 1);
  stats.close();
});

test("runFeedbackCommand: 問いが 0 件なら「今週は判定する問いがありません」を返し、セッションを作らない", async () => {
  const { cfg, stats } = tmpCfg();
  log(stats, ago(2), "cli", "CLI の問いだけ");
  log(stats, ago(30), "mcp", "古い MCP の問いだけ");
  // 評価セットの問いはどれも人のラベル付き (埋める問いにならない)
  await writeEvalSet(cfg.eval.dir, [
    {
      qid: "h-0001",
      query: "判定済みの問い",
      asked_at: ago(40),
      kind: "real",
      labels: [{ source: "human", labeled_at: ago(39), session_id: "fb-old", relevant: { "d-1": 2 } }],
    },
  ]);
  const { d, prod } = deps(stats);
  const r = await runFeedbackCommand(cfg, d);
  assert.deepEqual(r, { status: "empty", message: NO_QUESTIONS_MESSAGE });
  assert.equal(NO_QUESTIONS_MESSAGE, "今週は判定する問いがありません");
  assert.equal(prod.calls.length, 0);
  const sessions = join(cfg.eval.dir, SESSIONS_DIR);
  assert.ok(!existsSync(sessions) || readdirSync(sessions).length === 0);
  stats.close();
});

test("runFeedbackCommand: ログが無くても人のラベルが無い評価セットの問いで作る", async () => {
  const { cfg, stats } = tmpCfg();
  await writeEvalSet(cfg.eval.dir, [
    {
      qid: "s-01",
      query: "合成の問い",
      asked_at: ago(40),
      kind: "synthetic",
      labels: [{ source: "agent", labeled_at: ago(40), relevant: { "d-1": 2 } }],
    },
  ]);
  const { d } = deps(stats);
  const r = await runFeedbackCommand(cfg, d);
  assert.equal(r.status, "created");
  if (r.status !== "created") return;
  assert.deepEqual(r.session.items.map((i) => i.qid), ["s-01"]);
  stats.close();
});

test("runFeedbackCommand: StatsStore のログとアクセスが増えない", async () => {
  const { cfg, stats, dbPath } = tmpCfg();
  log(stats, ago(1), "mcp", "ログを増やさない問い");
  log(stats, ago(3), "mcp", "もう一つの問い");
  stats.logGet({ at: ago(1), source: "mcp", memory_id: "d-1" });
  stats.recordAccess("d-1", ago(1));
  const before = counts(stats);
  const { d } = deps(stats);
  const r = await runFeedbackCommand(cfg, d);
  assert.equal(r.status, "created");
  assert.deepEqual(counts(stats), before);
  stats.close();
  // ファイルから開き直しても同じ
  const again = new StatsStore(dbPath);
  assert.deepEqual(counts(again), before);
  again.close();
});

test("notify: Windows 以外では何もせず false", async () => {
  let called = false;
  const ok = await notify(
    { title: "t", body: "b", url: "http://127.0.0.1:1/x" },
    {
      platform: "linux",
      run: async () => {
        called = true;
        return true;
      },
    },
  );
  assert.equal(ok, false);
  assert.equal(called, false);
});

test("notify: Windows では notify-toast.ps1 を powershell.exe で呼び、題・本文・URL を渡す。失敗なら false", async () => {
  const calls: { file: string; args: string[] }[] = [];
  const ok = await notify(
    { title: "題", body: "本文", url: "http://127.0.0.1:1/feedback/x?t=y" },
    {
      platform: "win32",
      run: async (file, args) => {
        calls.push({ file, args });
        return true;
      },
    },
  );
  assert.equal(ok, true);
  assert.equal(calls[0]!.file, "powershell.exe");
  const a = calls[0]!.args;
  assert.equal(a[a.indexOf("-File") + 1], TOAST_SCRIPT);
  assert.ok(TOAST_SCRIPT.replaceAll("\\", "/").endsWith("scripts/notify-toast.ps1"));
  assert.equal(existsSync(TOAST_SCRIPT), true);
  assert.equal(a[a.indexOf("-Title") + 1], "題");
  assert.equal(a[a.indexOf("-Body") + 1], "本文");
  assert.equal(a[a.indexOf("-Url") + 1], "http://127.0.0.1:1/feedback/x?t=y");

  const failed = await notify({ title: "t", body: "b" }, { platform: "win32", run: async () => false });
  assert.equal(failed, false);
  const threw = await notify(
    { title: "t", body: "b" },
    {
      platform: "win32",
      run: async () => {
        throw new Error("x");
      },
    },
  );
  assert.equal(threw, false);
});

test("openCommand: Windows は cmd /c start \"\" \"<url>\"、macOS は open、Linux は xdg-open", () => {
  const url = "http://127.0.0.1:1/feedback/x?t=y";
  assert.deepEqual(openCommand(url, "win32"), { file: "cmd", args: ["/c", `start "" "${url}"`], verbatim: true });
  assert.deepEqual(openCommand(url, "darwin"), { file: "open", args: [url], verbatim: false });
  assert.deepEqual(openCommand(url, "linux"), { file: "xdg-open", args: [url], verbatim: false });
});

test("evalNotice: 見張りの判定・検索の質 (100 点満点)・見直す条件を、専門用語を使わずに本文にする", () => {
  const run = {
    production: { ndcg10: 0.71234, recall5: 0, mrr10: 0 },
    guard: { worse: true, alert: true, reason: "dummy" },
    review: { ready: false },
  } as unknown as EvalRun;
  const n = evalNotice(run);
  assert.match(n.body, /検索の質 71 点 \(100 点満点\)/);
  assert.match(n.body, /悪化の見張り: 悪くなっている \(2 週続けて\)/);
  assert.match(n.body, /設定の見直し: まだ早い/);
  assert.match(n.body, /レポートを確かめてください/);
  assert.doesNotMatch(n.body, /nDCG|ガード|本番|一次スコア/);
  assert.equal(n.url, undefined);

  const ok = evalNotice({ ...run, guard: { worse: false, alert: false, reason: null }, review: { ready: true } } as unknown as EvalRun);
  assert.match(ok.body, /悪化の見張り: 問題なし/);
  assert.match(ok.body, /設定の見直し: 検討の時期/);
  assert.doesNotMatch(ok.body, /レポートを確かめて/);
});
