import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import type { Provenance, Tier } from "./frontmatter.ts";

export type Config = {
  root: string;
  memories_dir: string;
  state_db: string;
  cache_dir: string;
  opensearch: {
    url: string;
    alias: string;
    index_base: string;
    template_file: string;
    pipeline_name: string;
    pipeline_file: string;
  };
  embedding: {
    url: string;
    model: string;
    dimension: number;
    batch_size: number;
    query_instruction: string;
  };
  chunk: { min_chars: number; max_chars: number };
  search: {
    candidates: number;
    default_limit: number;
    weights: { bm25: number; knn: number };
    searchable_tiers: Tier[];
    half_life_days: Record<Tier, number>;
    provenance_factor: Record<Provenance, number>;
  };
  tiers: { warm_after_days: number; cold_after_days: number; archive_after_days: number };
  mcp: { host: string; port: number; path: string };
  repos: Record<string, string>;
};

export function findRoot(start?: string): string {
  let dir = resolve(start ?? process.env.SHARED_MEMORY_ROOT ?? process.cwd());
  for (;;) {
    if (existsSync(join(dir, "config.yaml")) && existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("リポジトリルートが見つかりません (config.yaml と pnpm-workspace.yaml)");
    }
    dir = parent;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function need(obj: Record<string, unknown>, path: string): void {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (!isObj(cur) || cur[k] === undefined || cur[k] === null) {
      throw new Error(`config.yaml: 必須キー ${path} がありません`);
    }
    cur = cur[k];
  }
}

const REQUIRED = [
  "memories_dir", "state_db", "cache_dir",
  "opensearch.url", "opensearch.alias", "opensearch.index_base", "opensearch.template_file",
  "opensearch.pipeline_name", "opensearch.pipeline_file",
  "embedding.url", "embedding.model", "embedding.dimension", "embedding.batch_size",
  "embedding.query_instruction",
  "chunk.min_chars", "chunk.max_chars",
  "search.candidates", "search.default_limit", "search.weights.bm25", "search.weights.knn",
  "search.searchable_tiers", "search.half_life_days", "search.provenance_factor",
  "tiers.warm_after_days", "tiers.cold_after_days", "tiers.archive_after_days",
  "mcp.host", "mcp.port", "mcp.path",
];

export function loadConfig(root?: string): Config {
  const r = root ? resolve(root) : findRoot();
  const raw: unknown = parse(readFileSync(join(r, "config.yaml"), "utf8"));
  if (!isObj(raw)) throw new Error("config.yaml: トップレベルがマップではありません");
  for (const p of REQUIRED) need(raw, p);
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(r, p));
  const c = raw as unknown as Omit<Config, "root">;
  return {
    ...c,
    root: r,
    memories_dir: abs(c.memories_dir),
    state_db: abs(c.state_db),
    cache_dir: abs(c.cache_dir),
    opensearch: {
      ...c.opensearch,
      template_file: abs(c.opensearch.template_file),
      pipeline_file: abs(c.opensearch.pipeline_file),
    },
    repos: isObj(raw.repos) ? (raw.repos as Record<string, string>) : {},
  };
}
