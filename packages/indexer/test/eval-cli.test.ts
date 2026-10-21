// sm eval / sm eval import-lab の単体テスト。CLI のプロセスも OpenSearch も使わず、
// 一時ディレクトリと偽物の Searcher で eval-command.ts の関数を呼ぶ。
// テストのデータはすべて作ったダミー (本物の記憶の ID・本文は使わない)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_FILE,
  loadConfig,
  questionKey,
  readEvalSet,
  readHistory,
  writeEvalSet,
  type Config,
  type EvalQuestion,
  type MemoryInfo,
  type Searcher,
} from "@shared-memory/core";
import { EMPTY_EVAL_SET_MESSAGE, importLabCommand, localDate, runEvalCommand, type EvalIO } from "../src/eval-command.ts";

const base = loadConfig();

function tmpCfg(): Config {
  const root = mkdtempSync(join(tmpdir(), "sm-eval-cli-"));
  return {
    ...base,
    memories_dir: join(root, "memories"),
    eval: { dir: join(root, "eval") },
    search: { ...base.search, half_life_days: 30 },
  };
}

function capture(): { io: EvalIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
}

function q(qid: string, relevant: Record<string, number>, query = `dummy query ${qid}`): EvalQuestion {
  return {
    qid,
    query,
    asked_at: "2026-10-10T00:00:00.000Z",
    kind: "synthetic",
    labels: [{ source: "agent", labeled_at: "2026-10-10T00:00:00.000Z", relevant }],
  };
}

function fakeSearcher(rankings: Record<string, string[]>): { fn: Searcher; calls: string[] } {
  const calls: string[] = [];
  return {
    fn: async (qq) => {
      calls.push(qq.qid);
      return rankings[qq.qid] ?? [];
    },
    calls,
  };
}

const MEMORIES: ReadonlyMap<string, MemoryInfo> = new Map([
  ["m-a", { created_at: "2026-10-01T00:00:00.000Z" }],
  ["m-b", { created_at: "2026-10-05T00:00:00.000Z" }],
  ["m-c", { created_at: "2026-10-08T00:00:00.000Z", supersedes: "m-a" }],
]);

test("runEvalCommand: 評価セットが空なら案内を出して終了コード 1、検索も memories も呼ばない", async () => {
  const cfg = tmpCfg();
  const c = capture();
  const prod = fakeSearcher({});
  let loaded = false;
  const r = await runEvalCommand(
    cfg,
    {
      production: prod.fn,
      primary: prod.fn,
      loadMemories: async () => {
        loaded = true;
        return MEMORIES;
      },
      io: c.io,
    },
    { json: false },
  );
  assert.equal(r.code, 1);
  assert.deepEqual(c.err, [EMPTY_EVAL_SET_MESSAGE]);
  assert.ok(EMPTY_EVAL_SET_MESSAGE.includes("sm eval import-lab <file>"));
  assert.equal(prod.calls.length, 0);
  assert.equal(loaded, false);
  assert.equal(existsSync(join(cfg.eval.dir, HISTORY_FILE)), false);
});

test("runEvalCommand: 評価を流し、履歴に 1 行足し、ローカル日付のレポートを書き、要約とパスを出す", async () => {
  const cfg = tmpCfg();
  await writeEvalSet(cfg.eval.dir, [
    q("q1", { "m-a": 2 }, "一つ目の問い"),
    q("q2", { "m-b": 2 }, "二つ目の問い"),
    q("q3", {}, "正解の無い問い"),
  ]);
  // 確定したセッションを 1 つ置く (interleaveTotals が数える)
  await mkdir(join(cfg.eval.dir, "sessions"), { recursive: true });
  await writeFile(
    join(cfg.eval.dir, "sessions", "s1.json"),
    JSON.stringify({
      id: "s1",
      token: "t",
      created_at: "2026-10-12T00:00:00.000Z",
      seed: 1,
      status: "confirmed",
      items: [],
      draft: {},
      confirmed_at: "2026-10-12T01:00:00.000Z",
      outcomes: { x1: "a", x2: "a", x3: "b", x4: "tie" },
    }),
  );
  const prod = fakeSearcher({ q1: ["m-a", "m-b"], q2: ["m-c", "m-b"] });
  const prim = fakeSearcher({ q1: ["m-b", "m-a"], q2: ["m-b", "m-c"] });
  const now = new Date(2026, 9, 21, 23, 30); // ローカル時刻の 10 月 21 日 23:30
  const c = capture();
  const r = await runEvalCommand(
    cfg,
    { production: prod.fn, primary: prim.fn, loadMemories: async () => MEMORIES, now, io: c.io },
    { json: false },
  );
  assert.equal(r.code, 0);
  assert.deepEqual(prod.calls, ["q1", "q2"]);
  assert.deepEqual(prim.calls, ["q1", "q2"]);

  const history = await readHistory(cfg.eval.dir);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.n, 2);
  assert.deepEqual(
    { wins: history[0]!.interleave.wins, losses: history[0]!.interleave.losses, ties: history[0]!.interleave.ties },
    { wins: 2, losses: 1, ties: 1 },
  );

  assert.equal(localDate(now), "2026-10-21");
  const reportPath = join(cfg.eval.dir, "reports", "2026-10-21.md");
  assert.equal(r.reportPath, reportPath);
  const md = await readFile(reportPath, "utf8");
  assert.match(md, /# 評価レポート/);
  assert.ok(md.includes("二つ目の問い")); // q2 は一次スコアだけが良い
  assert.ok(!md.includes("一つ目の問い |"));

  const text = c.out.join("\n");
  assert.match(text, /正解のある問い 2 件/);
  assert.ok(text.includes(`レポート: ${reportPath}`));

  // 2 回目は履歴に足される
  await runEvalCommand(
    cfg,
    { production: prod.fn, primary: prim.fn, loadMemories: async () => MEMORIES, now, io: capture().io },
    { json: false },
  );
  assert.equal((await readHistory(cfg.eval.dir)).length, 2);
});

test("runEvalCommand: --json なら run を JSON で出す。警告が出ても終了コード 0", async () => {
  const cfg = tmpCfg();
  const qs = Array.from({ length: 6 }, (_, i) => q(`q${i}`, { "m-a": 2 }));
  await writeEvalSet(cfg.eval.dir, qs);
  // 本番がいつも外し、一次スコアだけがいつも当てる → worse
  const prod = fakeSearcher(Object.fromEntries(qs.map((x) => [x.qid, ["m-b"]])));
  const prim = fakeSearcher(Object.fromEntries(qs.map((x) => [x.qid, ["m-a"]])));
  const deps = { production: prod.fn, primary: prim.fn, loadMemories: async () => MEMORIES };
  await runEvalCommand(cfg, { ...deps, io: capture().io }, { json: false });
  const c = capture();
  const r = await runEvalCommand(cfg, { ...deps, io: c.io }, { json: true });
  assert.equal(r.code, 0);
  assert.equal(c.out.length, 1);
  const run = JSON.parse(c.out[0]!);
  assert.equal(run.n, 6);
  assert.equal(run.guard.worse, true);
  assert.equal(run.guard.alert, true);
  assert.deepEqual(run, r.run);
});

test("importLabCommand: lab の JSONL を取り込み、既にある問いは questionKey で重複させず、件数を出す", async () => {
  const cfg = tmpCfg();
  await writeEvalSet(cfg.eval.dir, [q("h-0001", { "m-a": 2 }, "既にある  問い")]);
  const file = join(cfg.eval.dir, "..", "lab-eval.jsonl");
  const lines = [
    { qid: "s01", set: "synthetic", query: "既にある 問い", relevant: { "m-a": 2 } }, // questionKey が同じ
    { qid: "s02", set: "synthetic", query: "新しい問い", relevant: { "m-b": 2, "m-c": 0 } },
    { qid: "r01", set: "real", query: "本物風の問い", relevant: { "m-c": 1 } },
    { qid: "r02", set: "real", query: "  新しい問い ", relevant: { "m-b": 1 } }, // ファイルの中で重複
  ];
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const c = capture();
  const r = await importLabCommand(cfg, file, { json: false, io: c.io });
  assert.deepEqual({ code: r.code, added: r.added, skipped: r.skipped, total: r.total }, {
    code: 0,
    added: 2,
    skipped: 2,
    total: 3,
  });
  assert.match(c.out.join("\n"), /取り込み 2 件 \/ 既にある問い 2 件 \/ 評価セット 3 件/);

  const set = await readEvalSet(cfg.eval.dir);
  assert.deepEqual(set.map((x) => x.qid), ["h-0001", "s02", "r01"]);
  assert.equal(new Set(set.map((x) => questionKey(x.query, x.filters))).size, 3);
  const s02 = set.find((x) => x.qid === "s02")!;
  assert.equal(s02.kind, "synthetic");
  assert.equal(s02.labels[0]!.source, "agent");
  assert.deepEqual(s02.labels[0]!.relevant, { "m-b": 2 });
  assert.equal(set.find((x) => x.qid === "r01")!.kind, "real");

  // もう一度取り込んでも増えない
  const c2 = capture();
  const r2 = await importLabCommand(cfg, file, { json: true, io: c2.io });
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, 4);
  const j = JSON.parse(c2.out[0]!);
  assert.deepEqual({ added: j.added, skipped: j.skipped, total: j.total }, { added: 0, skipped: 4, total: 3 });
  assert.equal((await readEvalSet(cfg.eval.dir)).length, 3);
});

test("importLabCommand: 評価セットが無くても取り込める (60 問)", async () => {
  const cfg = tmpCfg();
  const file = join(cfg.eval.dir, "..", "lab-60.jsonl");
  const lines = Array.from({ length: 60 }, (_, i) =>
    JSON.stringify({ qid: `s${i}`, set: i < 40 ? "synthetic" : "real", query: `問い ${i}`, relevant: { [`m-${i}`]: 2 } }),
  );
  await mkdir(join(cfg.eval.dir, ".."), { recursive: true });
  await writeFile(file, lines.join("\n"));
  const r = await importLabCommand(cfg, file, { json: false, io: capture().io });
  assert.equal(r.added, 60);
  assert.equal((await readEvalSet(cfg.eval.dir)).length, 60);
});
