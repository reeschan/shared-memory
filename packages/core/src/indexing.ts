import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { parseMemoryFile, type Memory, type Tier } from "./frontmatter.ts";
import { chunkMemory, contentHash } from "./chunk.ts";
import type { Embedder } from "./embed.ts";
import type { OpenSearchClient } from "./opensearch.ts";
import type { StatsStore } from "./stats.ts";

export type Deps = { os: OpenSearchClient; embedder: Embedder; stats: StatsStore };

export type IndexReport = {
  scanned: number;
  invalid: { path: string; errors: string[] }[];
  embedded: number;
  cached: number;
  upserted: number;
  updated: number;
  deleted: number;
};

/** bulk 1 回あたりの最大行数 (アクション行 + ソース行) */
const BULK_LINES = 400;

function toSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

export async function scanMemories(
  cfg: Config,
): Promise<{ memories: Memory[]; invalid: { path: string; errors: string[] }[] }> {
  const dirName = path.basename(cfg.memories_dir);
  let entries: string[];
  try {
    entries = await readdir(cfg.memories_dir, { recursive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { memories: [], invalid: [] };
    throw e;
  }
  const files = entries.map(toSlash).filter((f) => f.endsWith(".md")).sort();
  const memories: Memory[] = [];
  const invalid: { path: string; errors: string[] }[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    const relPath = `${dirName}/${f}`;
    const text = await readFile(path.join(cfg.memories_dir, f), "utf8");
    const r = parseMemoryFile(text, relPath);
    if (!r.ok) {
      invalid.push({ path: relPath, errors: r.errors });
      continue;
    }
    const dup = seen.get(r.memory.id);
    if (dup !== undefined) {
      invalid.push({ path: relPath, errors: [`id ${r.memory.id} が ${dup} と重複しています`] });
      continue;
    }
    seen.set(r.memory.id, relPath);
    memories.push(r.memory);
  }
  return { memories, invalid };
}

export function computeSuperseded(memories: Memory[]): Set<string> {
  const s = new Set<string>();
  for (const m of memories) if (m.supersedes) s.add(m.supersedes);
  return s;
}

async function putPipeline(cfg: Config, os: OpenSearchClient): Promise<void> {
  const body = JSON.parse(await readFile(cfg.opensearch.pipeline_file, "utf8"));
  const proc = body?.phase_results_processors?.[0]?.["normalization-processor"];
  if (!proc?.combination) {
    throw new Error(`${cfg.opensearch.pipeline_file}: normalization-processor.combination がありません`);
  }
  proc.combination.parameters = {
    ...(proc.combination.parameters ?? {}),
    weights: [cfg.search.weights.bm25, cfg.search.weights.knn],
  };
  await os.putSearchPipeline(cfg.opensearch.pipeline_name, body);
}

async function readTemplate(cfg: Config): Promise<object> {
  return JSON.parse(await readFile(cfg.opensearch.template_file, "utf8")) as object;
}

export async function ensureSetup(
  cfg: Config,
  os: OpenSearchClient,
): Promise<{ createdIndex?: string }> {
  const { alias, index_base } = cfg.opensearch;
  let createdIndex: string | undefined;
  const targets = await os.getAliasTargets(alias);
  if (targets.length === 0) {
    if (!(await os.indexExists(index_base))) {
      await os.createIndex(index_base, await readTemplate(cfg));
      createdIndex = index_base;
    }
    await os.swapAlias(alias, index_base, []);
  }
  await putPipeline(cfg, os);
  return createdIndex === undefined ? {} : { createdIndex };
}

type ExistingSource = {
  memory_id: string;
  content_hash: string;
  is_superseded?: boolean;
  tier?: Tier;
  access_count?: number;
  last_accessed_at?: string | null;
};

type DynamicFields = {
  is_superseded: boolean;
  tier: Tier;
  access_count: number;
  last_accessed_at: string | null;
};

function normalizeOnly(cfg: Config, only: string[]): Set<string> {
  const dirName = path.basename(cfg.memories_dir);
  const out = new Set<string>();
  for (const p of only) {
    if (path.isAbsolute(p)) {
      out.add(`${dirName}/${toSlash(path.relative(cfg.memories_dir, p))}`);
    } else {
      out.add(toSlash(p).replace(/^\.\//, ""));
    }
  }
  return out;
}

export async function indexIncremental(
  cfg: Config,
  deps: Deps,
  opts: { only?: string[]; index?: string } = {},
): Promise<IndexReport> {
  const target = opts.index ?? cfg.opensearch.alias;
  const { os, embedder, stats } = deps;

  // 1. 全件走査
  const { memories, invalid } = await scanMemories(cfg);
  const superseded = computeSuperseded(memories);
  const statMap = stats.all();
  const dynamicOf = (id: string): DynamicFields => {
    const s = statMap.get(id);
    return {
      is_superseded: superseded.has(id),
      tier: s?.tier ?? "hot",
      access_count: s?.access_count ?? 0,
      last_accessed_at: s?.last_accessed_at ?? null,
    };
  };

  // 2. 既存ドキュメント
  const existing = await os.scanAll<ExistingSource>(target, { match_all: {} }, [
    "memory_id", "content_hash", "is_superseded", "tier", "access_count", "last_accessed_at",
  ]);
  const existingById = new Map<string, ExistingSource>();
  const existingByMemory = new Map<string, string[]>();
  for (const h of existing) {
    existingById.set(h._id, h._source);
    const list = existingByMemory.get(h._source.memory_id) ?? [];
    list.push(h._id);
    existingByMemory.set(h._source.memory_id, list);
  }

  // 3. 対象メモリのチャンクを作り、ハッシュが変わったものだけ埋め込む
  const onlySet = opts.only ? normalizeOnly(cfg, opts.only) : undefined;
  const targets = onlySet ? memories.filter((m) => onlySet.has(m.path)) : memories;
  const toIndex: { m: Memory; chunk_no: number; text: string; hash: string }[] = [];
  const indexedIds = new Set<string>();
  const deleteIds: string[] = [];
  for (const m of targets) {
    const chunks = chunkMemory(m.title, m.body, cfg.chunk);
    const newIds = new Set<string>();
    for (const c of chunks) {
      const id = `${m.id}:${c.chunk_no}`;
      newIds.add(id);
      const hash = contentHash(c.text, m, m.path);
      if (existingById.get(id)?.content_hash !== hash) {
        toIndex.push({ m, chunk_no: c.chunk_no, text: c.text, hash });
        indexedIds.add(id);
      }
    }
    // 5a. 新しいチャンク集合に無い既存ドキュメント
    for (const id of existingByMemory.get(m.id) ?? []) {
      if (!newIds.has(id)) deleteIds.push(id);
    }
  }
  // 5b. ファイルが無くなったメモリ (only 無しのときだけ)
  if (!onlySet) {
    const alive = new Set(memories.map((m) => m.id));
    for (const [mid, ids] of existingByMemory) {
      if (!alive.has(mid)) deleteIds.push(...ids);
    }
  }
  const deleteSet = new Set(deleteIds);

  const { vectors, cached, embedded } = await embedder.embedDocuments(
    toIndex.map((t) => ({ hash: t.hash, text: t.text })),
  );

  const lines: object[] = [];
  toIndex.forEach((t, i) => {
    const m = t.m;
    lines.push({ index: { _index: target, _id: `${m.id}:${t.chunk_no}` } });
    lines.push({
      memory_id: m.id,
      chunk_no: t.chunk_no,
      path: m.path,
      content_hash: t.hash,
      title: m.title,
      content: t.text,
      embedding: vectors[i],
      scope: m.scope,
      kind: m.kind,
      provenance: m.provenance,
      source_agent: m.source_agent,
      tags: m.tags ?? [],
      symbol_ref: m.symbol_ref ?? null,
      supersedes: m.supersedes ?? null,
      created_at: m.created_at,
      ...dynamicOf(m.id),
    });
  });

  // 4. ハッシュが同じチャンクは動的フィールドだけ部分更新 (全件対象)
  const aliveIds = new Set(memories.map((m) => m.id));
  let updated = 0;
  for (const h of existing) {
    if (indexedIds.has(h._id) || deleteSet.has(h._id)) continue;
    const src = h._source;
    if (!aliveIds.has(src.memory_id)) continue;
    const cur = dynamicOf(src.memory_id);
    const diff: Partial<DynamicFields> = {};
    if ((src.is_superseded ?? false) !== cur.is_superseded) diff.is_superseded = cur.is_superseded;
    if (src.tier !== cur.tier) diff.tier = cur.tier;
    if (src.access_count !== cur.access_count) diff.access_count = cur.access_count;
    if ((src.last_accessed_at ?? null) !== cur.last_accessed_at) {
      diff.last_accessed_at = cur.last_accessed_at;
    }
    if (Object.keys(diff).length > 0) {
      lines.push({ update: { _index: target, _id: h._id } }, { doc: diff });
      updated++;
    }
  }

  for (const id of deleteSet) lines.push({ delete: { _index: target, _id: id } });

  // 6. bulk (最後だけ refresh=true)
  const failed: { id: string; error: unknown }[] = [];
  for (let i = 0; i < lines.length; ) {
    // アクション行とソース行を分けないよう、delete 以外は 2 行単位で切る
    let end = Math.min(i + BULK_LINES, lines.length);
    while (end < lines.length && isSourceLine(lines[end]!)) end++;
    const r = await os.bulk(lines.slice(i, end), end >= lines.length);
    failed.push(...r.failed);
    i = end;
  }
  if (failed.length > 0) {
    const head = failed.slice(0, 5).map((f) => `${f.id}: ${JSON.stringify(f.error)}`).join("; ");
    throw new Error(`bulk で ${failed.length} 件失敗しました: ${head}`);
  }

  return {
    scanned: memories.length + invalid.length,
    invalid,
    embedded,
    cached,
    upserted: toIndex.length,
    updated,
    deleted: deleteSet.size,
  };
}

function isSourceLine(line: object): boolean {
  return !("index" in line || "update" in line || "delete" in line);
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export async function reindexAll(
  cfg: Config,
  deps: Deps,
  opts: { keepOld?: boolean } = {},
): Promise<IndexReport & { index: string }> {
  const { os } = deps;
  const { alias, index_base } = cfg.opensearch;
  const old = await os.getAliasTargets(alias);
  const index =
    old.length === 0 && !(await os.indexExists(index_base))
      ? index_base
      : `${index_base}-r${timestamp(new Date())}`;
  if (await os.indexExists(index)) throw new Error(`インデックス ${index} は既に存在します`);
  await os.createIndex(index, await readTemplate(cfg));
  let report: IndexReport;
  try {
    report = await indexIncremental(cfg, deps, { index });
    await os.swapAlias(alias, index, old);
  } catch (e) {
    await os.deleteIndex(index).catch(() => {});
    throw e;
  }
  if (!opts.keepOld) {
    for (const o of old) if (o !== index) await os.deleteIndex(o);
  }
  await putPipeline(cfg, os);
  return { ...report, index };
}
