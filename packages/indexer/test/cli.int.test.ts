// CLI の結合テスト。OpenSearch / Ollama を使う。本番のエイリアス・メモリ・state には触れず、
// os.tmpdir() の一時ルートで子プロセスとして CLI を起動する。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeMemory, OpenSearchClient, StatsStore, loadConfig, type MemoryMeta } from "@shared-memory/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = path.join(repoRoot, "packages/indexer/src/cli.ts");

// config.yaml の読み取りに core の依存 (yaml) を使う
const coreRequire = createRequire(path.join(repoRoot, "packages/core/package.json"));
const { parse, stringify } = coreRequire("yaml") as {
  parse(text: string): unknown;
  stringify(value: unknown): string;
};

const rand = randomBytes(4).toString("hex");
const prefix = `test-cli-${rand}`;
const root = path.join(tmpdir(), `shared-memory-cli-${randomBytes(6).toString("hex")}`);
let os: OpenSearchClient;

type RunResult = { status: number | null; stdout: string; stderr: string };

function run(args: string[]): RunResult {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, SHARED_MEMORY_ROOT: root },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

function memory(
  id: string,
  title: string,
  content: string,
  createdAt: string = daysAgo(10),
): { meta: MemoryMeta; body: string } {
  return {
    meta: {
      id,
      title,
      scope: "global",
      kind: "semantic",
      provenance: "agent_verified",
      source_agent: "claude",
      created_at: createdAt,
    },
    body: content,
  };
}

const MEMORIES = [
  memory("01JA0000000000000000000001", "ペンギンの餌", "南極のペンギンは主にオキアミを食べる。群れで狩りをする。"),
  memory("01JA0000000000000000000002", "コーヒー豆の焙煎", "深煎りは苦味が強く、浅煎りは酸味が立つ。焙煎度は豆の種類で選ぶ。"),
  memory("01JA0000000000000000000003", "自転車のブレーキ", "油圧ディスクブレーキは雨の日でも制動力が落ちにくい。"),
  // semantic の stale の閾値 (180 日) より古い
  memory(
    "01JA0000000000000000000004",
    "灯台のレンズ",
    "古い灯台はフレネルレンズで光を遠くまで届ける。",
    daysAgo(400),
  ),
];
const OLD = MEMORIES[3]!;
const statsPath = (): string => path.join(root, "state", "stats.sqlite");

function countCliSearchLogs(): number {
  const s = new StatsStore(statsPath());
  try {
    return s.readLogs("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z").searches.filter((e) => e.source === "cli")
      .length;
  } finally {
    s.close();
  }
}

before(async () => {
  const prod = parse(await readFile(path.join(repoRoot, "config.yaml"), "utf8")) as Record<string, any>;
  const base = loadConfig();
  os = new OpenSearchClient(base.opensearch.url);
  const cfg = {
    ...prod,
    memories_dir: "memories",
    state_db: "state/stats.sqlite",
    cache_dir: ".cache/embeddings",
    opensearch: {
      ...prod.opensearch,
      url: base.opensearch.url,
      alias: prefix,
      index_base: `${prefix}-idx`,
      pipeline_name: `${prefix}-pipeline`,
      template_file: path.join(repoRoot, "opensearch/index-template.json"),
      pipeline_file: path.join(repoRoot, "opensearch/search-pipeline.json"),
    },
    // provider・url・prefix などを、loadConfig() で確定した埋め込みの設定に揃える
    embedding: base.embedding,
  };
  await mkdir(path.join(root, "memories", "global"), { recursive: true });
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(path.join(root, "config.yaml"), stringify(cfg));
  for (const m of MEMORIES) {
    await writeFile(path.join(root, "memories", "global", `${m.meta.id}.md`), serializeMemory(m.meta, m.body));
  }
});

after(async () => {
  // reindex で増えた -r... も含めて、テスト用のインデックスを全部消す
  const cat = await os.request<{ index: string }[]>("GET", `/_cat/indices/${prefix}*?format=json`).catch(() => []);
  for (const { index } of cat) await os.deleteIndex(index).catch(() => {});
  await os.request("DELETE", `/_search/pipeline/${prefix}-pipeline`).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

test("setup が終了コード 0", () => {
  const r = run(["setup"]);
  assert.equal(r.status, 0, r.stderr);
});

test("index --json: scanned がメモリの数", () => {
  const r = run(["index", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { scanned: number; upserted: number };
  assert.equal(out.scanned, MEMORIES.length);
  assert.equal(out.upserted, MEMORIES.length);
});

test("search --json: 1 件目が期待どおりで、各要素に freshness がある", () => {
  const r = run(["search", "オキアミ", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { id: string; freshness?: { stale: boolean; age_days: number } }[];
  assert.equal(out[0]?.id, MEMORIES[0]!.meta.id);
  assert.ok(out.length > 0);
  for (const e of out) {
    assert.ok(e.freshness !== undefined, `${e.id} に freshness が無い`);
    assert.equal(typeof e.freshness.stale, "boolean");
    assert.equal(typeof e.freshness.age_days, "number");
  }
});

test("search のテキスト出力: 作成日を出し、古いメモリだけに [古い記憶: N 日前] を付ける", () => {
  const r = run(["search", "灯台 フレネルレンズ", "--limit", "10"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split(/\r?\n/);
  const oldLine = lines.find((l) => l.includes(`[${OLD.meta.id}]`));
  assert.ok(oldLine !== undefined, r.stdout);
  assert.ok(oldLine.includes(`${OLD.meta.created_at.slice(0, 10)} 作成`), oldLine);
  assert.match(oldLine, /\[古い記憶: \d+ 日前\]$/);
  assert.ok(oldLine.includes("[古い記憶: 400 日前]"), oldLine);

  const r2 = run(["search", "オキアミ", "--limit", "10"]);
  assert.equal(r2.status, 0, r2.stderr);
  const newLine = r2.stdout.split(/\r?\n/).find((l) => l.includes(`[${MEMORIES[0]!.meta.id}]`));
  assert.ok(newLine !== undefined, r2.stdout);
  assert.match(newLine, /\d{4}-\d{2}-\d{2} 作成\)$/);
  assert.ok(newLine.includes(`${MEMORIES[0]!.meta.created_at.slice(0, 10)} 作成`), newLine);
  assert.ok(!newLine.includes("古い記憶"), newLine);
});

test("search の後、state_db の search_log に source cli の行が 1 行増える", () => {
  const before = countCliSearchLogs();
  const r = run(["search", "コーヒー", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(countCliSearchLogs(), before + 1);
});

test("reindex --json: index が -r を含む新しい名前", () => {
  const r = run(["reindex", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { index: string };
  assert.match(out.index, /-r\d+$/);
  assert.notEqual(out.index, `${prefix}-idx`);
});

test("不正な front matter があっても index は終了コード 0 でその path を出す", async () => {
  const bad = "memories/global/broken.md";
  await writeFile(path.join(root, bad), "---\nid: not-a-ulid\n---\n\n本文\n");
  const r = run(["index", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(bad), r.stdout);
  const out = JSON.parse(r.stdout) as { invalid: { path: string }[] };
  assert.ok(out.invalid.some((i) => i.path === bad));
});

test("decay --json: 90 日より古いログ行を消し、pruned に件数を出す", () => {
  const s = new StatsStore(statsPath());
  try {
    s.logSearch({ at: daysAgo(100), source: "cli", query: "古い検索", filters: {}, results: [] });
    s.logSearch({ at: daysAgo(95), source: "mcp", query: "古い検索 2", filters: {}, results: [] });
    s.logGet({ at: daysAgo(120), source: "mcp", memory_id: MEMORIES[0]!.meta.id });
    s.logSearch({ at: daysAgo(10), source: "cli", query: "新しい検索", filters: {}, results: [] });
  } finally {
    s.close();
  }
  const r = run(["decay", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { pruned: { searches: number; gets: number } };
  assert.deepEqual(out.pruned, { searches: 2, gets: 1 });

  const s2 = new StatsStore(statsPath());
  try {
    const logs = s2.readLogs("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z");
    assert.ok(!logs.searches.some((e) => e.query.startsWith("古い検索")));
    assert.ok(logs.searches.some((e) => e.query === "新しい検索"));
    assert.equal(logs.gets.length, 0);
  } finally {
    s2.close();
  }

  // テキスト出力にも 1 行出る (消すものは残っていない)
  const r2 = run(["decay"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.stdout.includes("ログ削除: 検索 0 件 / get 0 件"), r2.stdout);
});

test("引数なし・未知のコマンドは使い方を表示して終了コード 1", () => {
  for (const args of [[], ["no-such-command"]]) {
    const r = run(args);
    assert.equal(r.status, 1);
    const text = r.stdout + r.stderr;
    for (const c of ["setup", "index", "reindex", "search"]) assert.ok(text.includes(c), `${c} が無い`);
  }
});
