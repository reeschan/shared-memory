import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import type { MemoryMeta } from "../src/frontmatter.ts";
import { chunkMemory } from "../src/chunk.ts";
import { embeddingFingerprint, fingerprintParts, LEGACY_EMBEDDING } from "../src/embed.ts";
import { checkEmbeddingCompat, ensureSetup, indexIncremental, reindexAll } from "../src/indexing.ts";
import { makeTestEnv, type TestEnv } from "./int-helpers.ts";

let env: TestEnv;

function meta(title: string, extra: Partial<MemoryMeta> = {}): MemoryMeta {
  return {
    id: ulid(),
    title,
    scope: "global",
    kind: "semantic",
    provenance: "agent_verified",
    source_agent: "claude",
    created_at: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

const para = (s: string, n: number) => Array.from({ length: n }, () => s).join("");
const multiBody = [
  "## 前半",
  "",
  para("OpenSearch の差分インデックスはチャンクごとのハッシュで判定する。", 20),
  "",
  "## 後半",
  "",
  para("埋め込みキャッシュはモデル名とハッシュをキーにローカルへ保存する。", 20),
].join("\n");

const A = meta("メモリA: Sudachi の設定", { scope: "project:demo", tags: ["opensearch"] });
const B = meta("メモリB: 見出しが複数");
const C = meta("メモリC: 埋め込み", { kind: "episodic", scope: "repo:sample" });
let bodyC = "Qwen3-Embedding-0.6B を Ollama で動かす。";

async function count(): Promise<number> {
  const r = await env.deps.os.request<{ count: number }>("GET", `/${env.cfg.opensearch.alias}/_count`);
  return r.count;
}

async function docsOf(memoryId: string): Promise<{ _id: string; _source: any }[]> {
  return env.deps.os.scanAll(env.cfg.opensearch.alias, { term: { memory_id: memoryId } }, [
    "memory_id", "chunk_no", "is_superseded", "access_count", "content",
  ]);
}

function chunkCount(m: MemoryMeta, body: string): number {
  return chunkMemory(m.title, body, env.cfg.chunk).length;
}

before(async () => {
  env = await makeTestEnv("pbi008");
  env.cfg.search.weights = { bm25: 0.3, knn: 0.7 };
});

after(async () => {
  await env?.cleanup();
});

test("(a) ensureSetup がエイリアス・インデックス・パイプラインを作り、2 回目は作らない", async () => {
  const { cfg, deps } = env;
  const r1 = await ensureSetup(cfg, deps.os);
  assert.equal(r1.createdIndex, cfg.opensearch.index_base);
  assert.deepEqual(await deps.os.getAliasTargets(cfg.opensearch.alias), [cfg.opensearch.index_base]);
  const r2 = await ensureSetup(cfg, deps.os);
  assert.equal(r2.createdIndex, undefined);
  const p = await deps.os.request<any>("GET", `/_search/pipeline/${cfg.opensearch.pipeline_name}`);
  const weights =
    p[cfg.opensearch.pipeline_name].phase_results_processors[0]["normalization-processor"].combination
      .parameters.weights;
  assert.deepEqual(weights, [0.3, 0.7]);
});

test("(b) 3 ファイルを投入するとドキュメント数がチャンク数と一致し _id が <id>:<chunk_no>", async () => {
  await env.writeMemoryFile(A, "Sudachi の split_mode は C を使う。");
  await env.writeMemoryFile(B, multiBody);
  await env.writeMemoryFile(C, bodyC);
  assert.ok(chunkCount(B, multiBody) >= 2, "B は 2 チャンク以上");
  const total = chunkCount(A, "x") + chunkCount(B, multiBody) + chunkCount(C, bodyC);

  const r = await indexIncremental(env.cfg, env.deps);
  assert.equal(r.scanned, 3);
  assert.deepEqual(r.invalid, []);
  assert.equal(r.upserted, total);
  assert.equal(r.embedded + r.cached, total);
  assert.equal(await count(), total);

  const docsB = await docsOf(B.id);
  assert.equal(docsB.length, chunkCount(B, multiBody));
  for (const d of docsB) {
    assert.equal(d._id, `${B.id}:${d._source.chunk_no}`);
    assert.ok(String(d._source.content).startsWith(`${B.title}\n\n`));
  }
  const full = await env.deps.os.search(env.cfg.opensearch.alias, {
    query: { ids: { values: [`${A.id}:0`] } },
  });
  const src = full.hits[0]!._source;
  assert.equal(src.memory_id, A.id);
  assert.equal(src.path, `memories/project/demo/${A.id}.md`);
  assert.equal(src.embedding.length, env.cfg.embedding.dimension);
  assert.deepEqual(src.tags, ["opensearch"]);
  assert.equal(src.is_superseded, false);
  assert.equal(src.tier, "hot");
  assert.equal(src.access_count, 0);
  assert.equal(src.last_accessed_at, null);
});

test("(c) 何も変えずに 2 回目は embedded 0・upserted 0", async () => {
  const r = await indexIncremental(env.cfg, env.deps);
  assert.equal(r.embedded, 0);
  assert.equal(r.upserted, 0);
  assert.equal(r.updated, 0);
  assert.equal(r.deleted, 0);
});

test("(d) 1 ファイルの本文を変えるとそのファイルのチャンクだけ upserted", async () => {
  bodyC = "Qwen3-Embedding-0.6B を Ollama で動かす。RTX 5070 Ti で十分に速い。";
  await env.writeMemoryFile(C, bodyC);
  const r = await indexIncremental(env.cfg, env.deps);
  assert.equal(r.upserted, chunkCount(C, bodyC));
  assert.equal(r.embedded, chunkCount(C, bodyC));
  assert.equal(r.deleted, 0);
  const docsC = await docsOf(C.id);
  assert.ok(String(docsC[0]!._source.content).includes("RTX 5070 Ti"));
});

test("(e) 不正な front matter のファイルは invalid に入り、他は投入される", async () => {
  const bad = path.join(env.cfg.memories_dir, "global", "01JBADBADBADBADBADBADBADBA.md");
  await writeFile(bad, "---\ntitle: id なし\nkind: unknown\n---\n\n本文\n", "utf8");
  const D = meta("メモリD: 正常");
  await env.writeMemoryFile(D, "正常なファイルは投入される。");
  try {
    const r = await indexIncremental(env.cfg, env.deps);
    assert.equal(r.invalid.length, 1);
    assert.equal(r.invalid[0]!.path, "memories/global/01JBADBADBADBADBADBADBADBA.md");
    assert.ok(r.invalid[0]!.errors.length > 0);
    assert.equal(r.upserted, 1);
    assert.equal((await docsOf(D.id)).length, 1);
  } finally {
    await rm(bad);
  }
});

test("(f) supersedes で A を指す B' を追加すると A の全チャンクが is_superseded", async () => {
  const A2 = meta("メモリA2: Sudachi の設定 (改訂)", { scope: "project:demo", supersedes: A.id });
  await env.writeMemoryFile(A2, "Sudachi の split_mode は C、辞書は full を使う。");
  const r = await indexIncremental(env.cfg, env.deps);
  assert.equal(r.upserted, 1);
  assert.ok(r.updated >= 1);
  const docsA = await docsOf(A.id);
  assert.ok(docsA.length > 0);
  for (const d of docsA) assert.equal(d._source.is_superseded, true);
  for (const d of await docsOf(A2.id)) assert.equal(d._source.is_superseded, false);
});

test("(g) ファイルを削除するとそのメモリのドキュメントが消える", async () => {
  const before = await count();
  const n = (await docsOf(B.id)).length;
  assert.ok(n >= 2);
  await rm(path.join(env.cfg.memories_dir, "global", `${B.id}.md`));
  const r = await indexIncremental(env.cfg, env.deps);
  assert.equal(r.deleted, n);
  assert.equal((await docsOf(B.id)).length, 0);
  assert.equal(await count(), before - n);
});

test("(h) StatsStore の access_count がドキュメントに埋め戻される", async () => {
  for (let i = 0; i < 5; i++) env.deps.stats.recordAccess(C.id, "2026-10-09T12:00:00.000Z");
  const r = await indexIncremental(env.cfg, env.deps);
  assert.equal(r.upserted, 0);
  assert.equal(r.updated, chunkCount(C, bodyC));
  const full = await env.deps.os.search(env.cfg.opensearch.alias, {
    query: { term: { memory_id: C.id } },
  });
  for (const h of full.hits) {
    assert.equal(h._source.access_count, 5);
    assert.equal(h._source.last_accessed_at, "2026-10-09T12:00:00.000Z");
    assert.equal(h._source.tier, "hot");
  }
});

test("(i) reindexAll は新インデックスを作ってエイリアスを付け替え、旧インデックスを消す", async () => {
  const { cfg, deps } = env;
  const before = await count();
  const old = await deps.os.getAliasTargets(cfg.opensearch.alias);
  assert.deepEqual(old, [cfg.opensearch.index_base]);
  const r = await reindexAll(cfg, deps);
  assert.match(r.index, new RegExp(`^${cfg.opensearch.index_base}-r\\d{14}$`));
  assert.deepEqual(await deps.os.getAliasTargets(cfg.opensearch.alias), [r.index]);
  assert.equal(await deps.os.indexExists(cfg.opensearch.index_base), false);
  assert.equal(r.upserted, before);
  assert.equal(r.embedded, 0);
  assert.equal(await count(), before);
  // 埋め戻しと is_superseded も新インデックスに入っている
  for (const d of await docsOf(A.id)) assert.equal(d._source.is_superseded, true);
  for (const d of await docsOf(C.id)) assert.equal(d._source.access_count, 5);
});

test("only 指定: 対象ファイルだけ投入し、他ファイルの削除はしない", async () => {
  const E = meta("メモリE: only");
  const file = await env.writeMemoryFile(E, "only で指定したファイルだけ投入する。");
  const r = await indexIncremental(env.cfg, env.deps, { only: [file] });
  assert.equal(r.upserted, 1);
  assert.equal(r.deleted, 0);
  assert.equal((await docsOf(E.id)).length, 1);
});

test("(j) ensureSetup は _meta に指紋と内訳を書き、テンプレートの次元を設定値にする", async () => {
  const e = await makeTestEnv("pbi024meta");
  try {
    await ensureSetup(e.cfg, e.deps.os);
    const index = (await e.deps.os.getAliasTargets(e.cfg.opensearch.alias))[0]!;
    assert.equal(index, e.cfg.opensearch.index_base);
    const indexMeta = await e.deps.os.getIndexMeta(index);
    assert.ok(indexMeta, "_meta がある");
    const emb = indexMeta.embedding as { fingerprint: string; parts: Record<string, unknown> };
    const expected = embeddingFingerprint(e.cfg.embedding);
    assert.equal(emb.fingerprint, expected);
    assert.deepEqual(emb.parts, fingerprintParts(e.cfg.embedding));
    const mapping = await e.deps.os.request<any>("GET", `/${index}/_mapping`);
    assert.equal(mapping[index].mappings.properties.embedding.dimension, e.cfg.embedding.dimension);
    assert.deepEqual(await checkEmbeddingCompat(e.cfg, e.deps.os), {
      ok: true,
      index,
      indexFingerprint: expected,
      expected,
    });
  } finally {
    await e.cleanup();
  }
});

test("(k) revision が違うと indexIncremental は止まり、reindexAll は新しい指紋のインデックスを作る", async () => {
  const e = await makeTestEnv("pbi024rev");
  try {
    await ensureSetup(e.cfg, e.deps.os);
    const M = meta("メモリ: 埋め込みの照合");
    await e.writeMemoryFile(M, "照合用の短い本文。");
    const current = embeddingFingerprint(e.cfg.embedding);
    const changed = structuredClone(e.cfg);
    changed.embedding.revision = e.cfg.embedding.revision + 1;
    const expected = embeddingFingerprint(changed.embedding);
    assert.notEqual(expected, current);

    await assert.rejects(
      () => indexIncremental(changed, e.deps),
      (err: Error) => {
        assert.match(err.message, /pnpm sm reindex/);
        assert.ok(err.message.includes(`インデックス ${current}`), err.message);
        assert.ok(err.message.includes(`設定 ${expected}`), err.message);
        return true;
      },
    );
    const afterFail = await e.deps.os.request<{ count: number }>(
      "GET",
      `/${e.cfg.opensearch.alias}/_count`,
    );
    assert.equal(afterFail.count, 0, "照合で止まったときはドキュメントを書かない");

    const body = "照合用の短い本文。";
    const r = await reindexAll(changed, e.deps);
    assert.deepEqual(await e.deps.os.getAliasTargets(e.cfg.opensearch.alias), [r.index]);
    const indexMeta = await e.deps.os.getIndexMeta(r.index);
    const emb = indexMeta?.embedding as { fingerprint: string; parts: Record<string, unknown> };
    assert.equal(emb.fingerprint, expected);
    assert.equal(emb.parts.dimension, changed.embedding.dimension);
    assert.equal(r.upserted, chunkMemory(M.title, body, e.cfg.chunk).length);
    const afterReindex = await e.deps.os.request<{ count: number }>("GET", `/${r.index}/_count`);
    assert.equal(afterReindex.count, r.upserted);
  } finally {
    await e.cleanup();
  }
});

test("(m) _meta の無いインデックスは LEGACY_EMBEDDING の指紋とみなす", async () => {
  const e = await makeTestEnv("pbi024legacy");
  try {
    const legacy = embeddingFingerprint(LEGACY_EMBEDDING);
    assert.equal(embeddingFingerprint(e.cfg.embedding), legacy, "cfg は旧来の既定と同じ指紋");
    const template = JSON.parse(await readFile(e.cfg.opensearch.template_file, "utf8"));
    delete template.mappings._meta;
    const index = `${e.prefix}-legacy`;
    await e.deps.os.createIndex(index, template);
    await e.deps.os.swapAlias(e.cfg.opensearch.alias, index, []);
    assert.equal(await e.deps.os.getIndexMeta(index), undefined);

    assert.deepEqual(await checkEmbeddingCompat(e.cfg, e.deps.os), {
      ok: true,
      index,
      indexFingerprint: legacy,
      expected: legacy,
    });

    const changed = structuredClone(e.cfg);
    changed.embedding.revision = e.cfg.embedding.revision + 1;
    const bad = await checkEmbeddingCompat(changed, e.deps.os);
    assert.equal(bad.ok, false);
    assert.equal(bad.index, index);
    assert.equal(bad.indexFingerprint, legacy);
    assert.equal(bad.expected, embeddingFingerprint(changed.embedding));
  } finally {
    await e.cleanup();
  }
});
