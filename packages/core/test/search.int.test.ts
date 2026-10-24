import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import type { MemoryMeta } from "../src/frontmatter.ts";
import { chunkMemory } from "../src/chunk.ts";
import { ensureSetup, indexIncremental } from "../src/indexing.ts";
import { searchMemories, type AsOf } from "../src/search.ts";
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

// 作業空間 (project:work.*) のメモリ。どれも既存のメモリと同じ語を含み、scope なしの検索で当たる内容
const WS_A = "project:work.demo.main.W-001";
const HANDOFF_A = meta("引き継ぎ: カレーの仕込み", { scope: WS_A, kind: "episodic", tags: ["handoff"] });
const HANDOFF_A_BODY =
  "カレーの仕込みは、玉ねぎを飴色になるまで30分炒めるところまで終えた。次は牛肉とにんじんとじゃがいもを加えて20分煮込み、火を止めてからカレールウを溶かす。";
// 作業空間 A の「完了」メモリ。同じ作業空間の引き継ぎを置き換える
const DONE_A = meta("完了: カレーの仕込み", {
  scope: WS_A,
  kind: "episodic",
  tags: ["handoff"],
  supersedes: HANDOFF_A.id,
});
const DONE_A_BODY =
  "カレーの仕込みは完了した。玉ねぎを飴色になるまで30分炒め、牛肉とにんじんとじゃがいもを加えて20分煮込み、カレールウを溶かした。";
const WS_B = "project:work.demo.main.W-002";
const HANDOFF_B = meta("引き継ぎ: 通勤経路のメモ", { scope: WS_B, kind: "episodic", tags: ["handoff"] });
const HANDOFF_B_BODY =
  "通勤は朝、山手線で新宿から渋谷へ行き、東急東横線に乗り換える。8時台は混むので7時半の電車に乗る。";

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
  [HANDOFF_A, HANDOFF_A_BODY],
  [DONE_A, DONE_A_BODY],
  [HANDOFF_B, HANDOFF_B_BODY],
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

const searchAsOf = (input: Parameters<typeof searchMemories>[2], asOf: AsOf) =>
  searchMemories(env.cfg, env.deps, input, new Date("2026-10-10T00:00:00.000Z"), { asOf });

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

test("(f) scope なしの検索で作業空間のメモリが 1 件も出ない", async () => {
  const workspace = [HANDOFF_A, DONE_A, HANDOFF_B];
  const cases: [string, MemoryMeta][] = [
    ["カレーの仕込みはどこまで進んだ？", CURRY],
    ["通勤経路はどう行く？", TRAIN],
    ["データベースのバックアップは何日分保存している？", BACKUP],
  ];
  for (const [q, expected] of cases) {
    const res = await search({ query: q, limit: 50 });
    const ids = res.map((r) => r.id);
    const titles = res.map((r) => r.title).join(", ");
    // 作業空間でない project・global・repo のメモリは今までどおり出る
    assert.ok(ids.includes(expected.id), `${q}: ${expected.title} が出ない (${titles})`);
    for (const m of workspace) assert.ok(!ids.includes(m.id), `${q}: 作業空間のメモリが出た (${titles})`);
    for (const r of res) assert.ok(!r.scope.startsWith("project:work."), `${q}: 作業空間の scope が出た: ${r.scope}`);
  }
});

test("(g) include_workspaces: true で置き換えられていない作業空間のメモリが出る", async () => {
  const curry = await search({ query: "カレーの仕込みはどこまで進んだ？", include_workspaces: true, limit: 50 });
  const curryIds = curry.map((r) => r.id);
  assert.ok(curryIds.includes(DONE_A.id), `A の完了メモリが出ない (${curry.map((r) => r.title).join(", ")})`);
  assert.ok(!curryIds.includes(HANDOFF_A.id), "置き換えられた引き継ぎは出ない");
  assert.ok(curryIds.includes(CURRY.id), "作業空間でない project のメモリも出る");

  const train = await search({ query: "通勤経路はどう行く？", include_workspaces: true, limit: 50 });
  assert.ok(
    train.map((r) => r.id).includes(HANDOFF_B.id),
    `B のメモリが出ない (${train.map((r) => r.title).join(", ")})`,
  );
});

test("(h) scope に作業空間 A を明示すると A のメモリだけが出る", async () => {
  const res = await search({ query: "カレーの仕込み", scope: WS_A, limit: 50 });
  assert.ok(res.length > 0);
  const ids = res.map((r) => r.id);
  assert.ok(ids.includes(DONE_A.id), `A の完了メモリが出ない (${res.map((r) => r.title).join(", ")})`);
  assert.ok(!ids.includes(HANDOFF_A.id), "置き換えられた引き継ぎは出ない");
  assert.ok(!ids.includes(HANDOFF_B.id), "作業空間 B は出ない");
  assert.ok(!ids.includes(CURRY.id), "ほかの scope は出ない");
  for (const r of res) assert.equal(r.scope, WS_A);
});

test("(i) asOf 付きの scope なしの検索でも作業空間のメモリが出ない", async () => {
  const asOf: AsOf = {
    at: new Date("2026-10-10T00:00:00.000Z"),
    supersededAt: new Map([[HANDOFF_A.id, DONE_A.created_at]]),
  };
  const res = await searchAsOf({ query: "カレーの仕込みと通勤経路", limit: 50 }, asOf);
  assert.ok(res.length > 0);
  const ids = res.map((r) => r.id);
  const titles = res.map((r) => r.title).join(", ");
  for (const m of [HANDOFF_A, DONE_A, HANDOFF_B]) assert.ok(!ids.includes(m.id), `asOf: 作業空間のメモリが出た (${titles})`);
  for (const r of res) assert.ok(!r.scope.startsWith("project:work."), `asOf: 作業空間の scope が出た: ${r.scope}`);
  assert.ok(ids.includes(CURRY.id), `asOf: 既存のメモリが出ない (${titles})`);
  assert.ok(ids.includes(TRAIN.id), `asOf: 既存のメモリが出ない (${titles})`);
});

// (i) と同じ asOf。HANDOFF_A は DONE_A に置き換えられた時点を再現する
const asOfWithDoneA: AsOf = {
  at: new Date("2026-10-10T00:00:00.000Z"),
  supersededAt: new Map([[HANDOFF_A.id, DONE_A.created_at]]),
};

test("(j) asOf 付きの include_workspaces: true で置き換えられていない作業空間のメモリが出る", async () => {
  const res = await searchAsOf({ query: "カレーの仕込みと通勤経路", include_workspaces: true, limit: 50 }, asOfWithDoneA);
  const ids = res.map((r) => r.id);
  const titles = res.map((r) => r.title).join(", ");
  assert.ok(ids.includes(DONE_A.id), `asOf: A の完了メモリが出ない (${titles})`);
  assert.ok(ids.includes(HANDOFF_B.id), `asOf: B のメモリが出ない (${titles})`);
  assert.ok(!ids.includes(HANDOFF_A.id), `asOf: 置き換えられた引き継ぎが出た (${titles})`);
});

test("(k) asOf 付きで scope に作業空間 A を明示すると A のメモリだけが出る", async () => {
  const res = await searchAsOf({ query: "カレーの仕込み", scope: WS_A, limit: 50 }, asOfWithDoneA);
  const ids = res.map((r) => r.id);
  const titles = res.map((r) => r.title).join(", ");
  assert.deepEqual(ids, [DONE_A.id], `asOf: A の完了メモリだけが出ない (${titles})`);
  assert.ok(!ids.includes(HANDOFF_A.id), `asOf: 置き換えられた引き継ぎが出た (${titles})`);
  assert.ok(!ids.includes(HANDOFF_B.id), `asOf: 作業空間 B が出た (${titles})`);
  assert.ok(!ids.includes(CURRY.id), `asOf: ほかの scope が出た (${titles})`);
  for (const r of res) assert.equal(r.scope, WS_A);
});
