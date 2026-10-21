import type { Config } from "./config.ts";
import type { Embedder } from "./embed.ts";
import { computeFreshness, type Freshness } from "./freshness.ts";
import type { Kind, Provenance, Tier } from "./frontmatter.ts";
import type { OpenSearchClient } from "./opensearch.ts";
import type { Reranker, RerankHit } from "./rerank.ts";

export type SearchInput = { query: string; scope?: string; kind?: Kind; tags?: string[]; limit?: number };

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

export function buildFilter(cfg: Config, input: SearchInput): object[] {
  const filter: object[] = [
    { term: { is_superseded: false } },
    { terms: { tier: cfg.search.searchable_tiers } },
  ];
  if (input.scope !== undefined) filter.push({ term: { scope: input.scope } });
  if (input.kind !== undefined) filter.push({ term: { kind: input.kind } });
  if (input.tags !== undefined && input.tags.length > 0) filter.push({ terms: { tags: input.tags } });
  return filter;
}

export function buildHybridQuery(cfg: Config, input: SearchInput, vector: number[]): object {
  const k = cfg.search.candidates;
  const filter = buildFilter(cfg, input);
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
): Promise<SearchResult[]> {
  const vector = await deps.embedder.embedQuery(input.query);
  const res = await deps.os.search<HitSource>(cfg.opensearch.alias, buildHybridQuery(cfg, input, vector), {
    search_pipeline: cfg.opensearch.pipeline_name,
  });
  // 1 メモリ 1 件にまとめる。代表チャンクは一次スコアが最大のもの
  const best = new Map<string, MemoryHit>();
  for (const h of res.hits) {
    const src = h._source;
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
