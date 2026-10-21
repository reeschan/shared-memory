import { resolveApiKey } from "./config.ts";
import type { Config } from "./config.ts";

export type RerankHit = { index: number; score: number };

/** score の降順で、全文書分の { index, score } を返す。失敗時は throw する (フォールバックは呼び出し側) */
export interface Reranker {
  rerank(query: string, documents: string[]): Promise<RerankHit[]>;
}

export type RerankerOptions = { fetch?: typeof fetch };

type Flavor = Config["rerank"]["flavor"];

const DEFAULT_PATH: Record<Flavor, string> = {
  cohere: "/v1/rerank",
  voyage: "/v1/rerank",
  tei: "/rerank",
  sarashina: "/rerank",
};

const DEFAULT_MAX_DOCS: Record<Flavor, number> = {
  cohere: 1000,
  voyage: 1000,
  tei: 32,
  sarashina: 20,
};

class UnexpectedResponse extends Error {}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isIndex(x: unknown, n: number): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x < n;
}

function finiteNumber(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function truncate(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

/** 1 リクエスト分 (n 件) の応答を、チャンク内の添字での RerankHit にする */
function parseItems(flavor: Flavor, json: unknown, n: number): RerankHit[] {
  const fail = (): never => {
    throw new UnexpectedResponse();
  };
  const fromArray = (arr: unknown, scoreKeys: string[]): RerankHit[] => {
    if (!Array.isArray(arr)) return fail();
    return arr.map((it) => {
      if (!isRecord(it)) return fail();
      const score = scoreKeys.map((k) => finiteNumber(it[k])).find((v) => v !== undefined);
      if (!isIndex(it.index, n) || score === undefined) return fail();
      return { index: it.index, score };
    });
  };
  switch (flavor) {
    case "cohere":
      return fromArray(isRecord(json) ? json.results : undefined, ["relevance_score"]);
    case "voyage":
      return fromArray(isRecord(json) ? json.data : undefined, ["relevance_score"]);
    case "tei":
      return fromArray(json, ["score"]);
    case "sarashina": {
      const data = isRecord(json) ? json.data : undefined;
      const first = Array.isArray(data) ? data[0] : undefined;
      const result = isRecord(first) ? first.result : undefined;
      if (!Array.isArray(result)) return fail();
      return result.map((it, pos) => {
        const rec = isRecord(it) ? it : {};
        const rawId = rec.document_id;
        const id = typeof rawId === "string" && /^\d+$/.test(rawId) ? Number(rawId) : rawId;
        const index = id === undefined ? pos : id;
        if (!isIndex(index, n)) return fail();
        // score が無ければ、返ってきた順を高い順とみなす
        const score = finiteNumber(rec.relevance_score) ?? finiteNumber(rec.score) ?? result.length - pos;
        return { index, score };
      });
    }
  }
}

export function createReranker(cfg: Config["rerank"], opts: RerankerOptions = {}): Reranker | undefined {
  if (!cfg.enabled) return undefined;
  const doFetch = opts.fetch ?? fetch;
  const flavor = cfg.flavor;
  const endpoint = cfg.url.replace(/\/+$/, "") + "/" + (cfg.path ?? DEFAULT_PATH[flavor]).replace(/^\/+/, "");
  const perRequest = cfg.max_docs_per_request > 0 ? cfg.max_docs_per_request : DEFAULT_MAX_DOCS[flavor];

  const buildBody = (query: string, docs: string[]): Record<string, unknown> => {
    switch (flavor) {
      case "cohere":
        return { model: cfg.model, query, documents: docs, top_n: docs.length, ...cfg.extra_body };
      case "voyage":
        return { model: cfg.model, query, documents: docs, top_k: docs.length, ...cfg.extra_body };
      case "tei":
        return { query, texts: docs, ...cfg.extra_body };
      case "sarashina":
        return { model: cfg.model, query, documents: docs, ...cfg.extra_body };
    }
  };

  const redact = (s: string, key: string | undefined): string => (key ? s.split(key).join("***") : s);

  const post = async (query: string, docs: string[], signal: AbortSignal): Promise<RerankHit[]> => {
    const key = resolveApiKey(cfg.api_key_env);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    let json: unknown;
    try {
      const res = await doFetch(endpoint, { method: "POST", headers, body: JSON.stringify(buildBody(query, docs)), signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Rerank (${flavor}) failed: HTTP ${res.status} ${redact(truncate(text, 300), key)}`);
      }
      try {
        json = await res.json();
      } catch (e) {
        if (signal.aborted) throw e;
        throw new UnexpectedResponse();
      }
      return parseItems(flavor, json, docs.length);
    } catch (e) {
      if (e instanceof UnexpectedResponse) throw new Error(`Rerank (${flavor}): unexpected response`);
      if (e instanceof Error && e.message.startsWith(`Rerank (${flavor})`)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Rerank (${flavor}) failed: ${redact(msg, key)}`);
    }
  };

  return {
    async rerank(query, documents) {
      if (documents.length === 0) return [];
      const docs = documents.map((d) => truncate(d, cfg.doc_max_chars));
      const signal = AbortSignal.timeout(cfg.timeout_ms);
      const hits: RerankHit[] = [];
      const seen = new Set<number>();
      for (let off = 0; off < docs.length; off += perRequest) {
        const chunk = docs.slice(off, off + perRequest);
        for (const h of await post(query, chunk, signal)) {
          const index = h.index + off;
          if (seen.has(index)) throw new Error(`Rerank (${flavor}): unexpected response`);
          seen.add(index);
          hits.push({ index, score: h.score });
        }
      }
      // 返ってこなかった文書は、最下位に回して全文書分を揃える
      if (hits.length < docs.length) {
        const floor = Math.min(...hits.map((h) => h.score)) - 1;
        for (let i = 0; i < docs.length; i++) if (!seen.has(i)) hits.push({ index: i, score: Number.isFinite(floor) ? floor : 0 });
      }
      return hits.sort((a, b) => b.score - a.score || a.index - b.index);
    },
  };
}
