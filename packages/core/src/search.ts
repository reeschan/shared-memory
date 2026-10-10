import type { Config } from "./config.ts";
import type { Embedder } from "./embed.ts";
import type { Kind, Provenance, Tier } from "./frontmatter.ts";
import type { OpenSearchClient } from "./opensearch.ts";

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
  const tier: Tier = src.tier ?? "hot";
  const halfLife = cfg.search.half_life_days[tier];
  const base = Date.parse(src.last_accessed_at ?? src.created_at);
  const days = Number.isNaN(base) ? 0 : Math.max(0, (now.getTime() - base) / DAY_MS);
  const decay = 0.5 ** (days / halfLife);
  const access = 1 + Math.log(1 + Math.max(0, src.access_count ?? 0));
  const prov = cfg.search.provenance_factor[src.provenance] ?? 1;
  return hybridScore * decay * access * prov;
}

function makeExcerpt(content: string, title: string): string {
  const prefix = `${title}\n\n`;
  let text = content.startsWith(prefix) ? content.slice(prefix.length) : content;
  if (text === title) text = "";
  return Array.from(text.replace(/\r?\n/g, " ")).slice(0, EXCERPT_CHARS).join("");
}

export async function searchMemories(
  cfg: Config,
  deps: { os: OpenSearchClient; embedder: Embedder },
  input: SearchInput,
  now: Date = new Date(),
): Promise<SearchResult[]> {
  const vector = await deps.embedder.embedQuery(input.query);
  const res = await deps.os.search<HitSource>(cfg.opensearch.alias, buildHybridQuery(cfg, input, vector), {
    search_pipeline: cfg.opensearch.pipeline_name,
  });
  const best = new Map<string, { score: number; src: HitSource }>();
  for (const h of res.hits) {
    const src = h._source;
    const score = rescore(h._score, src, cfg, now);
    const cur = best.get(src.memory_id);
    if (cur === undefined || score > cur.score) best.set(src.memory_id, { score, src });
  }
  const limit = input.limit ?? cfg.search.default_limit;
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, src }) => ({
      id: src.memory_id,
      title: src.title,
      excerpt: makeExcerpt(src.content, src.title),
      score,
      scope: src.scope,
      kind: src.kind,
      provenance: src.provenance,
      created_at: src.created_at,
    }));
}
