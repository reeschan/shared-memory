import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type { MemoryMeta } from "../src/frontmatter.ts";
import { ensureSetup, indexIncremental } from "../src/indexing.ts";
import { searchMemories } from "../src/search.ts";
import { runDecay, runGc } from "../src/tiers.ts";
import { makeTestEnv, type TestEnv } from "./int-helpers.ts";

let env: TestEnv;
let repoDir: string;
const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

function meta(title: string, extra: Partial<MemoryMeta> = {}): MemoryMeta {
  return {
    id: ulid(),
    title,
    scope: "global",
    kind: "semantic",
    provenance: "agent_verified",
    source_agent: "claude",
    created_at: daysAgo(1),
    ...extra,
  };
}

const OLD = meta("ペンギンの飼育水温は十二度に保つ", { created_at: daysAgo(40) });
const FRESH = meta("カピバラの飼育には温泉を用意する");
const OLDV = meta("ビルド手順 旧版: make all を使う");
const NEWV = meta("ビルド手順 新版: pnpm build を使う", { supersedes: OLDV.id });
const BROKEN = meta("foo の parseThing の注意点", { scope: "repo:foo", symbol_ref: "src/parser.ts/parseThing" });
const OK_REF = meta("bar の renderWidget の注意点", { scope: "repo:bar", symbol_ref: "src/ui.ts/renderWidget" });
const MISSING_REF = meta("bar の goneFunction の注意点", { scope: "repo:bar", symbol_ref: "src/ui.ts/goneFunction" });

async function tiersInIndex(id: string): Promise<string[]> {
  const docs = await env.deps.os.scanAll<{ tier: string }>(env.cfg.opensearch.alias, { term: { memory_id: id } }, [
    "tier",
  ]);
  assert.ok(docs.length > 0, `ドキュメントがある: ${id}`);
  return [...new Set(docs.map((d) => d._source.tier))];
}

before(async () => {
  env = await makeTestEnv("pbi013");
  repoDir = path.join(tmpdir(), `shared-memory-test-repo-${randomBytes(6).toString("hex")}`);
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await mkdir(path.join(repoDir, "node_modules", "x"), { recursive: true });
  await writeFile(path.join(repoDir, "src", "ui.ts"), "export function renderWidget() {}\n");
  // node_modules 配下は見ない
  await writeFile(path.join(repoDir, "node_modules", "x", "index.js"), "function goneFunction() {}\n");
  env.cfg.repos = { bar: repoDir };

  for (const m of [OLD, FRESH, OLDV, NEWV, BROKEN, OK_REF, MISSING_REF]) {
    await env.writeMemoryFile(m, `${m.title}。本文。`);
  }
  await ensureSetup(env.cfg, env.deps.os);
  const r = await indexIncremental(env.cfg, env.deps);
  assert.deepEqual(r.invalid, []);
});

after(async () => {
  await env?.cleanup();
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

test("(a) 40 日前のメモリは runDecay で hot→cold になり、cold でも検索に出る", async () => {
  // 既定の searchable_tiers は全 tier (置き換えられたものは is_superseded で除く)
  assert.ok(env.cfg.search.searchable_tiers.includes("cold"), "既定の検索対象に cold が入る");
  const beforeHits = await searchMemories(env.cfg, env.deps, { query: "ペンギンの飼育水温", limit: 20 });
  assert.ok(beforeHits.some((x) => x.id === OLD.id), "decay 前は検索に出る");

  const r = await runDecay(env.cfg, env.deps, now);
  assert.equal(r.total, 7);
  assert.deepEqual(
    r.changed.find((c) => c.memory_id === OLD.id),
    { memory_id: OLD.id, from: "hot", to: "cold" },
  );
  assert.ok(!r.changed.some((c) => c.memory_id === FRESH.id), "新しいメモリは変わらない");
  assert.deepEqual(
    r.changed.find((c) => c.memory_id === OLDV.id),
    { memory_id: OLDV.id, from: "hot", to: "archive" },
  );
  assert.deepEqual(await tiersInIndex(OLD.id), ["cold"]);
  assert.equal(env.deps.stats.get(OLD.id)?.tier, "cold");

  const afterHits = await searchMemories(env.cfg, env.deps, { query: "ペンギンの飼育水温", limit: 20 });
  assert.ok(afterHits.some((x) => x.id === OLD.id), "cold になっても検索に出る");
});

test("(b) 2 回目の runDecay は changed が空", async () => {
  const r = await runDecay(env.cfg, env.deps, now);
  assert.deepEqual(r.changed, []);
});

test("(c) superseded のメモリは runGc で archive になる", async () => {
  // decay で archive 済みなので、一度 hot に戻してから gc を確かめる
  env.deps.stats.setTiers([{ memory_id: OLDV.id, tier: "hot" }]);
  await env.deps.os.updateByQuery(
    env.cfg.opensearch.alias,
    { term: { memory_id: OLDV.id } },
    { source: "ctx._source.tier = params.tier", params: { tier: "hot" } },
  );
  assert.deepEqual(await tiersInIndex(OLDV.id), ["hot"]);

  const r = await runGc(env.cfg, env.deps, now);
  assert.deepEqual(r.archived, [OLDV.id]);
  assert.equal(env.deps.stats.get(OLDV.id)?.tier, "archive");
  assert.deepEqual(await tiersInIndex(OLDV.id), ["archive"]);
  assert.equal(env.deps.stats.get(NEWV.id)?.tier ?? "hot", "hot");

  const again = await runGc(env.cfg, env.deps, now);
  assert.deepEqual(again.archived, []);
});

test("(d) symbol_ref の参照切れ: repos 未登録と、名前が見つからないものが入る", async () => {
  const r = await runGc(env.cfg, env.deps, now);
  const byId = new Map(r.brokenSymbolRefs.map((b) => [b.memory_id, b]));
  assert.deepEqual(byId.get(BROKEN.id), {
    memory_id: BROKEN.id,
    symbol_ref: "src/parser.ts/parseThing",
    reason: "repos に未登録",
  });
  assert.ok(byId.has(MISSING_REF.id), "node_modules にしか無い名前は参照切れ");
  assert.ok(!byId.has(OK_REF.id), "存在する名前は参照切れにしない");
  assert.equal(r.brokenSymbolRefs.length, 2);
});
