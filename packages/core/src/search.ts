import type { Config } from "./config.ts";
import type { Embedder } from "./embed.ts";
import { computeFreshness, type Freshness } from "./freshness.ts";
import { WORKSPACE_SCOPE_PREFIX, type Kind, type Provenance, type Tier } from "./frontmatter.ts";
import type { OpenSearchClient } from "./opensearch.ts";
import type { Reranker, RerankHit } from "./rerank.ts";

export type SearchInput = {
  query: string;
  scope?: string;
  kind?: Kind;
  tags?: string[];
  limit?: number;
  /** scope を付けない検索に作業空間 (`project:work.*`) を含める。scope があるときは見ない */
  include_workspaces?: boolean;
};

export type SearchResult = {
  id: string;
  title: string;
  excerpt: string;
  score: number;
  scope: string;
  kind: Kind;
  provenance: Provenance;
  created_at: string;
  /** リランクした候補にだけ付く。score は rescore 後のスコアのまま */
  rerank_score?: number;
  /** 古さの情報 (作成からの日数で stale を判定する) */
  freshness: Freshness;
};

type RescoreSource = {
  last_accessed_at?: string | null;
  created_at: string;
  access_count?: number;
  tier?: Tier;
  provenance: Provenance;
};

type HitSource = RescoreSource & {
  memory_id: string;
  title: string;
  content: string;
  scope: string;
  kind: Kind;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const EXCERPT_CHARS = 160;

/** 問われた時点の再現。supersededAt は「置き換えられた memory_id → 置き換えた側の created_at (複数あれば最も早いもの)」 */
export type AsOf = { at: Date; supersededAt: ReadonlyMap<string, string> };

export function buildFilter(cfg: Config, input: SearchInput, asOf?: AsOf): object[] {
  // asOf があるときは今の is_superseded ではなく、その時点までに作られたものに絞る (置き換えの除外はヒットの段階で行う)
  const filter: object[] =
    asOf === undefined
      ? [{ term: { is_superseded: false } }, { terms: { tier: cfg.search.searchable_tiers } }]
      : [{ terms: { tier: cfg.search.searchable_tiers } }, { range: { created_at: { lte: asOf.at.toISOString() } } }];
  // scope を付けず、include_workspaces も true でない検索は作業空間を除く
  if (input.scope === undefined && input.include_workspaces !== true) {
    filter.push({ bool: { must_not: [{ prefix: { scope: WORKSPACE_SCOPE_PREFIX } }] } });
  }
  if (input.scope !== undefined) filter.push({ term: { scope: input.scope } });
  if (input.kind !== undefined) filter.push({ term: { kind: input.kind } });
  if (input.tags !== undefined && input.tags.length > 0) filter.push({ terms: { tags: input.tags } });
  return filter;
}

export function buildHybridQuery(cfg: Config, input: SearchInput, vector: number[], asOf?: AsOf): object {
  const k = cfg.search.candidates;
  const filter = buildFilter(cfg, input, asOf);
  return {
    size: k,
    _source: { excludes: ["embedding"] },
    query: {
      hybrid: {
        queries: [
          { bool: { must: { multi_match: { query: input.query, fields: ["title^2", "content"] } }, filter } },
          { knn: { embedding: { vector, k, filter: { bool: { filter } } } } },
        ],
      },
    },
  };
}

export function rescore(hybridScore: number, src: RescoreSource, cfg: Config, now: Date): number {
  // 半減期は tier によらず 1 つの値 (tier が変わる日にスコアが上がる逆転を防ぐ)
  const halfLife = cfg.search.half_life_days;
  const base = Date.parse(src.last_accessed_at ?? src.created_at);
  const days = Number.isNaN(base) ? 0 : Math.max(0, (now.getTime() - base) / DAY_MS);
  const decay = 0.5 ** (days / halfLife);
  const { decay_floor, access_weight } = cfg.search.rescore;
  const softDecay = decay_floor + (1 - decay_floor) * decay;
  const access = 1 + access_weight * Math.log(1 + Math.max(0, src.access_count ?? 0));
  const prov = cfg.search.provenance_factor[src.provenance] ?? 1;
  return hybridScore * softDecay * access * prov;
}

/** rescore を効かなくした設定 (decay_floor 1、access_weight 0、provenance_factor はすべて 1)。ほかは cfg のまま。cfg は変えない */
export function primaryOnlyConfig(cfg: Config): Config {
  return {
    ...cfg,
    search: {
      ...cfg.search,
      provenance_factor: { human_confirmed: 1, agent_verified: 1, agent_inferred: 1 },
      rescore: { decay_floor: 1, access_weight: 0 },
    },
  };
}

type SupersedeMeta = { id: string; created_at: string; supersedes?: string | undefined };

/**
 * scanMemories の Memory[] から AsOf.supersededAt を作る。
 * 置き換えられた memory_id → 置き換えた側の created_at (複数あれば最も早いもの)。
 * Memory はメタが平らに並ぶ形なので、平らな形と meta に包んだ形の両方を受ける
 */
export function supersededAtMap(memories: readonly (SupersedeMeta | { meta: SupersedeMeta })[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of memories) {
    const meta = "meta" in m ? m.meta : m;
    if (!meta.supersedes) continue;
    const t = Date.parse(meta.created_at);
    if (Number.isNaN(t)) continue;
    const cur = out.get(meta.supersedes);
    if (cur === undefined || t < Date.parse(cur)) out.set(meta.supersedes, meta.created_at);
  }
  return out;
}

function makeExcerpt(content: string, title: string): string {
  const prefix = `${title}\n\n`;
  let text = content.startsWith(prefix) ? content.slice(prefix.length) : content;
  if (text === title) text = "";
  return Array.from(text.replace(/\r?\n/g, " ")).slice(0, EXCERPT_CHARS).join("");
}

type MemoryHit = { primary: number; score: number; src: HitSource };

function toResult(hit: MemoryHit, cfg: Config, now: Date): SearchResult {
  const { score, src } = hit;
  return {
    id: src.memory_id,
    title: src.title,
    excerpt: makeExcerpt(src.content, src.title),
    score,
    scope: src.scope,
    kind: src.kind,
    provenance: src.provenance,
    created_at: src.created_at,
    freshness: computeFreshness(src, cfg, now),
  };
}

function toRerankedResult(hit: MemoryHit, rerankScore: number, cfg: Config, now: Date): SearchResult {
  return { ...toResult(hit, cfg, now), rerank_score: rerankScore };
}

export async function searchMemories(
  cfg: Config,
  deps: { os: OpenSearchClient; embedder: Embedder; reranker?: Reranker; log?: (msg: string) => void },
  input: SearchInput,
  now: Date = new Date(),
  opts: { asOf?: AsOf } = {},
): Promise<SearchResult[]> {
  const asOf = opts.asOf;
  // asOf があるとき、rescore と freshness の「今」は問われた時点
  if (asOf !== undefined) now = asOf.at;
  const vector = await deps.embedder.embedQuery(input.query);
  const res = await deps.os.search<HitSource>(cfg.opensearch.alias, buildHybridQuery(cfg, input, vector, asOf), {
    search_pipeline: cfg.opensearch.pipeline_name,
  });
  // 1 メモリ 1 件にまとめる。代表チャンクは一次スコアが最大のもの
  const best = new Map<string, MemoryHit>();
  for (const h of res.hits) {
    const src = h._source;
    if (asOf !== undefined) {
      // 問われた時点までに置き換えられていたものは、まとめる前に除く
      const at = asOf.supersededAt.get(src.memory_id);
      if (at !== undefined && Date.parse(at) <= asOf.at.getTime()) continue;
    }
    const cur = best.get(src.memory_id);
    if (cur === undefined || h._score > cur.primary) {
      best.set(src.memory_id, { primary: h._score, score: rescore(h._score, src, cfg, now), src });
    }
  }
  const limit = input.limit ?? cfg.search.default_limit;
  const memories = [...best.values()];
  const byRescore = [...memories].sort((a, b) => b.score - a.score);
  const reranker = deps.reranker;
  const result = (m: MemoryHit) => toResult(m, cfg, now);
  if (reranker === undefined) return byRescore.slice(0, limit).map(result);

  // 候補は rescore ではなく一次スコアの上位から選ぶ (ADR 0002)
  const byPrimary = [...memories].sort((a, b) => b.primary - a.primary);
  const candidates = byPrimary.slice(0, cfg.rerank.candidates);
  const outside = byPrimary.slice(candidates.length);

  let ranked: RerankHit[];
  try {
    ranked = await reranker.rerank(input.query, candidates.map((c) => c.src.content));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.log?.(`rerank failed: ${msg}`);
    return byRescore.slice(0, limit).map(result);
  }

  const results: SearchResult[] = [];
  const used = new Set<number>();
  for (const h of [...ranked].sort((a, b) => b.score - a.score)) {
    if (h.index < 0 || h.index >= candidates.length || used.has(h.index)) continue;
    used.add(h.index);
    results.push(toRerankedResult(candidates[h.index]!, h.score, cfg, now));
  }
  // 点が返ってこなかった候補は、一次スコアの順で後ろに回す
  for (let i = 0; i < candidates.length; i++) if (!used.has(i)) results.push(result(candidates[i]!));
  for (const m of outside) results.push(result(m));
  return results.slice(0, limit);
}
