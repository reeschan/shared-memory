import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  EVAL_SET_FILE,
  addHumanLabels,
  effectiveLabel,
  evalDir,
  fromLabEvalJsonl,
  questionKey,
  readEvalSet,
  writeEvalSet,
  type EvalQuestion,
} from "../src/evalset.ts";

// テストのデータはすべて作ったダミー (本物の記憶の ID・本文は使わない)

function q(over: Partial<EvalQuestion> = {}): EvalQuestion {
  return {
    qid: "s01",
    query: "ダミーの問い",
    asked_at: "2026-01-01T00:00:00.000Z",
    kind: "synthetic",
    labels: [{ source: "agent", labeled_at: "2026-01-01T00:00:00.000Z", relevant: { DUMMY1: 2 } }],
    ...over,
  };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "sm-evalset-"));

test("writeEvalSet で書いて readEvalSet で読むと同じ内容に戻る (1 行 1 問、末尾に改行、一時ファイルは残らない)", async () => {
  const dir = join(tmp(), "nested", "eval");
  const qs: EvalQuestion[] = [
    q(),
    q({
      qid: "h-0001",
      query: "二つめ",
      kind: "real",
      filters: { scope: "global", kind: "semantic", tags: ["a", "b"] },
      freshness_sensitive: true,
      labels: [
        { source: "agent", labeled_at: "2026-01-01T00:00:00.000Z", relevant: { DUMMY2: 1 } },
        {
          source: "human",
          labeled_at: "2026-01-02T00:00:00.000Z",
          session_id: "sess-1",
          relevant: { DUMMY3: 2 },
          stale_ids: ["DUMMY2"],
        },
      ],
    }),
  ];
  await writeEvalSet(dir, qs);
  const text = readFileSync(join(dir, EVAL_SET_FILE), "utf8");
  assert.equal(text.split("\n").length, 3);
  assert.ok(text.endsWith("\n"));
  assert.equal(existsSync(join(dir, `${EVAL_SET_FILE}.tmp`)), false);
  assert.deepEqual(await readEvalSet(dir), qs);
});

test("readEvalSet はファイルが無ければ []、空行は無視する", async () => {
  const dir = tmp();
  assert.deepEqual(await readEvalSet(dir), []);
  writeFileSync(join(dir, EVAL_SET_FILE), `\n${JSON.stringify(q())}\n\n`);
  assert.deepEqual(await readEvalSet(dir), [q()]);
});

test("readEvalSet は壊れた行を行番号入りの Error にする", async () => {
  const dir = tmp();
  writeFileSync(join(dir, EVAL_SET_FILE), `${JSON.stringify(q())}\n{broken\n`);
  await assert.rejects(readEvalSet(dir), /2 行目/);
  writeFileSync(join(dir, EVAL_SET_FILE), `${JSON.stringify(q())}\n\n${JSON.stringify({ qid: "x" })}\n`);
  await assert.rejects(readEvalSet(dir), /3 行目/);
});

test("effectiveLabel は最新の human を優先し、無ければ最新の agent", () => {
  const a1 = { source: "agent" as const, labeled_at: "1", relevant: { A: 2 } };
  const a2 = { source: "agent" as const, labeled_at: "2", relevant: { B: 2 } };
  const h1 = { source: "human" as const, labeled_at: "3", session_id: "s", relevant: { C: 2 } };
  const h2 = { source: "human" as const, labeled_at: "4", session_id: "s", relevant: { D: 1 } };
  assert.equal(effectiveLabel(q({ labels: [a1, a2] })), a2);
  assert.equal(effectiveLabel(q({ labels: [a1, h1, h2, a2] })), h2);
  assert.equal(effectiveLabel(q({ labels: [h1, a2] })), h1);
  assert.equal(effectiveLabel(q({ labels: [] })), undefined);
});

test("questionKey は前後・連続の空白と大小文字の違いを同じに扱い、filters で区別する", () => {
  assert.equal(questionKey("  Foo   Bar\tBaz "), questionKey("foo bar baz"));
  assert.equal(questionKey("x", { tags: ["b", "a"], scope: "global" }), questionKey("X", { scope: "global", tags: ["a", "b"] }));
  assert.equal(questionKey("x", {}), questionKey("x"));
  assert.notEqual(questionKey("x", { scope: "global" }), questionKey("x"));
  assert.notEqual(questionKey("foo bar"), questionKey("foobar"));
});

test("fromLabEvalJsonl は lab の形を agent のラベルの EvalQuestion にする", () => {
  const text = [
    JSON.stringify({ qid: "s01", set: "synthetic", query: "ダミー A", relevant: { DUMMY1: 2, DUMMY2: 1 } }),
    "",
    JSON.stringify({ qid: "r01", set: "real", query: "ダミー B", relevant: { DUMMY3: 2 } }),
  ].join("\n") + "\n";
  const qs = fromLabEvalJsonl(text);
  assert.deepEqual(qs, [
    {
      qid: "s01",
      query: "ダミー A",
      asked_at: "2026-10-17T00:00:00.000Z",
      kind: "synthetic",
      labels: [{ source: "agent", labeled_at: "2026-10-17T00:00:00.000Z", relevant: { DUMMY1: 2, DUMMY2: 1 } }],
    },
    {
      qid: "r01",
      query: "ダミー B",
      asked_at: "2026-10-17T00:00:00.000Z",
      kind: "real",
      labels: [{ source: "agent", labeled_at: "2026-10-17T00:00:00.000Z", relevant: { DUMMY3: 2 } }],
    },
  ]);
  const at = "2026-05-01T00:00:00.000Z";
  assert.equal(fromLabEvalJsonl(text, at)[0]!.asked_at, at);
  assert.equal(fromLabEvalJsonl(text, at)[0]!.labels[0]!.labeled_at, at);
  assert.throws(() => fromLabEvalJsonl(`{"qid":"x","set":"other","query":"q","relevant":{}}\n`), /1 行目/);
});

test("addHumanLabels は同じ問いにラベルを足し、新しい問いには h-0001 からの qid を振り、元の配列を変えない", () => {
  const orig = [q({ qid: "s01", query: "Foo  Bar" }), q({ qid: "s02", query: "other" })];
  const snapshot = structuredClone(orig);
  const out = addHumanLabels(
    orig,
    [
      { query: " foo bar ", asked_at: "2026-02-01T00:00:00.000Z", kind: "real", relevant: { DUMMY9: 2 }, stale_ids: ["DUMMY1"] },
      { query: "新しい問い", asked_at: "2026-02-02T00:00:00.000Z", kind: "real", relevant: { DUMMY5: 1 }, stale_ids: [] },
      { query: "もう一つ", asked_at: "2026-02-03T00:00:00.000Z", kind: "real", filters: { scope: "global" }, relevant: {}, stale_ids: [] },
    ],
    "sess-1",
    "2026-02-05T00:00:00.000Z",
  );
  assert.deepEqual(orig, snapshot);
  assert.equal(out.length, 4);
  assert.equal(out[0]!.labels.length, 2);
  assert.deepEqual(out[0]!.labels[1], {
    source: "human",
    labeled_at: "2026-02-05T00:00:00.000Z",
    session_id: "sess-1",
    relevant: { DUMMY9: 2 },
    stale_ids: ["DUMMY1"],
  });
  assert.equal(out[2]!.qid, "h-0001");
  assert.equal(out[2]!.query, "新しい問い");
  assert.equal(out[2]!.asked_at, "2026-02-02T00:00:00.000Z");
  assert.equal(out[3]!.qid, "h-0002");
  assert.deepEqual(out[3]!.filters, { scope: "global" });

  // 連番は既存の h- の最大 + 1
  const again = addHumanLabels(
    [q({ qid: "h-0007", query: "a" }), q({ qid: "h-0003", query: "b" })],
    [{ query: "c", asked_at: "2026-02-02T00:00:00.000Z", kind: "real", relevant: {}, stale_ids: [] }],
    "sess-2",
    "2026-02-05T00:00:00.000Z",
  );
  assert.equal(again[2]!.qid, "h-0008");
});

test("evalDir は eval.dir が空なら memories_dir の隣の eval/、空でなければそれ", () => {
  const memories = join(tmpdir(), "store", "memories");
  const base = { memories_dir: memories, eval: { dir: "" } } as Config;
  assert.equal(evalDir(base), join(tmpdir(), "store", "eval"));
  const custom = join(tmpdir(), "elsewhere", "ev");
  assert.equal(evalDir({ ...base, eval: { dir: custom } }), custom);
});

test("readEvalSet は日時として読めない asked_at と、数でない relevant の値を行番号入りの Error にする", async () => {
  const dir = tmp();
  writeFileSync(join(dir, EVAL_SET_FILE), `${JSON.stringify(q())}\n${JSON.stringify(q({ qid: "s02", asked_at: "きのう" }))}\n`);
  await assert.rejects(readEvalSet(dir), /2 行目.*asked_at が日時として読めません/);
  const badGrade = q({ qid: "s03", labels: [{ source: "agent", labeled_at: "2026-01-01T00:00:00.000Z", relevant: { DUMMY1: "2" as unknown as number } }] });
  writeFileSync(join(dir, EVAL_SET_FILE), `${JSON.stringify(q())}\n\n${JSON.stringify(badGrade)}\n`);
  await assert.rejects(readEvalSet(dir), /3 行目.*relevant の値は数/);
});
