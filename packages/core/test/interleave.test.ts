import { test } from "node:test";
import assert from "node:assert/strict";
import { interleaveOutcome, signTest, teamDraft, topDiffers } from "../src/interleave.ts";

const ids = (from: number, to: number, prefix = "m") =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
const near = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("teamDraft: 同じ seed なら同じ結果になる", () => {
  const a = ids(1, 20);
  const b = [...ids(11, 20), ...ids(1, 10)];
  for (const seed of [1, 7, 12345, 2147483646]) {
    assert.deepEqual(teamDraft(a, b, seed), teamDraft(a, b, seed));
  }
});

test("teamDraft: 別の seed では先手が変わる例がある", () => {
  const a = ids(1, 10);
  const b = ids(1, 10, "x");
  const firsts = new Set<string>();
  for (const seed of [12345, 30000, 54321, 99999, 123456789, 987654321]) {
    firsts.add(teamDraft(a, b, seed).teams[0]!);
  }
  assert.deepEqual([...firsts].sort(), ["a", "b"]);
});

test("teamDraft: 小さい seed (1〜100) でも先手が a と b の両方に分かれる", () => {
  const a = ids(1, 10);
  const b = ids(1, 10, "x");
  let na = 0;
  let nb = 0;
  for (let seed = 1; seed <= 100; seed++) {
    if (teamDraft(a, b, seed).teams[0] === "a") na++;
    else nb++;
  }
  assert.ok(na > 0 && nb > 0, `a=${na} b=${nb}`);
});

test("teamDraft: seed が 0 以下なら 1 として扱う", () => {
  const a = ids(1, 10);
  const b = ids(1, 10, "x");
  assert.deepEqual(teamDraft(a, b, 0), teamDraft(a, b, 1));
  assert.deepEqual(teamDraft(a, b, -5), teamDraft(a, b, 1));
});

test("teamDraft: ids に重複が無く、ids と teams が同じ長さ", () => {
  const a = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
  const b = ["m3", "m1", "m9", "m2", "m10", "m4", "m11", "m12"];
  for (let seed = 1; seed <= 50; seed++) {
    const il = teamDraft(a, b, seed);
    assert.equal(il.ids.length, il.teams.length);
    assert.equal(new Set(il.ids).size, il.ids.length);
    assert.equal(il.ids.length, 10);
    // 取った数の差は 1 以下 (どちらにも出せるものがある間)
    const na = il.teams.filter((t) => t === "a").length;
    const nb = il.teams.filter((t) => t === "b").length;
    assert.ok(Math.abs(na - nb) <= 1);
    // 各 team が出した id は、その team の順位のうちまだ入っていない最上位
    const seen = new Set<string>();
    il.ids.forEach((id, i) => {
      const own = il.teams[i] === "a" ? a : b;
      assert.equal(id, own.find((x) => !seen.has(x)));
      seen.add(id);
    });
  }
});

test("teamDraft: limit 件で止まる (既定 10)", () => {
  const a = ids(1, 20);
  const b = ids(1, 20, "x");
  assert.equal(teamDraft(a, b, 3).ids.length, 10);
  assert.equal(teamDraft(a, b, 3, 4).ids.length, 4);
  assert.equal(teamDraft(a, b, 3, 0).ids.length, 0);
});

test("teamDraft: 両方尽きたらそこで止まる", () => {
  const a = ["m1", "m2", "m3"];
  const b = ["m2", "m4"];
  for (let seed = 1; seed <= 20; seed++) {
    const il = teamDraft(a, b, seed, 10);
    assert.equal(il.ids.length, 4);
    assert.deepEqual([...il.ids].sort(), ["m1", "m2", "m3", "m4"]);
  }
  assert.deepEqual(teamDraft([], [], 1), { ids: [], teams: [] });
});

test("teamDraft: 片方が短いと、もう一方が続けて出す", () => {
  const a = ["m1"];
  const b = ids(1, 6, "x");
  for (let seed = 1; seed <= 20; seed++) {
    const il = teamDraft(a, b, seed, 10);
    assert.equal(il.ids.length, 7);
    assert.equal(il.teams.filter((t) => t === "a").length, 1);
    // a の分が尽きたあとは b が続けて出す
    const lastA = il.teams.lastIndexOf("a");
    assert.ok(il.teams.slice(lastA + 1).every((t) => t === "b"));
    assert.deepEqual(il.ids.filter((_, i) => il.teams[i] === "b"), b);
  }
});

test("interleaveOutcome: 片方だけが正解を出した例で勝ちが付く", () => {
  const a = ["m1", "m2", "m3"];
  const b = ["x1", "x2", "x3"];
  for (let seed = 1; seed <= 20; seed++) {
    const il = teamDraft(a, b, seed);
    assert.equal(interleaveOutcome(il, { m2: 2 }), "a");
    assert.equal(interleaveOutcome(il, { x3: 1 }), "b");
    assert.equal(interleaveOutcome(il, { m1: 1, x1: 1 }), "tie");
    assert.equal(interleaveOutcome(il, { m1: 1, x1: 2 }), "b");
  }
});

test("interleaveOutcome: 等級が無い id は 0 として扱う", () => {
  const il = { ids: ["m1", "m2"], teams: ["a", "b"] as ("a" | "b")[] };
  assert.equal(interleaveOutcome(il, {}), "tie");
  assert.equal(interleaveOutcome({ ids: ["constructor", "m2"], teams: ["a", "b"] }, { m2: 1 }), "b");
});

test("topDiffers: 上位 k 件の並びの違いを見る", () => {
  const a = ids(1, 12);
  assert.equal(topDiffers(a, [...a]), false);
  // 11 位以下だけが違うなら既定の k=10 では同じ
  const b = [...ids(1, 10), "m12", "m11"];
  assert.equal(topDiffers(a, b), false);
  assert.equal(topDiffers(a, b, 12), true);
  // 同じ集合でも並びが違えば true
  const c = ["m2", "m1", ...ids(3, 12)];
  assert.equal(topDiffers(a, c), true);
  assert.equal(topDiffers(a, c, 1), true);
  // 件数が違えば true
  assert.equal(topDiffers(ids(1, 5), ids(1, 4)), true);
  assert.equal(topDiffers([], []), false);
});

test("signTest: 両側の正確な二項検定", () => {
  assert.equal(signTest(0, 0), 1);
  assert.equal(signTest(5, 5), 1);
  near(signTest(10, 0), 0.001953125);
  near(signTest(0, 10), 0.001953125);
  // 8 勝 2 敗: 2 * (1 + 10 + 45) / 1024
  near(signTest(8, 2), (2 * 56) / 1024);
  near(signTest(1, 0), 1);
});

test("signTest: n が数百でも桁あふれしない", () => {
  const p = signTest(300, 300);
  assert.ok(Number.isFinite(p) && p === 1);
  const q = signTest(330, 270);
  assert.ok(Number.isFinite(q) && q > 0 && q < 0.05, String(q));
  const r = signTest(2000, 0);
  assert.ok(Number.isFinite(r) && r >= 0 && r < 1e-300);
});
