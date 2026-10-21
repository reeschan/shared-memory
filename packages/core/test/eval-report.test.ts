import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvalQuestion } from "../src/evalset.ts";
import type { EvalRun, PerQuestion } from "../src/evaluate.ts";
import { renderReport, summaryLines } from "../src/eval-report.ts";

// テストのデータはすべて作ったダミー (本物の記憶の ID・本文は使わない)

function baseRun(over: Partial<EvalRun> = {}): EvalRun {
  return {
    at: "2026-10-21T00:00:00.000Z",
    n: 12,
    production: { ndcg10: 0.8123, recall5: 0.7456, mrr10: 0.6789 },
    primary: { ndcg10: 0.7011, recall5: 0.6522, mrr10: 0.5933 },
    diff: { mean: 0.1112, lo: 0.0234, hi: 0.2046, win: 7, lose: 2, tie: 3 },
    guard: { worse: false, alert: false, reason: null },
    interleave: { wins: 9, losses: 4, ties: 2, p: 0.2668 },
    freshness: { n: 3, production_ndcg10: 0.9001, primary_ndcg10: 0.5002, newer_above_rate: 0.75 },
    created_dist: { weeks: ["2026-W40", "2026-W41", "2026-W42"], corpus: [5, 0, 8], gold: [2, 0, 3] },
    review: {
      span_days: 20.5,
      span_ok: false,
      human_n: 40,
      human_ok: false,
      fresh_n: 3,
      fresh_ok: false,
      signal: false,
      ready: false,
    },
    ...over,
  };
}

function pq(qid: string, prod: number, prim: number, fresh = false): PerQuestion {
  return {
    qid,
    fresh,
    production: { ndcg10: prod, recall5: 0, mrr10: 0 },
    primary: { ndcg10: prim, recall5: 0, mrr10: 0 },
  };
}

function question(qid: string, query: string): EvalQuestion {
  return { qid, query, asked_at: "2026-10-10T00:00:00.000Z", kind: "synthetic", labels: [] };
}

test("renderReport: 本番と一次スコアだけの 3 指標、差と 95% 区間", () => {
  const md = renderReport(baseRun(), [], []);
  assert.match(md, /\| 本番 \| 0\.812 \| 0\.746 \| 0\.679 \|/);
  assert.match(md, /\| 一次スコアだけ \| 0\.701 \| 0\.652 \| 0\.593 \|/);
  assert.match(md, /nDCG@10/);
  assert.match(md, /Recall@5/);
  assert.match(md, /MRR@10/);
  assert.match(md, /差 \(本番 - 一次スコアだけ\): \+0\.111 \(95% 区間 \+0\.023 〜 \+0\.205\)/);
});

test("renderReport: ガードの判定 (警告なし / 警告ありと理由)", () => {
  const ok = renderReport(baseRun(), [], []);
  assert.match(ok, /- 警告: なし/);
  assert.match(ok, /- 理由: なし/);
  const reason = "本番の nDCG@10 が一次スコアだけより、2 回続けて有意に低い";
  const bad = renderReport(
    baseRun({
      diff: { mean: -0.2, lo: -0.3, hi: -0.05, win: 1, lose: 8, tie: 3 },
      guard: { worse: true, alert: true, reason },
    }),
    [],
    [],
  );
  assert.match(bad, /- 警告: あり/);
  assert.match(bad, /有意に低い .*: はい/);
  assert.ok(bad.includes(`- 理由: ${reason}`));
  assert.match(bad, /95% 区間 -0\.300 〜 -0\.050/);
});

test("renderReport: インターリービングの累計と p 値", () => {
  const md = renderReport(baseRun(), [], []);
  assert.match(md, /本番の勝ち 9 \/ 一次スコアだけの勝ち 4 \/ 引き分け 2/);
  assert.match(md, /p 値: 0\.2668/);
});

test("renderReport: 鮮度が効く問いの指標。null は「該当なし」", () => {
  const md = renderReport(baseRun(), [], []);
  assert.match(md, /問いの数: 3 件/);
  assert.match(md, /\| 本番の nDCG@10 \| 0\.900 \|/);
  assert.match(md, /\| 一次スコアだけの nDCG@10 \| 0\.500 \|/);
  assert.match(md, /上に出た割合 \(本番\) \| 0\.750 \|/);

  const none = renderReport(
    baseRun({ freshness: { n: 0, production_ndcg10: null, primary_ndcg10: null, newer_above_rate: null } }),
    [],
    [],
  );
  assert.match(none, /\| 本番の nDCG@10 \| 該当なし \|/);
  assert.match(none, /\| 一次スコアだけの nDCG@10 \| 該当なし \|/);
  assert.match(none, /上に出た割合 \(本番\) \| 該当なし \|/);
});

test("renderReport: 週ごとの作成日の分布 (検索対象と正解)", () => {
  const md = renderReport(baseRun(), [], []);
  assert.match(md, /\| 週 \| 検索対象 \| 正解 \|/);
  assert.match(md, /\| 2026-W40 \| 5 \| 2 \|/);
  assert.match(md, /\| 2026-W41 \| 0 \| 0 \|/);
  assert.match(md, /\| 2026-W42 \| 8 \| 3 \|/);
  const empty = renderReport(baseRun({ created_dist: { weeks: [], corpus: [], gold: [] } }), [], []);
  assert.match(empty, /## 作成日の分布 \(週ごと\)\n\n該当なし/);
});

test("renderReport: 見直す条件の 4 つとそろっているか", () => {
  const md = renderReport(baseRun(), [], []);
  assert.match(md, /作成日の幅が半減期の 2 倍以上 \| 20\.5 日 \| いいえ \|/);
  assert.match(md, /人のラベルの問いが 150 以上 \| 40 \| いいえ \|/);
  assert.match(md, /鮮度が効く問いが 30 以上 \| 3 \| いいえ \|/);
  assert.match(md, /\| 合図 .*\| いいえ \|/);
  assert.match(md, /4 つそろっているか: そろっていない/);

  const ready = renderReport(
    baseRun({
      review: {
        span_days: 200,
        span_ok: true,
        human_n: 160,
        human_ok: true,
        fresh_n: 35,
        fresh_ok: true,
        signal: true,
        ready: true,
      },
    }),
    [],
    [],
  );
  assert.match(ready, /作成日の幅が半減期の 2 倍以上 \| 200\.0 日 \| はい \|/);
  assert.match(ready, /人のラベルの問いが 150 以上 \| 160 \| はい \|/);
  assert.match(ready, /鮮度が効く問いが 30 以上 \| 35 \| はい \|/);
  assert.match(ready, /\| 合図 .*\| はい \|/);
  assert.match(ready, /4 つそろっているか: そろっている/);
});

test("renderReport: アクセスの項は評価の時点の値で、漏れを含む、の注意", () => {
  const md = renderReport(baseRun(), [], []);
  assert.ok(md.includes("アクセスの項は評価の時点の値で、漏れを含む"));
});

test("renderReport: 本番より一次スコアだけが良かった問いを、差の大きい順に最大 10 件、問いの文と差で", () => {
  const per: PerQuestion[] = [];
  const qs: EvalQuestion[] = [];
  // 一次スコアだけが良い問いを 12 件 (差 -0.01 … -0.12)、本番が良い問い・同じ問いを 1 件ずつ
  for (let i = 1; i <= 12; i++) {
    const qid = `q${String(i).padStart(2, "0")}`;
    per.push(pq(qid, 0.5, 0.5 + i / 100));
    qs.push(question(qid, `ダミーの問い ${i}`));
  }
  per.push(pq("qbetter", 0.9, 0.1));
  qs.push(question("qbetter", "本番が良い問い"));
  per.push(pq("qsame", 0.4, 0.4));
  qs.push(question("qsame", "同じ問い"));
  per.push(pq("qpipe", 0.1, 0.105));
  qs.push(question("qpipe", "縦棒 | を含む"));

  const md = renderReport(baseRun(), per, qs);
  const section = md.split("## 本番より一次スコアだけが良かった問い")[1]!;
  const rows = section.split("\n").filter((l) => l.startsWith("| q") && !l.startsWith("| qid "));
  assert.equal(rows.length, 10);
  assert.equal(rows[0], "| q12 | ダミーの問い 12 | -0.120 |");
  assert.equal(rows[9], "| q03 | ダミーの問い 3 | -0.030 |");
  assert.ok(!section.includes("本番が良い問い"));
  assert.ok(!section.includes("同じ問い"));
  assert.ok(!section.includes("ダミーの問い 2 |"));

  const few = renderReport(baseRun(), [pq("qpipe", 0.1, 0.105)], qs);
  assert.ok(few.includes("| qpipe | 縦棒 \\| を含む | -0.005 |"));

  const none = renderReport(baseRun(), [pq("qbetter", 0.9, 0.1)], qs);
  assert.match(none, /## 本番より一次スコアだけが良かった問い[^\n]*\n\n該当なし/);
});

test("summaryLines: 数行の要約に指標・ガード・インターリービング・見直す条件が入る", () => {
  const lines = summaryLines(baseRun());
  assert.ok(lines.length >= 4 && lines.length <= 10);
  const text = lines.join("\n");
  assert.match(text, /正解のある問い 12 件/);
  assert.match(text, /nDCG@10 本番 0\.812 \/ 一次スコアだけ 0\.701 \(差 \+0\.111、95% 区間 \+0\.023 〜 \+0\.205\)/);
  assert.match(text, /ガード: 警告なし/);
  assert.match(text, /p=0\.2668/);
  assert.match(text, /見直す条件: そろっていない/);

  const alert = summaryLines(baseRun({ guard: { worse: true, alert: true, reason: "理由のダミー" } })).join("\n");
  assert.match(alert, /ガード: 警告あり \(理由のダミー\)/);
});
