import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureSetup } from "../src/indexing.ts";
import { commitImport, parseImportJsonl, planImport } from "../src/import.ts";
import { makeTestEnv, type TestEnv } from "./int-helpers.ts";

let env: TestEnv;

function row(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Sudachi の設定",
    content: "split_mode は C を使う。",
    scope: "project:demo",
    kind: "semantic",
    tags: ["opensearch"],
    ...extra,
  });
}

async function count(query: object = { match_all: {} }): Promise<number> {
  const r = await env.deps.os.request<{ count: number }>(
    "POST",
    `/${env.cfg.opensearch.alias}/_count`,
    { query },
  );
  return r.count;
}

let firstIds: string[] = [];

before(async () => {
  env = await makeTestEnv("pbi014");
  await ensureSetup(env.cfg, env.deps.os);
});

after(async () => {
  await env?.cleanup();
});

test("(a) 3 行の JSONL で 3 ファイルでき、インデックス更新は 1 回だけ", async () => {
  const text = [
    row({ title: "一件目: Sudachi の設定", content: "split_mode は C を使う。" }),
    "",
    row({ title: "二件目: kNN の k", content: "k は candidates と同じ値にする。", scope: "global" }),
    row({ title: "三件目: decay の頻度", content: "decay は 1 日 1 回実行する。", kind: "episodic" }),
  ].join("\n");
  const parsed = parseImportJsonl(text, { source_agent: "claude" });
  assert.deepEqual(parsed.errors, []);
  const now = new Date();
  const plan = await planImport(env.cfg, parsed.inputs, now);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ok.map((p) => p.line), [1, 3, 4]);
  const ids = plan.ok.map((p) => p.meta.id);
  assert.equal(new Set(ids).size, 3, "同じバッチ内で id が重複しない");
  assert.deepEqual([...ids].sort(), ids, "行の順に id が並ぶ");
  assert.equal(plan.ok[0]!.meta.provenance, "agent_verified");

  // indexIncremental は 1 回につき scanAll を 1 回呼ぶので、その回数で数える
  const os = env.deps.os;
  const orig = os.scanAll.bind(os);
  let scanCalls = 0;
  os.scanAll = (async (...a: Parameters<typeof orig>) => {
    scanCalls++;
    return orig(...a);
  }) as typeof os.scanAll;
  let r;
  try {
    r = await commitImport(env.cfg, env.deps, plan);
  } finally {
    os.scanAll = orig;
  }
  assert.equal(scanCalls, 1, "indexIncremental は 1 回だけ");
  assert.equal(r.created.length, 3);
  assert.ok(r.report.upserted >= 1);
  assert.equal(r.report.upserted, 3);
  for (const c of r.created) {
    const file = path.join(env.cfg.memories_dir, ...c.path.split("/").slice(1));
    assert.ok(existsSync(file), c.path);
    assert.match(await readFile(file, "utf8"), new RegExp(`id: ${c.id}`));
  }
  assert.equal(r.created[1]!.path, `memories/global/${r.created[1]!.id}.md`);
  assert.equal(await count(), 3);
  firstIds = r.created.map((c) => c.id);
});

test("(b) 秘密情報を含む行は planImport の errors に入る", async () => {
  const fakeKey = "AKIA" + "Z".repeat(16);
  const parsed = parseImportJsonl(
    [row({ title: "普通の行", content: "問題ない内容。" }), row({ title: "鍵", content: `key は ${fakeKey}` })].join("\n"),
    { source_agent: "codex" },
  );
  const plan = await planImport(env.cfg, parsed.inputs);
  assert.deepEqual(plan.ok.map((p) => p.line), [1]);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0]!.line, 2);
  assert.match(plan.errors[0]!.errors.join(";"), /秘密情報らしき文字列/);
  await assert.rejects(commitImport(env.cfg, env.deps, plan), /書き込みません/);
  assert.equal(await count(), 3);
});

test("(c) 同じバッチ内で title と content が同じ行はエラー", async () => {
  const dup = row({ title: "重複", content: "同じ内容。" });
  const parsed = parseImportJsonl([dup, row({ title: "別", content: "別の内容。" }), dup].join("\n"), {
    source_agent: "kimi",
  });
  const plan = await planImport(env.cfg, parsed.inputs);
  assert.deepEqual(plan.ok.map((p) => p.line), [1, 2]);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0]!.line, 3);
  assert.match(plan.errors[0]!.errors.join(";"), /L1 と title と content が同じ/);
});

test("(d) 既存メモリを supersedes で指す行を取り込むと元メモリが is_superseded", async () => {
  const target = firstIds[0]!;
  const parsed = parseImportJsonl(
    row({ title: "一件目 (改訂)", content: "split_mode は C、辞書は full。", supersedes: target }),
    { source_agent: "claude" },
  );
  const plan = await planImport(env.cfg, parsed.inputs);
  assert.deepEqual(plan.errors, []);
  const r = await commitImport(env.cfg, env.deps, plan);
  const newId = r.created[0]!.id;
  const oldDocs = await env.deps.os.scanAll(env.cfg.opensearch.alias, { term: { memory_id: target } }, ["is_superseded"]);
  assert.ok(oldDocs.length > 0);
  for (const d of oldDocs) assert.equal((d._source as { is_superseded: boolean }).is_superseded, true);
  const newDocs = await env.deps.os.scanAll(env.cfg.opensearch.alias, { term: { memory_id: newId } }, ["is_superseded"]);
  assert.ok(newDocs.length > 0);
  for (const d of newDocs) assert.equal((d._source as { is_superseded: boolean }).is_superseded, false);

  // 存在しない id を supersedes に指す行はエラー
  const bad = await planImport(
    env.cfg,
    parseImportJsonl(row({ title: "x", content: "y", supersedes: "01" + "J".repeat(24) }), { source_agent: "claude" }).inputs,
  );
  assert.match(bad.errors[0]!.errors.join(";"), /supersedes/);
});
