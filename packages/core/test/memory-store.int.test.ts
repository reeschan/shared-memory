import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { ensureSetup } from "../src/indexing.ts";
import { findMemoryPath, readMemory, recordAccess, writeMemory, type WriteInput } from "../src/memory-store.ts";
import { makeTestEnv, type TestEnv } from "./int-helpers.ts";

let env: TestEnv;

function input(extra: Partial<WriteInput> = {}): WriteInput {
  return {
    title: "メモリ: Sudachi の設定",
    content: "Sudachi の split_mode は C を使う。",
    scope: "project:demo",
    kind: "semantic",
    provenance: "agent_verified",
    source_agent: "claude",
    tags: ["opensearch"],
    ...extra,
  };
}

async function docsOf(memoryId: string): Promise<{ _id: string; _source: any }[]> {
  return env.deps.os.scanAll(env.cfg.opensearch.alias, { term: { memory_id: memoryId } }, [
    "memory_id", "path", "is_superseded", "access_count", "last_accessed_at", "tier",
  ]);
}

let first: { id: string; path: string };

before(async () => {
  env = await makeTestEnv("pbi010");
  await ensureSetup(env.cfg, env.deps.os);
});

after(async () => {
  await env?.cleanup();
});

test("(a) writeMemory でファイルができ、直後に OpenSearch にある", async () => {
  first = await writeMemory(env.cfg, env.deps, input());
  assert.equal(first.path, `memories/project/demo/${first.id}.md`);
  const file = path.join(env.cfg.memories_dir, "project", "demo", `${first.id}.md`);
  assert.ok(existsSync(file));
  assert.equal(findMemoryPath(env.cfg, first.id), file);
  const docs = await docsOf(first.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!._source.path, first.path);
  assert.equal(docs[0]!._source.is_superseded, false);
});

test("(a') 秘密情報を含む write は拒否され、ファイルもできない", async () => {
  const before = (await env.deps.os.request<{ count: number }>("GET", `/${env.cfg.opensearch.alias}/_count`)).count;
  await assert.rejects(
    writeMemory(env.cfg, env.deps, input({ content: "key: " + "AKIA" + "B".repeat(16) })),
    /秘密情報らしき文字列/,
  );
  const after = (await env.deps.os.request<{ count: number }>("GET", `/${env.cfg.opensearch.alias}/_count`)).count;
  assert.equal(after, before);
});

test("(b) supersedes 付きの write で元メモリの is_superseded が true になる", async () => {
  const second = await writeMemory(
    env.cfg,
    env.deps,
    input({ title: "メモリ: Sudachi の設定 (改訂)", content: "split_mode は C、辞書は full。", supersedes: first.id }),
  );
  for (const d of await docsOf(first.id)) assert.equal(d._source.is_superseded, true);
  for (const d of await docsOf(second.id)) assert.equal(d._source.is_superseded, false);
  await assert.rejects(
    writeMemory(env.cfg, env.deps, input({ supersedes: ulid() })),
    /supersedes/,
  );
});

test("(c) readMemory で front matter と本文が返り、無い id は undefined", async () => {
  const m = await readMemory(env.cfg, first.id);
  assert.ok(m);
  assert.equal(m.id, first.id);
  assert.equal(m.title, "メモリ: Sudachi の設定");
  assert.equal(m.scope, "project:demo");
  assert.equal(m.kind, "semantic");
  assert.equal(m.provenance, "agent_verified");
  assert.equal(m.source_agent, "claude");
  assert.deepEqual(m.tags, ["opensearch"]);
  assert.equal(m.body, "Sudachi の split_mode は C を使う。");
  assert.equal(m.path, first.path);
  assert.equal(await readMemory(env.cfg, ulid()), undefined);
});

test("(d) recordAccess を 2 回で count 2、OpenSearch も access_count 2・tier hot", async () => {
  env.deps.stats.setTiers([{ memory_id: first.id, tier: "cold" }]);
  await recordAccess(env.cfg, env.deps, first.id, new Date("2026-10-09T00:00:00.000Z"));
  const s = await recordAccess(env.cfg, env.deps, first.id, new Date("2026-10-10T00:00:00.000Z"));
  assert.equal(s.access_count, 2);
  assert.equal(s.tier, "hot");
  assert.equal(env.deps.stats.get(first.id)?.access_count, 2);
  const docs = await docsOf(first.id);
  assert.ok(docs.length > 0);
  for (const d of docs) {
    assert.equal(d._source.access_count, 2);
    assert.equal(d._source.tier, "hot");
    assert.equal(d._source.last_accessed_at, "2026-10-10T00:00:00.000Z");
  }
});
