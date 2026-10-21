import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findRoot, loadConfig, resolveApiKey } from "../src/config.ts";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

test("findRoot はサブディレクトリからルートを見つける", () => {
  const found = findRoot(join(repoRoot, "packages", "core", "test"));
  assert.equal(found.toLowerCase(), join(repoRoot).toLowerCase().replace(/[\\/]+$/, ""));
});

test("findRoot は見つからなければ throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-noroot-"));
  assert.throws(() => findRoot(dir));
});

test("loadConfig はリポジトリの config.yaml を読み絶対パスに解決する", () => {
  const cfg = loadConfig(repoRoot);
  assert.ok(isAbsolute(cfg.root));
  assert.ok(isAbsolute(cfg.memories_dir));
  assert.ok(cfg.memories_dir.endsWith("memories"));
  assert.ok(isAbsolute(cfg.state_db));
  assert.ok(isAbsolute(cfg.cache_dir));
  assert.ok(isAbsolute(cfg.opensearch.template_file));
  assert.ok(isAbsolute(cfg.opensearch.pipeline_file));
  assert.equal(cfg.opensearch.alias, "memories");
  assert.equal(cfg.search.weights.knn, 0.6);
  assert.equal(cfg.mcp.port, 7820);
  assert.deepEqual(cfg.repos, {});
});

test("loadConfig は必須キー欠けで throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-bad-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), "memories_dir: memories\n");
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  assert.throws(() => loadConfig(dir), /必須キー/);
});

test("loadConfig は config.local.yaml を重ねる (マップは再帰的に、それ以外は上書き)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-local-"));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(
    join(dir, "config.yaml"),
    readFileSync(join(repoRoot, "config.yaml"), "utf8").replace(/^repos:.*$/m, "repos: { a: /x }"),
  );
  const store = join(dir, "store", "memories");
  writeFileSync(
    join(dir, "config.local.yaml"),
    `memories_dir: ${JSON.stringify(store)}\nsearch:\n  weights: { knn: 0.7 }\nrepos: { b: /y }\n`,
  );
  const cfg = loadConfig(dir);
  assert.equal(cfg.memories_dir, store);
  assert.equal(cfg.search.weights.knn, 0.7);
  assert.equal(cfg.search.weights.bm25, 0.4);
  assert.equal(cfg.search.candidates, 50);
  assert.deepEqual(cfg.repos, { a: "/x", b: "/y" });
});

// ---- embedding / rerank / search.rescore の既定値・検証・.env ----

const BASE_HEAD = `memories_dir: memories
state_db: state/stats.sqlite
cache_dir: .cache/embeddings
opensearch:
  url: http://127.0.0.1:9200
  alias: memories
  index_base: memories-x
  template_file: opensearch/index-template.json
  pipeline_name: memories-hybrid
  pipeline_file: opensearch/search-pipeline.json
`;
const EMB = `embedding:
  url: http://127.0.0.1:11434
  model: m
  dimension: 4
  batch_size: 2
`;
const BASE_TAIL = `chunk: { min_chars: 400, max_chars: 800 }
search:
  candidates: 50
  default_limit: 8
  weights: { bm25: 0.4, knn: 0.6 }
  searchable_tiers: [hot, warm]
  half_life_days: 90
  provenance_factor: { human_confirmed: 1.0, agent_verified: 0.85, agent_inferred: 0.7 }
tiers: { warm_after_days: 7, cold_after_days: 30, archive_after_days: 180 }
mcp: { host: 127.0.0.1, port: 7820, path: /mcp }
`;

/** 必須キーをすべて書いた一時ルートを作る。emb は embedding セクション、extra は末尾に足す YAML */
function mkRoot(emb: string = EMB, extra = "", dotenv?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sm-cfg-"));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(dir, "config.yaml"), BASE_HEAD + emb + BASE_TAIL + extra);
  if (dotenv !== undefined) writeFileSync(join(dir, ".env"), dotenv);
  return dir;
}

test("旧キー query_instruction だけの設定が query.prefix に読み替えられる", () => {
  const cfg = loadConfig(mkRoot(EMB + `  query_instruction: "OLD: "\n`));
  assert.equal(cfg.embedding.query.prefix, "OLD: ");
  assert.equal("query_instruction" in cfg.embedding, false);
});

test("query.prefix と query_instruction が両方あれば query.prefix が優先", () => {
  const cfg = loadConfig(mkRoot(EMB + `  query_instruction: "OLD: "\n  query: { prefix: "NEW: " }\n`));
  assert.equal(cfg.embedding.query.prefix, "NEW: ");
});

test("config.local.yaml の旧キー query_instruction は config.yaml の query.prefix より優先", () => {
  const dir = mkRoot(EMB + `  query: { prefix: "DEFAULT: " }\n`);
  writeFileSync(join(dir, "config.local.yaml"), `embedding:\n  query_instruction: "LOCAL: "\n`);
  const cfg = loadConfig(dir);
  assert.equal(cfg.embedding.query.prefix, "LOCAL: ");
  assert.equal("query_instruction" in cfg.embedding, false);
});

test("config.local.yaml に query.prefix と旧キーが両方あれば query.prefix が優先", () => {
  const dir = mkRoot(EMB + `  query: { prefix: "DEFAULT: " }\n`);
  writeFileSync(
    join(dir, "config.local.yaml"),
    `embedding:\n  query_instruction: "OLD: "\n  query: { prefix: "NEW: " }\n`,
  );
  assert.equal(loadConfig(dir).embedding.query.prefix, "NEW: ");
});

test("embedding の省略した項目に既定値が入る", () => {
  const e = loadConfig(mkRoot()).embedding;
  assert.equal(e.provider, "ollama");
  assert.equal(e.normalize, true);
  assert.equal(e.revision, 0);
  assert.equal(e.rpm, undefined);
  assert.equal(e.api_key_env, undefined);
  assert.deepEqual(e.extra_body, {});
  assert.deepEqual(e.query, { prefix: "", params: {} });
  assert.deepEqual(e.document, { prefix: "", params: {} });
});

test("provider に foo を書くと throw", () => {
  assert.throws(() => loadConfig(mkRoot(EMB + "  provider: foo\n")), /embedding\.provider/);
});

test("provider: openai は通る", () => {
  assert.equal(loadConfig(mkRoot(EMB + "  provider: openai\n")).embedding.provider, "openai");
});

test("embedding の数値が不正なら throw", () => {
  assert.throws(() => loadConfig(mkRoot(EMB + "  rpm: 0\n")), /embedding\.rpm/);
  assert.throws(() => loadConfig(mkRoot(EMB + "  revision: -1\n")), /embedding\.revision/);
  assert.throws(() => loadConfig(mkRoot(EMB.replace("dimension: 4", "dimension: abc"))), /embedding\.dimension/);
});

test("rerank セクションが無くても enabled === false と既定値が入る", () => {
  const r = loadConfig(mkRoot()).rerank;
  assert.equal(r.enabled, false);
  assert.equal(r.flavor, "cohere");
  assert.equal(r.url, "");
  assert.equal(r.model, "");
  assert.equal(r.candidates, 20);
  assert.equal(r.max_docs_per_request, 0);
  assert.equal(r.doc_max_chars, 2000);
  assert.equal(r.timeout_ms, 3000);
  assert.deepEqual(r.extra_body, {});
});

test("rerank.enabled: true で url か model が空なら throw", () => {
  assert.throws(() => loadConfig(mkRoot(EMB, "rerank: { enabled: true, model: x }\n")), /rerank\.url/);
  assert.throws(() => loadConfig(mkRoot(EMB, "rerank: { enabled: true, url: 'http://x' }\n")), /rerank\.model/);
  const ok = loadConfig(mkRoot(EMB, "rerank: { enabled: true, url: 'http://x', model: x }\n")).rerank;
  assert.equal(ok.enabled, true);
});

test("rerank.flavor が列挙外なら throw", () => {
  assert.throws(() => loadConfig(mkRoot(EMB, "rerank: { flavor: foo }\n")), /rerank\.flavor/);
  assert.equal(loadConfig(mkRoot(EMB, "rerank: { flavor: tei }\n")).rerank.flavor, "tei");
});

test("search.rescore の既定値と上書き", () => {
  assert.deepEqual(loadConfig(mkRoot()).search.rescore, { decay_floor: 0.7, access_weight: 0.2 });
  const over = mkRoot();
  writeFileSync(
    join(over, "config.yaml"),
    BASE_HEAD + EMB + BASE_TAIL.replace("search:\n", "search:\n  rescore: { decay_floor: 0.5 }\n"),
  );
  assert.deepEqual(loadConfig(over).search.rescore, { decay_floor: 0.5, access_weight: 0.2 });
});

/** BASE_TAIL の search 節の先頭に行を足した config.yaml の一時ルートを作る */
function mkRootWithSearch(lines: string, replaceHalfLife?: string): string {
  const dir = mkRoot();
  let tail = BASE_TAIL.replace("search:\n", `search:\n${lines}`);
  if (replaceHalfLife !== undefined) tail = tail.replace("  half_life_days: 90\n", replaceHalfLife);
  writeFileSync(join(dir, "config.yaml"), BASE_HEAD + EMB + tail);
  return dir;
}

test("search.half_life_days は 1 つの数として読める", () => {
  assert.equal(loadConfig(mkRoot()).search.half_life_days, 90);
});

test("search.half_life_days に旧形式のオブジェクトを書くと「1 つの数にしてください」で throw", () => {
  const dir = mkRootWithSearch("", "  half_life_days: { hot: 30, warm: 60, cold: 120, archive: 365 }\n");
  assert.throws(() => loadConfig(dir), /search\.half_life_days は 1 つの数にしてください/);
});

test("search.half_life_days が 0 以下や数でなければ throw", () => {
  assert.throws(() => loadConfig(mkRootWithSearch("", "  half_life_days: 0\n")), /search\.half_life_days/);
  assert.throws(() => loadConfig(mkRootWithSearch("", "  half_life_days: abc\n")), /search\.half_life_days/);
});

test("search.stale 節が無ければ既定 (episodic 30 / semantic 180、human_confirmed 3、ほか 1)", () => {
  assert.deepEqual(loadConfig(mkRoot()).search.stale, {
    after_days: { episodic: 30, semantic: 180 },
    provenance_multiplier: { human_confirmed: 3, agent_verified: 1, agent_inferred: 1 },
  });
});

test("search.stale の欠けたキーは既定で補い、書いた値は使う", () => {
  const dir = mkRootWithSearch("  stale: { after_days: { episodic: 10 }, provenance_multiplier: { agent_inferred: 0.5 } }\n");
  assert.deepEqual(loadConfig(dir).search.stale, {
    after_days: { episodic: 10, semantic: 180 },
    provenance_multiplier: { human_confirmed: 3, agent_verified: 1, agent_inferred: 0.5 },
  });
});

test("search.stale の値が 0 以下なら throw", () => {
  assert.throws(
    () => loadConfig(mkRootWithSearch("  stale: { after_days: { semantic: 0 } }\n")),
    /search\.stale\.after_days\.semantic/,
  );
  assert.throws(
    () => loadConfig(mkRootWithSearch("  stale: { provenance_multiplier: { human_confirmed: -1 } }\n")),
    /search\.stale\.provenance_multiplier\.human_confirmed/,
  );
});

test(".env の値が process.env に入り、既にある環境変数は上書きされない", () => {
  const A = "SM_TEST_DOTENV_NEW";
  const B = "SM_TEST_DOTENV_EXISTING";
  delete process.env[A];
  process.env[B] = "from-process";
  try {
    loadConfig(mkRoot(EMB, "", `${A}=from-file\n${B}=from-file\n`));
    assert.equal(process.env[A], "from-file");
    assert.equal(process.env[B], "from-process");
  } finally {
    delete process.env[A];
    delete process.env[B];
  }
});

test("embedding.api_key_env の値が空なら throw、あれば resolveApiKey が値を返す", () => {
  const K = "SM_TEST_API_KEY";
  const emb = EMB + `  api_key_env: ${K}\n`;
  delete process.env[K];
  try {
    assert.throws(() => loadConfig(mkRoot(emb)), (e: Error) => /embedding\.api_key_env/.test(e.message));
    process.env[K] = "";
    assert.throws(() => loadConfig(mkRoot(emb)), /embedding\.api_key_env/);
    assert.equal(resolveApiKey(K), undefined);
    // .env から入る場合 (空文字でも設定済みの環境変数は上書きされないので、先に消す)
    delete process.env[K];
    const cfg = loadConfig(mkRoot(emb, "", `${K}=secret-value\n`));
    assert.equal(cfg.embedding.api_key_env, K);
    assert.equal(resolveApiKey(K), "secret-value");
    assert.equal(resolveApiKey(undefined), undefined);
  } finally {
    delete process.env[K];
  }
});

test("エラーメッセージに API キーの値を含めない / rerank.api_key_env は enabled のときだけ確かめる", () => {
  const K = "SM_TEST_RERANK_KEY";
  delete process.env[K];
  assert.doesNotThrow(() => loadConfig(mkRoot(EMB, `rerank: { api_key_env: ${K} }\n`)));
  assert.throws(
    () => loadConfig(mkRoot(EMB, `rerank: { enabled: true, url: 'http://x', model: m, api_key_env: ${K} }\n`)),
    /rerank\.api_key_env/,
  );
});

test("リポジトリの config.yaml は新しい項目の既定値で読める", () => {
  const cfg = loadConfig(repoRoot);
  assert.equal(cfg.embedding.provider, "ollama");
  assert.ok(cfg.embedding.query.prefix.startsWith("Instruct:"));
  assert.equal(cfg.rerank.enabled, false);
  assert.equal(cfg.search.rescore.decay_floor, 0.7);
  assert.equal(cfg.search.half_life_days, 90);
  assert.deepEqual(cfg.search.searchable_tiers, ["hot", "warm", "cold", "archive"]);
  assert.deepEqual(cfg.search.stale.after_days, { episodic: 30, semantic: 180 });
});
