import { readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import type { Config } from "./config.ts";
import {
  memoryRelPath,
  parseMemoryFile,
  serializeMemory,
  validateMeta,
  type Kind,
  type Memory,
  type MemoryMeta,
  type Provenance,
  type SourceAgent,
} from "./frontmatter.ts";
import { findSecrets } from "./secrets.ts";
import { indexIncremental, scanMemories, type Deps } from "./indexing.ts";
import type { OpenSearchClient } from "./opensearch.ts";
import type { Stat, StatsStore } from "./stats.ts";

export type WriteInput = {
  title: string;
  content: string;
  scope: string;
  kind: Kind;
  provenance: Provenance;
  source_agent: SourceAgent;
  supersedes?: string;
  symbol_ref?: string;
  tags?: string[];
};

function toSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/** memories_dir 配下から `<id>.md` を探し、絶対パスを返す */
export function findMemoryPath(cfg: Config, id: string): string | undefined {
  if (!/^[0-9A-Za-z]+$/.test(id)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(cfg.memories_dir, { recursive: true, encoding: "utf8" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const name = `${id}.md`;
  const hit = entries.map(toSlash).sort().find((f) => f.split("/").pop() === name);
  return hit === undefined ? undefined : path.join(cfg.memories_dir, ...hit.split("/"));
}

export async function readMemory(cfg: Config, id: string): Promise<Memory | undefined> {
  const file = findMemoryPath(cfg, id);
  if (file === undefined) return undefined;
  const text = await readFile(file, "utf8");
  const relPath = `${path.basename(cfg.memories_dir)}/${toSlash(path.relative(cfg.memories_dir, file))}`;
  const r = parseMemoryFile(text, relPath);
  if (!r.ok) throw new Error(`${relPath} を読めません: ${r.errors.join("; ")}`);
  return r.memory;
}

export function prepareMemory(
  input: WriteInput,
  opts: { now: Date; existingIds: Set<string> },
): { ok: true; meta: MemoryMeta; body: string } | { ok: false; errors: string[] } {
  const meta: MemoryMeta = {
    id: ulid(opts.now.getTime()),
    title: input.title,
    scope: input.scope,
    kind: input.kind,
    provenance: input.provenance,
    source_agent: input.source_agent,
    created_at: opts.now.toISOString(),
  };
  if (input.supersedes !== undefined) meta.supersedes = input.supersedes;
  if (input.symbol_ref !== undefined) meta.symbol_ref = input.symbol_ref;
  if (input.tags !== undefined) meta.tags = input.tags;

  const errors = validateMeta(meta);
  const content = typeof input.content === "string" ? input.content : "";
  if (content.trim() === "") errors.push("content が空です");
  const secrets = findSecrets(`${typeof input.title === "string" ? input.title : ""}\n${content}`);
  if (secrets.length > 0) errors.push(`秘密情報らしき文字列: ${secrets.join(", ")}`);
  if (input.supersedes !== undefined && !opts.existingIds.has(input.supersedes)) {
    errors.push(`supersedes の id が存在しません: ${String(input.supersedes)}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, meta, body: content.trim() };
}

export async function writeMemory(
  cfg: Config,
  deps: Deps,
  input: WriteInput,
  now: Date = new Date(),
): Promise<{ id: string; path: string }> {
  const { memories } = await scanMemories(cfg);
  const existingIds = new Set(memories.map((m) => m.id));
  const r = prepareMemory(input, { now, existingIds });
  if (!r.ok) throw new Error(r.errors.join("; "));

  const relPath = memoryRelPath(r.meta, path.basename(cfg.memories_dir));
  const file = path.join(cfg.memories_dir, ...relPath.split("/").slice(1));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serializeMemory(r.meta, r.body), { encoding: "utf8", flag: "wx" });
  await indexIncremental(cfg, deps, { only: [file] });
  return { id: r.meta.id, path: relPath };
}

export async function recordAccess(
  cfg: Config,
  deps: { os: OpenSearchClient; stats: StatsStore },
  id: string,
  now: Date = new Date(),
): Promise<Stat> {
  const stat = deps.stats.recordAccess(id, now.toISOString());
  await deps.os.updateByQuery(
    cfg.opensearch.alias,
    { term: { memory_id: id } },
    {
      source:
        "ctx._source.access_count = params.c; " +
        "ctx._source.last_accessed_at = params.l; " +
        "ctx._source.tier = params.t;",
      params: { c: stat.access_count, l: stat.last_accessed_at, t: stat.tier },
    },
  );
  return stat;
}
