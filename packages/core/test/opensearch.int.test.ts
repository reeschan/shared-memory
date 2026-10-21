import { test, after } from "node:test";
import assert from "node:assert/strict";
import { OpenSearchClient } from "../src/opensearch.ts";
import { loadConfig } from "../src/config.ts";

const os = new OpenSearchClient(loadConfig().opensearch.url);
const P = "test-pbi006-";
const created: string[] = [];

async function make(name: string, body: object = {}): Promise<string> {
  const n = P + name;
  created.push(n);
  await os.createIndex(n, body);
  return n;
}

after(async () => {
  for (const n of created) {
    if (await os.indexExists(n)) await os.deleteIndex(n);
  }
});

test("createIndex / indexExists / deleteIndex", async () => {
  const n = await make("exists");
  assert.equal(await os.indexExists(n), true);
  await os.deleteIndex(n);
  assert.equal(await os.indexExists(n), false);
});

test("getAliasTargets / swapAlias", async () => {
  const a = await make("alias-a");
  const b = await make("alias-b");
  const alias = P + "alias";
  assert.deepEqual(await os.getAliasTargets(alias), []);
  await os.swapAlias(alias, a, []);
  assert.deepEqual(await os.getAliasTargets(alias), [a]);
  await os.swapAlias(alias, b, [a]);
  assert.deepEqual(await os.getAliasTargets(alias), [b]);
});

test("bulk 3 件 -> refresh -> search", async () => {
  const n = await make("bulk");
  const r = await os.bulk(
    [1, 2, 3].flatMap((i) => [{ index: { _index: n, _id: `d${i}` } }, { title: `日本語${i}` }]),
  );
  assert.equal(r.errors, false);
  assert.deepEqual(r.failed, []);
  await os.refresh(n);
  const s = await os.search(n, { query: { match_all: {} } });
  assert.equal(s.hits.length, 3);
  assert.deepEqual(await os.bulk([]), { errors: false, failed: [] });
});

test("bulk の失敗を failed に返す", async () => {
  const n = await make("bulkfail");
  const r = await os.bulk([
    { index: { _index: n, _id: "ok" } },
    { v: 1 },
    { update: { _index: n, _id: "missing" } },
    { doc: { v: 2 } },
  ]);
  assert.equal(r.errors, true);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]!.id, "missing");
});

test("scanAll は 1500 件すべて返す", async () => {
  const n = await make("scan");
  const lines: object[] = [];
  for (let i = 0; i < 1500; i++) lines.push({ index: { _index: n, _id: `s${i}` } }, { n: i, other: "x" });
  const r = await os.bulk(lines, true);
  assert.equal(r.errors, false);
  const all = await os.scanAll<{ n: number }>(n, { match_all: {} }, ["n"]);
  assert.equal(all.length, 1500);
  assert.equal(new Set(all.map((h) => h._id)).size, 1500);
  assert.equal("other" in all[0]!._source, false);
});

test("updateByQuery は更新件数を返し値が変わる", async () => {
  const n = await make("ubq");
  await os.bulk(
    [1, 2, 3].flatMap((i) => [{ index: { _index: n, _id: `u${i}` } }, { tier: i === 3 ? "cold" : "hot" }]),
    true,
  );
  const updated = await os.updateByQuery(
    n,
    { term: { "tier.keyword": "hot" } },
    { source: "ctx._source.tier = params.t", params: { t: "warm" } },
  );
  assert.equal(updated, 2);
  const s = await os.search<{ tier: string }>(n, { query: { match_all: {} }, size: 10 });
  assert.deepEqual(s.hits.map((h) => h._source.tier).sort(), ["cold", "warm", "warm"]);
});

test("存在しないインデックスの scanAll は []", async () => {
  assert.deepEqual(await os.scanAll(P + "nonexistent", { match_all: {} }, ["x"]), []);
});
