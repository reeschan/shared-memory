// 結合テスト (OpenSearch / Ollama を使うテスト) の共通ヘルパー。
// テスト用のインデックス・エイリアス・パイプラインは必ず `test-` で始まる名前にする。
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { scopeToDir, serializeMemory, type MemoryMeta } from "../src/frontmatter.ts";
import { createEmbedder } from "../src/embed.ts";
import { OpenSearchClient } from "../src/opensearch.ts";
import { StatsStore } from "../src/stats.ts";
import type { Deps } from "../src/indexing.ts";

export type TestEnv = {
  cfg: Config;
  deps: Deps;
  /** テスト用の名前の接頭辞 (`test-<name>-<乱数>`) */
  prefix: string;
  /** memories_dir 配下に serializeMemory で書き、絶対パスを返す */
  writeMemoryFile: (meta: MemoryMeta, body: string) => Promise<string>;
  /** テスト用インデックス・エイリアス・パイプライン・一時ディレクトリを消す */
  cleanup: () => Promise<void>;
};

export async function makeTestEnv(name: string): Promise<TestEnv> {
  const base = loadConfig();
  const prefix = `test-${name.toLowerCase()}-${randomBytes(4).toString("hex")}`;
  const tmpRoot = path.join(tmpdir(), `shared-memory-test-${randomBytes(6).toString("hex")}`);
  const memoriesDir = path.join(tmpRoot, "memories");
  await mkdir(memoriesDir, { recursive: true });

  const cfg: Config = {
    ...structuredClone(base),
    memories_dir: memoriesDir,
    state_db: path.join(tmpRoot, "state", "stats.sqlite"),
    cache_dir: path.join(tmpdir(), "shared-memory-test-cache"),
  };
  cfg.opensearch.alias = prefix;
  cfg.opensearch.index_base = `${prefix}-idx`; // エイリアスと同名にはできない
  cfg.opensearch.pipeline_name = `${prefix}-pipeline`;

  const os = new OpenSearchClient(cfg.opensearch.url);
  const deps: Deps = {
    os,
    embedder: createEmbedder(cfg.embedding, cfg.cache_dir),
    stats: new StatsStore(cfg.state_db),
  };

  const writeMemoryFile = async (meta: MemoryMeta, body: string): Promise<string> => {
    const file = path.join(memoriesDir, ...scopeToDir(meta.scope).split("/"), `${meta.id}.md`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, serializeMemory(meta, body), "utf8");
    return file;
  };

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      deps.stats.close();
    } catch {
      // 既に閉じている
    }
    if (!prefix.startsWith("test-")) throw new Error(`テスト用でない名前: ${prefix}`);
    const rows = await os.request<{ index: string }[]>(
      "GET",
      `/_cat/indices/${encodeURIComponent(prefix)}*?format=json&h=index`,
    );
    for (const r of rows ?? []) {
      if (r.index.startsWith(prefix)) await os.deleteIndex(r.index);
    }
    try {
      await os.request("DELETE", `/_search/pipeline/${encodeURIComponent(cfg.opensearch.pipeline_name)}`);
    } catch (e) {
      if (!/ 404:/.test((e as Error).message)) throw e;
    }
    await rm(tmpRoot, { recursive: true, force: true });
  };

  return { cfg, deps, prefix, writeMemoryFile, cleanup };
}
