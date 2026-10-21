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
import { serializeMemory, OpenSearchClient, loadConfig, type MemoryMeta } from "@shared-memory/core";

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

function memory(id: string, title: string, content: string): { meta: MemoryMeta; body: string } {
  return {
    meta: {
      id,
      title,
      scope: "global",
      kind: "semantic",
      provenance: "agent_verified",
      source_agent: "claude",
      created_at: "2026-10-01T00:00:00.000Z",
    },
    body: content,
  };
}

const MEMORIES = [
  memory("01JA0000000000000000000001", "ペンギンの餌", "南極のペンギンは主にオキアミを食べる。群れで狩りをする。"),
  memory("01JA0000000000000000000002", "コーヒー豆の焙煎", "深煎りは苦味が強く、浅煎りは酸味が立つ。焙煎度は豆の種類で選ぶ。"),
  memory("01JA0000000000000000000003", "自転車のブレーキ", "油圧ディスクブレーキは雨の日でも制動力が落ちにくい。"),
];

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

test("index --json: scanned が 3", () => {
  const r = run(["index", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { scanned: number; upserted: number };
  assert.equal(out.scanned, 3);
  assert.equal(out.upserted, 3);
});

test("search --json: 1 件目が期待どおり", () => {
  const r = run(["search", "オキアミ", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { id: string }[];
  assert.equal(out[0]?.id, MEMORIES[0]!.meta.id);
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

test("引数なし・未知のコマンドは使い方を表示して終了コード 1", () => {
  for (const args of [[], ["no-such-command"]]) {
    const r = run(args);
    assert.equal(r.status, 1);
    const text = r.stdout + r.stderr;
    for (const c of ["setup", "index", "reindex", "search"]) assert.ok(text.includes(c), `${c} が無い`);
  }
});
