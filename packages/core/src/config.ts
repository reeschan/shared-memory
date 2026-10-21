import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parse } from "yaml";
import { KINDS, PROVENANCES, type Kind, type Provenance, type Tier } from "./frontmatter.ts";

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
    provider: "ollama" | "openai";
    url: string;
    model: string;
    dimension: number;
    batch_size: number;
    normalize: boolean;
    revision: number;
    rpm?: number;
    api_key_env?: string;
    extra_body: Record<string, unknown>;
    query: { prefix: string; params: Record<string, unknown> };
    document: { prefix: string; params: Record<string, unknown> };
  };
  rerank: {
    enabled: boolean;
    flavor: "cohere" | "voyage" | "tei" | "sarashina";
    url: string;
    model: string;
    path?: string;
    api_key_env?: string;
    candidates: number;
    max_docs_per_request: number;
    doc_max_chars: number;
    timeout_ms: number;
    extra_body: Record<string, unknown>;
  };
  chunk: { min_chars: number; max_chars: number };
  search: {
    candidates: number;
    default_limit: number;
    weights: { bm25: number; knn: number };
    searchable_tiers: Tier[];
    /** rescore の半減期 (日)。tier によらず 1 つの値 */
    half_life_days: number;
    provenance_factor: Record<Provenance, number>;
    rescore: { decay_floor: number; access_weight: number };
    /** 古い記憶の判定。経過日数の閾値 (kind ごと) と、出所ごとの倍率 */
    stale: { after_days: Record<Kind, number>; provenance_multiplier: Record<Provenance, number> };
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
  "chunk.min_chars", "chunk.max_chars",
  "search.candidates", "search.default_limit", "search.weights.bm25", "search.weights.knn",
  "search.searchable_tiers", "search.half_life_days", "search.provenance_factor",
  "tiers.warm_after_days", "tiers.cold_after_days", "tiers.archive_after_days",
  "mcp.host", "mcp.port", "mcp.path",
];

/** マップは再帰的に重ね、それ以外 (配列を含む) は上書きする */
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObj(b) && isObj(v) ? merge(b, v) : v;
  }
  return out;
}

/**
 * 1 つの設定ファイルの中で、旧キー embedding.query_instruction を embedding.query.prefix に移す。
 * 同じファイルに query.prefix があればそちらを残す。重ねる前にファイルごとに行うので、
 * config.local.yaml の旧キーが config.yaml の query.prefix に負けない
 */
function liftLegacyQuery(file: Record<string, unknown>): Record<string, unknown> {
  const e = file.embedding;
  if (!isObj(e) || typeof e.query_instruction !== "string") return file;
  const { query_instruction, ...rest } = e;
  const query = isObj(rest.query) ? rest.query : {};
  return { ...file, embedding: { ...rest, query: { prefix: query_instruction, ...query } } };
}

/** config.yaml に、あれば config.local.yaml (PC ごとの設定。Git 管理外) を重ねる */
function readRaw(r: string): Record<string, unknown> {
  const raw: unknown = parse(readFileSync(join(r, "config.yaml"), "utf8"));
  if (!isObj(raw)) throw new Error("config.yaml: トップレベルがマップではありません");
  const localFile = join(r, "config.local.yaml");
  if (!existsSync(localFile)) return liftLegacyQuery(raw);
  const local: unknown = parse(readFileSync(localFile, "utf8"));
  if (local === null || local === undefined) return liftLegacyQuery(raw);
  if (!isObj(local)) throw new Error("config.local.yaml: トップレベルがマップではありません");
  return merge(liftLegacyQuery(raw), liftLegacyQuery(local));
}

/** `<root>/.env` を読み、まだ設定されていない環境変数だけを process.env に入れる (既存の値は上書きしない) */
function loadDotEnv(r: string): void {
  const file = join(r, ".env");
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (v !== undefined && process.env[k] === undefined) process.env[k] = v;
  }
}

/** API キーの値を環境変数から取り出す。空・未設定なら undefined。値をログやエラーに出さない */
export function resolveApiKey(name?: string): string | undefined {
  if (name === undefined || name === "") return undefined;
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function bad(path: string, what: string): never {
  throw new Error(`config.yaml: ${path} は${what}にしてください`);
}

function optObj(v: unknown, path: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) return bad(path, "マップ");
  return v;
}

function optString(v: unknown, path: string, def: string): string {
  if (v === undefined || v === null) return def;
  if (typeof v !== "string") return bad(path, "文字列");
  return v;
}

function optBool(v: unknown, path: string, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") return bad(path, "true か false");
  return v;
}

function optInt(v: unknown, path: string, def: number, min: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    return bad(path, min >= 1 ? "正の整数" : "0 以上の整数");
  }
  return v;
}

function optEnum<T extends string>(v: unknown, path: string, allowed: readonly T[], def: T): T {
  if (v === undefined || v === null) return def;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    return bad(path, `${allowed.join(" か ")} のどれか`);
  }
  return v as T;
}

function optName(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v === "") return bad(path, "環境変数の名前 (空でない文字列)");
  return v;
}

function normalizePrompt(v: unknown, path: string, legacyPrefix?: string): { prefix: string; params: Record<string, unknown> } {
  const o = optObj(v, path);
  const prefix = o.prefix === undefined || o.prefix === null ? undefined : optString(o.prefix, `${path}.prefix`, "");
  return {
    prefix: prefix ?? legacyPrefix ?? "",
    params: optObj(o.params, `${path}.params`),
  };
}

function checkApiKey(name: string | undefined, path: string): void {
  if (name !== undefined && resolveApiKey(name) === undefined) {
    throw new Error(`config.yaml: ${path} が指す環境変数 ${name} が設定されていないか空です (.env か環境変数に書いてください)`);
  }
}

function normalizeEmbedding(raw: Record<string, unknown>): Config["embedding"] {
  const e = optObj(raw.embedding, "embedding");
  const provider = optEnum(e.provider, "embedding.provider", ["ollama", "openai"] as const, "ollama");
  const legacy = typeof e.query_instruction === "string" ? e.query_instruction : undefined;
  let rpm: number | undefined;
  if (e.rpm !== undefined && e.rpm !== null) {
    if (typeof e.rpm !== "number" || !Number.isFinite(e.rpm) || e.rpm <= 0) bad("embedding.rpm", "正の数");
    rpm = e.rpm as number;
  }
  const api_key_env = optName(e.api_key_env, "embedding.api_key_env");
  checkApiKey(api_key_env, "embedding.api_key_env");
  const out: Config["embedding"] = {
    provider,
    url: optString(e.url, "embedding.url", ""),
    model: optString(e.model, "embedding.model", ""),
    dimension: optInt(e.dimension, "embedding.dimension", 0, 1),
    batch_size: optInt(e.batch_size, "embedding.batch_size", 0, 1),
    normalize: optBool(e.normalize, "embedding.normalize", true),
    revision: optInt(e.revision, "embedding.revision", 0, 0),
    extra_body: optObj(e.extra_body, "embedding.extra_body"),
    query: normalizePrompt(e.query, "embedding.query", legacy),
    document: normalizePrompt(e.document, "embedding.document"),
  };
  if (rpm !== undefined) out.rpm = rpm;
  if (api_key_env !== undefined) out.api_key_env = api_key_env;
  return out;
}

function normalizeRerank(raw: Record<string, unknown>): Config["rerank"] {
  const x = optObj(raw.rerank, "rerank");
  const enabled = optBool(x.enabled, "rerank.enabled", false);
  const out: Config["rerank"] = {
    enabled,
    flavor: optEnum(x.flavor, "rerank.flavor", ["cohere", "voyage", "tei", "sarashina"] as const, "cohere"),
    url: optString(x.url, "rerank.url", ""),
    model: optString(x.model, "rerank.model", ""),
    candidates: optInt(x.candidates, "rerank.candidates", 20, 1),
    max_docs_per_request: optInt(x.max_docs_per_request, "rerank.max_docs_per_request", 0, 0),
    doc_max_chars: optInt(x.doc_max_chars, "rerank.doc_max_chars", 2000, 1),
    timeout_ms: optInt(x.timeout_ms, "rerank.timeout_ms", 3000, 1),
    extra_body: optObj(x.extra_body, "rerank.extra_body"),
  };
  if (x.path !== undefined && x.path !== null) out.path = optString(x.path, "rerank.path", "");
  const api_key_env = optName(x.api_key_env, "rerank.api_key_env");
  if (api_key_env !== undefined) out.api_key_env = api_key_env;
  if (enabled) {
    if (out.url === "") throw new Error("config.yaml: rerank.enabled のときは rerank.url が必要です");
    if (out.model === "") throw new Error("config.yaml: rerank.enabled のときは rerank.model が必要です");
    checkApiKey(api_key_env, "rerank.api_key_env");
  }
  return out;
}

function normalizeRescore(search: Record<string, unknown>): Config["search"]["rescore"] {
  const s = optObj(search.rescore, "search.rescore");
  const num = (v: unknown, path: string, def: number): number => {
    if (v === undefined || v === null) return def;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return bad(path, "0 以上の数");
    return v;
  };
  return {
    decay_floor: num(s.decay_floor, "search.rescore.decay_floor", 0.7),
    access_weight: num(s.access_weight, "search.rescore.access_weight", 0.2),
  };
}

function normalizeHalfLife(search: Record<string, unknown>): number {
  const v = search.half_life_days;
  if (isObj(v)) {
    throw new Error("config.yaml: search.half_life_days は 1 つの数にしてください (tier ごとの値は廃止しました)");
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return bad("search.half_life_days", "正の数");
  return v;
}

const STALE_AFTER_DAYS: Record<Kind, number> = { episodic: 30, semantic: 180 };
const STALE_PROVENANCE_MULTIPLIER: Record<Provenance, number> = {
  human_confirmed: 3,
  agent_verified: 1,
  agent_inferred: 1,
};

function normalizeStale(search: Record<string, unknown>): Config["search"]["stale"] {
  const s = optObj(search.stale, "search.stale");
  const pos = (v: unknown, path: string, def: number): number => {
    if (v === undefined || v === null) return def;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return bad(path, "正の数");
    return v;
  };
  const after = optObj(s.after_days, "search.stale.after_days");
  const mult = optObj(s.provenance_multiplier, "search.stale.provenance_multiplier");
  const after_days = {} as Record<Kind, number>;
  for (const k of KINDS) after_days[k] = pos(after[k], `search.stale.after_days.${k}`, STALE_AFTER_DAYS[k]);
  const provenance_multiplier = {} as Record<Provenance, number>;
  for (const p of PROVENANCES) {
    provenance_multiplier[p] = pos(mult[p], `search.stale.provenance_multiplier.${p}`, STALE_PROVENANCE_MULTIPLIER[p]);
  }
  return { after_days, provenance_multiplier };
}

export function loadConfig(root?: string): Config {
  const r = root ? resolve(root) : findRoot();
  loadDotEnv(r);
  const raw = readRaw(r);
  for (const p of REQUIRED) need(raw, p);
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(r, p));
  const c = raw as unknown as Omit<Config, "root" | "embedding" | "rerank" | "search">;
  const search = raw.search as Record<string, unknown>;
  return {
    ...c,
    root: r,
    embedding: normalizeEmbedding(raw),
    rerank: normalizeRerank(raw),
    search: {
      ...(search as unknown as Omit<Config["search"], "rescore" | "half_life_days" | "stale">),
      half_life_days: normalizeHalfLife(search),
      rescore: normalizeRescore(search),
      stale: normalizeStale(search),
    },
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
