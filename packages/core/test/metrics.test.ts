import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapDiff, memoryMetrics } from "../src/metrics.ts";

const near = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("memoryMetrics: 等級 2 があれば等級 2 だけを Recall の対象にし、nDCG と MRR を手計算どおりに出す", () => {
  const rel = { a: 2, b: 1, c: 1 };
  const ranking = ["x", "a", "b", "y", "z", "c"];
  const m = memoryMetrics(ranking, rel);
  near(m.recall5, 1); // 対象は a だけ。2 位にある
  const dcg = 3 / Math.log2(3) + 1 / Math.log2(4) + 1 / Math.log2(7);
  const ideal = 3 / Math.log2(2) + 1 / Math.log2(3) + 1 / Math.log2(4);
  near(m.ndcg10, dcg / ideal);
  near(m.mrr10, 1 / 2);
});

test("memoryMetrics: 等級 2 が無い問いでは等級 1 を Recall の対象にする", () => {
  const rel = { a: 1, b: 1 };
  const m = memoryMetrics(["a", "x", "y", "z", "w", "b"], rel); // b は 6 位で上位 5 件の外
  near(m.recall5, 0.5);
  near(m.mrr10, 1);
  const dcg = 1 / Math.log2(2) + 1 / Math.log2(7);
  const ideal = 1 / Math.log2(2) + 1 / Math.log2(3);
  near(m.ndcg10, dcg / ideal);
});

test("memoryMetrics: 理想 DCG が 0 なら ndcg10 は 0", () => {
  const m = memoryMetrics(["a", "b"], { a: 0 });
  assert.equal(m.ndcg10, 0);
  assert.equal(m.mrr10, 0);
});

test("memoryMetrics: 正解が上位 10 件に無ければ mrr10 は 0 (ndcg10 と recall5 も 0)", () => {
  const ranking = Array.from({ length: 10 }, (_, i) => `x${i}`).concat("a");
  const m = memoryMetrics(ranking, { a: 2 });
  assert.equal(m.mrr10, 0);
  assert.equal(m.ndcg10, 0);
  assert.equal(m.recall5, 0);
});

test("memoryMetrics: 正解を理想の順に並べれば ndcg10 は 1", () => {
  const m = memoryMetrics(["a", "b", "c"], { a: 2, b: 1, c: 1 });
  near(m.ndcg10, 1);
  near(m.recall5, 1);
  near(m.mrr10, 1);
});

test("bootstrapDiff: 同じ配列なら mean・lo・hi が 0 で tie が全件", () => {
  const xs = [0.1, 0.5, 0.9, 0.3, 0.7];
  const r = bootstrapDiff(xs, xs.slice());
  assert.equal(r.mean, 0);
  assert.equal(r.lo, 0);
  assert.equal(r.hi, 0);
  assert.deepEqual([r.win, r.lose, r.tie], [0, 0, xs.length]);
});

test("bootstrapDiff: b が一律に 0.1 大きければ mean・lo・hi がすべて 0.1", () => {
  const a = [0.1, 0.5, 0.9, 0.3, 0.7, 0.2];
  const b = a.map((x) => x + 0.1);
  const r = bootstrapDiff(a, b);
  near(r.mean, 0.1, 1e-9);
  near(r.lo, 0.1, 1e-9);
  near(r.hi, 0.1, 1e-9);
  assert.deepEqual([r.win, r.lose, r.tie], [a.length, 0, 0]);
});

test("bootstrapDiff: 同じ入力と seed なら同じ結果 (既定は seed 1・5000 回)", () => {
  const a = [0.1, 0.5, 0.9, 0.3, 0.7, 0.2, 0.4, 0.8];
  const b = [0.2, 0.4, 1.0, 0.3, 0.9, 0.1, 0.6, 0.8];
  const r1 = bootstrapDiff(a, b, { seed: 7 });
  const r2 = bootstrapDiff(a, b, { seed: 7 });
  assert.deepEqual(r1, r2);
  assert.deepEqual(bootstrapDiff(a, b), bootstrapDiff(a, b, { seed: 1, iterations: 5000 }));
  assert.ok(r1.lo <= r1.mean && r1.mean <= r1.hi);
});

test("bootstrapDiff: 長さが違えばエラー", () => {
  assert.throws(() => bootstrapDiff([1, 2], [1]), /length/);
});
