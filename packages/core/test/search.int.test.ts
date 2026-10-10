import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import type { MemoryMeta } from "../src/frontmatter.ts";
import { chunkMemory } from "../src/chunk.ts";
import { ensureSetup, indexIncremental } from "../src/indexing.ts";
import { searchMemories } from "../src/search.ts";
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

const CURRY = meta("カレーの作り方", { scope: "project:kitchen" });
const CURRY_BODY =
  "玉ねぎを飴色になるまで30分炒めてから、牛肉とにんじんとじゃがいもを加える。水を入れて20分煮込み、火を止めてからカレールウを溶かす。隠し味にはちみつを小さじ1入れる。";
const TRAIN = meta("通勤経路のメモ", { scope: "global" });
const TRAIN_BODY = "朝は山手線で新宿から渋谷へ行き、東急東横線に乗り換える。8時台は混むので7時半の電車に乗る。";
const GARDEN = meta("家庭菜園のトマト", { scope: "global", kind: "episodic" });
const GARDEN_BODY = "ミニトマトの苗は5月に植え、支柱を立ててわき芽をこまめに摘む。水やりは土が乾いてから朝にたっぷり与える。";
const BACKUP = meta("バックアップ運用", { scope: "repo:infra", provenance: "human_confirmed" });
const BACKUP_BODY = "データベースのバックアップは毎晩2時に取得し、30日分を S3 に保管する。復元手順は月に一度リハーサルする。";
const PIANO = meta("ピアノ練習の記録", { scope: "global", kind: "episodic" });
const PIANO_BODY = "ショパンのノクターン第2番を練習した。左手のアルペジオが走りがちなのでメトロノームを60に落として弾いた。";

// 置き換えられる古いメモリと新しいメモリ
const OLD_PW = meta("Wi-Fi のパスワード変更手順 (旧)", { scope: "global" });
const OLD_PW_BODY = "ルーターの管理画面に192.168.0.1でログインし、無線設定からWi-Fiのパスワードを変更する。";
const NEW_PW = meta("Wi-Fi のパスワード変更手順", { scope: "global", supersedes: OLD_PW.id });
const NEW_PW_BODY = "ルーターの管理画面に192.168.1.1でログインし、無線設定のセキュリティ欄からWi-Fiのパスワードを変更する。";

// 複数チャンクになる長いメモリ (どのチャンクも同じ話題)
const para = (s: string, n: number) => Array.from({ length: n }, () => s).join("");
const SOURDOUGH = meta("サワードウ（天然酵母パン）の焼き方", { scope: "global" });
const SOURDOUGH_BODY = [
  "## 酵母の準備",
  "",
  para("サワードウの天然酵母はライ麦粉と水を毎日足して育てる。", 20),
  "",
  "## 生地づくり",
  "",
  para("サワードウの生地は強力粉と天然酵母を混ぜて一晩冷蔵庫で発酵させる。", 20),
  "",
  "## 焼成",
  "",
  para("サワードウはダッチオーブンで250度に予熱してから蓋をして焼く。", 20),
].join("\n");

const ALL: [MemoryMeta, string][] = [
  [CURRY, CURRY_BODY],
  [TRAIN, TRAIN_BODY],
  [GARDEN, GARDEN_BODY],
  [BACKUP, BACKUP_BODY],
  [PIANO, PIANO_BODY],
  [OLD_PW, OLD_PW_BODY],
  [NEW_PW, NEW_PW_BODY],
  [SOURDOUGH, SOURDOUGH_BODY],
];

before(async () => {
  env = await makeTestEnv("pbi009");
  await ensureSetup(env.cfg, env.deps.os);
  for (const [m, b] of ALL) await env.writeMemoryFile(m, b);
  const r = await indexIncremental(env.cfg, env.deps);
  assert.deepEqual(r.invalid, []);
  assert.equal(r.scanned, ALL.length);
});

after(async () => {
  await env?.cleanup();
});

const search = (input: Parameters<typeof searchMemories>[2]) =>
  searchMemories(env.cfg, env.deps, input, new Date("2026-10-10T00:00:00.000Z"));

test("(a) 内容に関する質問文で、そのメモリが 1 位", async () => {
  const cases: [string, MemoryMeta][] = [
    ["カレーを作るとき玉ねぎは何分炒める？", CURRY],
    ["データベースのバックアップは何日分保存している？", BACKUP],
    ["ミニトマトのわき芽はどうする？", GARDEN],
  ];
  for (const [q, m] of cases) {
    const res = await search({ query: q });
    assert.ok(res.length > 0, q);
    assert.equal(res[0]!.id, m.id, `${q} -> ${res.map((r) => r.title).join(", ")}`);
    assert.equal(res[0]!.title, m.title);
    assert.equal(res[0]!.scope, m.scope);
    assert.equal(res[0]!.kind, m.kind);
    assert.equal(res[0]!.provenance, m.provenance);
    assert.equal(res[0]!.created_at, m.created_at);
    assert.ok(res[0]!.score > 0);
  }
});

test("(b) is_superseded のメモリは結果に出ない", async () => {
  const res = await search({ query: "Wi-Fi のパスワードを変更するにはルーターの管理画面にログインする", limit: 50 });
  const ids = res.map((r) => r.id);
  assert.ok(ids.includes(NEW_PW.id), "新しいメモリは出る");
  assert.ok(!ids.includes(OLD_PW.id), "置き換えられたメモリは出ない");
});

test("(c) scope 指定で他 scope が出ない", async () => {
  const res = await search({ query: "カレーの作り方と通勤経路", scope: "global", limit: 50 });
  assert.ok(res.length > 0);
  for (const r of res) assert.equal(r.scope, "global");
  assert.ok(!res.some((r) => r.id === CURRY.id));

  const kitchen = await search({ query: "カレー", scope: "project:kitchen", limit: 50 });
  assert.deepEqual(kitchen.map((r) => r.id), [CURRY.id]);
});

test("(d) 同じメモリの複数チャンクがヒットしても 1 件にまとまる", async () => {
  const n = chunkMemory(SOURDOUGH.title, SOURDOUGH_BODY, env.cfg.chunk).length;
  assert.ok(n >= 3, `チャンク数 ${n}`);
  const raw = await env.deps.os.search(env.cfg.opensearch.alias, {
    size: 50,
    query: { match: { content: "サワードウ" } },
    _source: ["memory_id"],
  });
  const rawHits = raw.hits.filter((h: any) => h._source.memory_id === SOURDOUGH.id).length;
  assert.ok(rawHits >= 2, `生のヒット ${rawHits}`);

  const res = await search({ query: "サワードウの天然酵母と焼き方", limit: 50 });
  assert.equal(res.filter((r) => r.id === SOURDOUGH.id).length, 1);
  assert.equal(res[0]!.id, SOURDOUGH.id);
  assert.equal(new Set(res.map((r) => r.id)).size, res.length);
  // limit が効く
  assert.ok((await search({ query: "サワードウの天然酵母と焼き方", limit: 2 })).length <= 2);
});

test("(e) excerpt は 160 字以下で title の接頭辞を含まない", async () => {
  const res = await search({ query: "サワードウの焼き方", limit: 50 });
  assert.ok(res.length > 0);
  for (const r of res) {
    assert.ok(r.excerpt.length <= 160, `${r.title}: ${r.excerpt.length}`);
    assert.ok(!r.excerpt.startsWith(r.title), `${r.title}: ${r.excerpt}`);
    assert.ok(!r.excerpt.includes("\n"));
    assert.ok(r.excerpt.length > 0);
  }
  const sd = res.find((r) => r.id === SOURDOUGH.id)!;
  assert.equal(sd.excerpt.length, 160);
  const curry = (await search({ query: "カレーの隠し味" })).find((r) => r.id === CURRY.id)!;
  assert.equal(curry.excerpt, CURRY_BODY);
});
