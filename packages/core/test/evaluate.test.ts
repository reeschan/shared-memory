import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalLabel, EvalQuestion } from "../src/evalset.ts";
import {
  HISTORY_FILE,
  appendHistory,
  isoWeek,
  readHistory,
  runEvaluation,
  type EvalRun,
  type MemoryInfo,
  type Searcher,
} from "../src/evaluate.ts";
import type { AsOf } from "../src/search.ts";

// テストのデータはすべて作ったダミー (本物の記憶の ID・本文は使わない)

const NOW = new Date("2026-10-21T00:00:00.000Z");

function agent(relevant: Record<string, number>, extra: Partial<EvalLabel> = {}): EvalLabel {
  return { source: "agent", labeled_at: "2026-10-01T00:00:00.000Z", relevant, ...extra };
}
function human(relevant: Record<string, number>, extra: Partial<EvalLabel> = {}): EvalLabel {
  return { source: "human", labeled_at: "2026-10-02T00:00:00.000Z", session_id: "s-1", relevant, ...extra };
}
function q(qid: string, labels: EvalLabel[], extra: Partial<EvalQuestion> = {}): EvalQuestion {
  return { qid, query: `query ${qid}`, asked_at: "2026-10-10T00:00:00.000Z", kind: "synthetic", labels, ...extra };
}
/** qid ごとに決まった順位を返す偽物の Searcher。呼ばれた (q, asOf) を記録する */
function fake(rankings: Record<string, string[]>, fallback: string[] = []) {
  const calls: { qid: string; asOf: AsOf }[] = [];
  const fn: Searcher = async (qq, asOf) => {
    calls.push({ qid: qq.qid, asOf });
    return rankings[qq.qid] ?? fallback;
  };
  return { fn, calls };
}
function mems(entries: [string, string, string?][]): Map<string, MemoryInfo> {
  const m = new Map<string, MemoryInfo>();
  for (const [id, created_at, supersedes] of entries) {
    const info: MemoryInfo = { created_at };
    if (supersedes !== undefined) info.supersedes = supersedes;
    m.set(id, info);
  }
  return m;
}
const NO_IL = { wins: 0, losses: 0, ties: 0 };

function base(over: Partial<Parameters<typeof runEvaluation>[0]> = {}): Parameters<typeof runEvaluation>[0] {
  return {
    questions: [],
    production: fake({}).fn,
    primary: fake({}).fn,
    memories: new Map(),
    history: [],
    interleave: NO_IL,
    halfLifeDays: 30,
    now: NOW,
    ...over,
  };
}

/** 本番が毎回 0、一次スコアだけが毎回 1 になる 5 問 */
function worseSetup() {
  const questions = ["a", "b", "c", "d", "e"].map((k) => q(`q-${k}`, [agent({ [`m-${k}`]: 2 })]));
  const prim: Record<string, string[]> = {};
  for (const k of ["a", "b", "c", "d", "e"]) prim[`q-${k}`] = [`m-${k}`];
  return { questions, production: fake({}, ["m-x"]).fn, primary: fake(prim).fn };
}

test("isoWeek: 月曜始まり・1 月 4 日を含む週が第 1 週", () => {
  assert.equal(isoWeek(new Date("2026-10-21T12:00:00Z")), "2026-W43");
  assert.equal(isoWeek(new Date("2026-10-19T00:00:00Z")), "2026-W43"); // 月曜
  assert.equal(isoWeek(new Date("2026-10-18T23:59:59Z")), "2026-W42"); // 日曜
  assert.equal(isoWeek(new Date("2021-01-03T00:00:00Z")), "2020-W53");
  assert.equal(isoWeek(new Date("2024-12-30T00:00:00Z")), "2025-W01");
  assert.equal(isoWeek(new Date("2026-01-04T00:00:00Z")), "2026-W01");
});

test("正解の無い問い (ラベル無し・relevant が空) は n に数えず、検索もしない", async () => {
  const prod = fake({ "q-1": ["m-1"] });
  const prim = fake({ "q-1": ["m-1"] });
  const { run, perQuestion } = await runEvaluation(
    base({
      questions: [q("q-1", [agent({ "m-1": 2 })]), q("q-2", []), q("q-3", [agent({})]), q("q-4", [human({ "m-0": 0 })])],
      production: prod.fn,
      primary: prim.fn,
    }),
  );
  assert.equal(run.n, 1);
  assert.deepEqual(perQuestion.map((p) => p.qid), ["q-1"]);
  assert.deepEqual(prod.calls.map((c) => c.qid), ["q-1"]);
  assert.deepEqual(prim.calls.map((c) => c.qid), ["q-1"]);
});

test("正解のある問いが 0 件でも例外にならず、worse にならない", async () => {
  const { run } = await runEvaluation(base({ questions: [q("q-1", [])] }));
  assert.equal(run.n, 0);
  assert.equal(run.guard.worse, false);
  assert.equal(run.guard.alert, false);
  assert.equal(run.guard.reason, null);
  assert.equal(run.at, NOW.toISOString());
});

test("Searcher に渡る asOf.at は q.asked_at、supersededAt は memories の supersedes から作られる", async () => {
  const memories = mems([
    ["m-old", "2026-09-01T00:00:00.000Z"],
    ["m-new", "2026-10-05T00:00:00.000Z", "m-old"],
    ["m-newer", "2026-10-03T00:00:00.000Z", "m-old"],
    ["m-solo", "2026-09-10T00:00:00.000Z"],
  ]);
  const prod = fake({});
  const prim = fake({});
  await runEvaluation(
    base({
      questions: [
        q("q-1", [agent({ "m-new": 2 })], { asked_at: "2026-10-06T00:00:00.000Z" }),
        q("q-2", [agent({ "m-solo": 1 })], { asked_at: "2026-09-20T12:00:00.000Z" }),
      ],
      production: prod.fn,
      primary: prim.fn,
      memories,
    }),
  );
  for (const calls of [prod.calls, prim.calls]) {
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.asOf.at.toISOString(), "2026-10-06T00:00:00.000Z");
    assert.equal(calls[1]!.asOf.at.toISOString(), "2026-09-20T12:00:00.000Z");
    // 置き換えた側の created_at のうち最も早いもの
    assert.deepEqual([...calls[0]!.asOf.supersededAt], [["m-old", "2026-10-03T00:00:00.000Z"]]);
  }
});

test("人とエージェントのラベルがあると人の relevant で採点される", async () => {
  const { perQuestion, run } = await runEvaluation(
    base({
      questions: [q("q-1", [agent({ "m-a": 2 }), human({ "m-h": 2 }), agent({ "m-a2": 2 })])],
      production: fake({}, ["m-h"]).fn,
      primary: fake({}, ["m-a", "m-a2"]).fn,
    }),
  );
  assert.equal(perQuestion[0]!.production.ndcg10, 1);
  assert.equal(perQuestion[0]!.primary.ndcg10, 0);
  assert.equal(run.review.human_n, 1);
});

test("diff.mean は 本番 − 一次スコアだけ、production / primary は問いの平均", async () => {
  // q-1: 本番 1・一次 0、q-2: 本番 1・一次 1 → mean = 0.5
  const { run } = await runEvaluation(
    base({
      questions: [q("q-1", [agent({ "m-1": 2 })]), q("q-2", [agent({ "m-2": 2 })])],
      production: fake({ "q-1": ["m-1"], "q-2": ["m-2"] }).fn,
      primary: fake({ "q-1": ["m-x"], "q-2": ["m-2"] }).fn,
    }),
  );
  assert.equal(run.diff.mean, 0.5);
  assert.equal(run.production.ndcg10, 1);
  assert.equal(run.primary.ndcg10, 0.5);
  assert.equal(run.primary.recall5, 0.5);
  assert.equal(run.primary.mrr10, 0.5);
  assert.equal(run.guard.worse, false);
});

test("区間の上端が 0 未満のときだけ worse。1 回目は alert にならず、history の最後も worse なら alert", async () => {
  const s = worseSetup();
  const first = await runEvaluation(base({ ...s }));
  assert.ok(first.run.diff.hi < 0);
  assert.equal(first.run.guard.worse, true);
  assert.equal(first.run.guard.alert, false);
  assert.equal(typeof first.run.guard.reason, "string");

  const second = await runEvaluation(base({ ...s, history: [first.run] }));
  assert.equal(second.run.guard.worse, true);
  assert.equal(second.run.guard.alert, true);

  // history の最後が worse でなければ alert にならない (前のほうが worse でも)
  const okRun: EvalRun = { ...first.run, guard: { worse: false, alert: false, reason: null } };
  const third = await runEvaluation(base({ ...s, history: [first.run, okRun] }));
  assert.equal(third.run.guard.alert, false);

  // 同じ順位なら差は 0 で上端も 0 → worse にならない
  const same = await runEvaluation(base({ questions: s.questions, production: s.primary, primary: s.primary, history: [first.run] }));
  assert.equal(same.run.diff.hi, 0);
  assert.equal(same.run.guard.worse, false);
  assert.equal(same.run.guard.alert, false);
});

test("interleave で b が有意に勝つと alert。有意でない・a が勝つときは alert にならない", async () => {
  const qs = [q("q-1", [agent({ "m-1": 2 })])];
  const sig = await runEvaluation(base({ questions: qs, interleave: { wins: 1, losses: 12, ties: 3 } }));
  assert.ok(sig.run.interleave.p < 0.05);
  assert.deepEqual(
    { wins: sig.run.interleave.wins, losses: sig.run.interleave.losses, ties: sig.run.interleave.ties },
    { wins: 1, losses: 12, ties: 3 },
  );
  assert.equal(sig.run.guard.worse, false);
  assert.equal(sig.run.guard.alert, true);
  assert.equal(sig.run.review.signal, true);

  const notSig = await runEvaluation(base({ questions: qs, interleave: { wins: 3, losses: 5, ties: 0 } }));
  assert.ok(notSig.run.interleave.p >= 0.05);
  assert.equal(notSig.run.guard.alert, false);

  const aWins = await runEvaluation(base({ questions: qs, interleave: { wins: 12, losses: 1, ties: 0 } }));
  assert.equal(aWins.run.guard.alert, false);
});

test("supersedes の相手が上位に出た問いは fresh になり、newer_above_rate は組の数から出る", async () => {
  const memories = mems([
    ["m-o1", "2026-09-01T00:00:00.000Z"],
    ["m-g1", "2026-10-01T00:00:00.000Z", "m-o1"],
    ["m-o2", "2026-09-01T00:00:00.000Z"],
    ["m-g2", "2026-10-01T00:00:00.000Z", "m-o2"],
    ["m-g3", "2026-10-01T00:00:00.000Z"],
    ["m-s3", "2026-09-01T00:00:00.000Z"],
    ["m-g4", "2026-10-01T00:00:00.000Z", "m-o4"],
    ["m-o4", "2026-09-01T00:00:00.000Z"],
    ["m-g5", "2026-10-01T00:00:00.000Z"],
  ]);
  const questions = [
    // 本番で古いほうが上 → 組 1 (下)
    q("q-1", [agent({ "m-g1": 2 })]),
    // 一次スコアだけの上位にだけ古いほうが出る → fresh。本番には古いほうが無いので組にならない
    q("q-2", [agent({ "m-g2": 2 })]),
    // stale_ids が空でない → fresh。本番で新しいほうが上 → 組 1 (上)
    q("q-3", [human({ "m-g3": 2 }, { stale_ids: ["m-s3"] })]),
    // freshness_sensitive。新しいほうが上 → 組 1 (上)
    q("q-4", [agent({ "m-g4": 2 })], { freshness_sensitive: true }),
    // supersedes の相手が無い・出ていない → fresh でない
    q("q-5", [agent({ "m-g5": 2 })]),
  ];
  const production = fake({
    "q-1": ["m-o1", "m-g1"],
    "q-2": ["m-g2"],
    "q-3": ["m-g3", "x", "m-s3"],
    "q-4": ["m-g4", "m-o4"],
    "q-5": ["m-g5"],
  }).fn;
  const primary = fake({
    "q-1": ["m-g1"],
    "q-2": ["m-g2", "m-o2"],
    "q-3": ["m-g3"],
    "q-4": ["m-g4"],
    "q-5": ["m-g5"],
  }).fn;
  const { run, perQuestion } = await runEvaluation(base({ questions, production, primary, memories }));
  assert.deepEqual(
    perQuestion.map((p) => [p.qid, p.fresh]),
    [["q-1", true], ["q-2", true], ["q-3", true], ["q-4", true], ["q-5", false]],
  );
  assert.equal(run.freshness.n, 4);
  assert.equal(run.freshness.newer_above_rate, 2 / 3);
  const freshProd = perQuestion.filter((p) => p.fresh).map((p) => p.production.ndcg10);
  assert.equal(run.freshness.production_ndcg10, freshProd.reduce((s, x) => s + x, 0) / 4);
  assert.equal(run.review.fresh_n, 1); // human かつ fresh は q-3 だけ
  assert.equal(run.review.signal, false); // 2/3 >= 0.6

  // fresh な問いが無ければ null
  const none = await runEvaluation(
    base({ questions: [questions[4]!], production, primary, memories }),
  );
  assert.equal(none.run.freshness.n, 0);
  assert.equal(none.run.freshness.newer_above_rate, null);
  assert.equal(none.run.freshness.production_ndcg10, null);
  assert.equal(none.run.freshness.primary_ndcg10, null);
});

test("created_dist の週は ISO 週で間も埋まり、corpus と gold の数が合う", async () => {
  const memories = mems([
    ["m-1", "2026-10-19T00:00:00.000Z"], // W43 (月曜)
    ["m-2", "2026-10-25T23:00:00.000Z"], // W43 (日曜)
    ["m-3", "2026-10-18T10:00:00.000Z"], // W42 (日曜)
    ["m-4", "2026-11-02T00:00:00.000Z"], // W45
  ]);
  const { run } = await runEvaluation(
    base({
      questions: [q("q-1", [agent({ "m-1": 2, "m-4": 1 })]), q("q-2", [agent({ "m-1": 1, "m-3": 2 })])],
      memories,
    }),
  );
  assert.deepEqual(run.created_dist, {
    weeks: ["2026-W42", "2026-W43", "2026-W44", "2026-W45"],
    corpus: [1, 2, 0, 1],
    gold: [1, 1, 0, 1],
  });
  assert.equal(run.created_dist.corpus.reduce((s, x) => s + x, 0), memories.size);
  assert.equal(run.created_dist.gold.reduce((s, x) => s + x, 0), 3); // m-1, m-3, m-4 (重複なし)
});

/** review の 4 条件をそろえた入力。human の問い humanN 件のうち freshN 件を fresh にする */
function reviewSetup(opts: { humanN: number; freshN: number; spanDays: number; olderAbove: boolean }) {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const memories = mems([
    ["m-first", new Date(start).toISOString()],
    ["m-last", new Date(start + opts.spanDays * 86_400_000).toISOString()],
    ["m-old", "2026-01-02T00:00:00.000Z"],
    ["m-new", "2026-01-03T00:00:00.000Z", "m-old"],
  ]);
  const questions: EvalQuestion[] = [];
  const rankings: Record<string, string[]> = {};
  for (let i = 0; i < opts.humanN; i++) {
    const qid = `q-${i}`;
    if (i < opts.freshN) {
      questions.push(q(qid, [human({ "m-new": 2 })], { freshness_sensitive: true }));
      rankings[qid] = opts.olderAbove ? ["m-old", "m-new"] : ["m-new", "m-old"];
    } else {
      questions.push(q(qid, [human({ "m-first": 2 })]));
      rankings[qid] = ["m-first"];
    }
  }
  const s = fake(rankings);
  return { questions, memories, production: s.fn, primary: s.fn, halfLifeDays: 10 };
}

test("review の 4 条件と ready の判定", async () => {
  const ok = await runEvaluation(base(reviewSetup({ humanN: 150, freshN: 30, spanDays: 20, olderAbove: true })));
  assert.deepEqual(ok.run.review, {
    span_days: 20,
    span_ok: true,
    human_n: 150,
    human_ok: true,
    fresh_n: 30,
    fresh_ok: true,
    signal: true, // newer_above_rate = 0 < 0.6
    ready: true,
  });
  assert.equal(ok.run.freshness.newer_above_rate, 0);

  const span = await runEvaluation(base(reviewSetup({ humanN: 150, freshN: 30, spanDays: 19.5, olderAbove: true })));
  assert.equal(span.run.review.span_ok, false);
  assert.equal(span.run.review.ready, false);

  const fewHuman = await runEvaluation(base(reviewSetup({ humanN: 149, freshN: 30, spanDays: 20, olderAbove: true })));
  assert.equal(fewHuman.run.review.human_ok, false);
  assert.equal(fewHuman.run.review.ready, false);

  const fewFresh = await runEvaluation(base(reviewSetup({ humanN: 150, freshN: 29, spanDays: 20, olderAbove: true })));
  assert.equal(fewFresh.run.review.fresh_ok, false);
  assert.equal(fewFresh.run.review.ready, false);

  const noSignal = await runEvaluation(base(reviewSetup({ humanN: 150, freshN: 30, spanDays: 20, olderAbove: false })));
  assert.equal(noSignal.run.freshness.newer_above_rate, 1);
  assert.equal(noSignal.run.review.signal, false);
  assert.equal(noSignal.run.review.ready, false);

  // agent のラベルの問いは human_n に数えない
  const agentOnly = await runEvaluation(
    base({ questions: [q("q-a", [agent({ "m-1": 2 })], { freshness_sensitive: true })] }),
  );
  assert.equal(agentOnly.run.review.human_n, 0);
  assert.equal(agentOnly.run.review.fresh_n, 0);
});

test("appendHistory したものを readHistory で同じ順に読める。無ければ []、dir が無ければ作る", async () => {
  const root = mkdtempSync(join(tmpdir(), "sm-eval-"));
  const dir = join(root, "nested", "eval");
  assert.deepEqual(await readHistory(dir), []);
  const s = worseSetup();
  const r1 = (await runEvaluation(base({ ...s, now: new Date("2026-10-20T00:00:00.000Z") }))).run;
  const r2 = (await runEvaluation(base({ ...s, history: [r1] }))).run;
  await appendHistory(dir, r1);
  assert.ok(existsSync(join(dir, HISTORY_FILE)));
  await appendHistory(dir, r2);
  const back = await readHistory(dir);
  assert.deepEqual(back, [r1, r2]);
  assert.equal(back[1]!.guard.alert, true);
});

test("readHistory は guard などの欄が無い行を、行番号と欄の名前入りの Error にする", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-eval-"));
  const s = worseSetup();
  const r1 = (await runEvaluation(base({ ...s, now: new Date("2026-10-20T00:00:00.000Z") }))).run;
  await appendHistory(dir, r1);
  const { guard: _guard, ...noGuard } = r1;
  await appendFile(join(dir, HISTORY_FILE), JSON.stringify(noGuard) + "\n");
  await assert.rejects(readHistory(dir), /2 行目に guard がありません/);
  await writeFile(join(dir, HISTORY_FILE), "[1, 2]\n");
  await assert.rejects(readHistory(dir), /1 行目に 実行の記録/);
});
