import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveApiKey, type Config } from "./config.ts";

type EmbeddingConfig = Config["embedding"];

export interface Embedder {
  /** embeddingFingerprint(cfg) */
  readonly fingerprint: string;
  readonly dimension: number;
  embedDocuments(
    items: { hash: string; text: string }[],
  ): Promise<{ vectors: number[][]; cached: number; embedded: number }>;
  embedQuery(query: string): Promise<number[]>;
}

export type EmbedderOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/** 今の Qwen3 の既定。_meta が無い既存インデックスはこの指紋とみなす */
export const LEGACY_EMBEDDING: EmbeddingConfig = {
  provider: "ollama",
  url: "http://127.0.0.1:11434",
  model: "qwen3-embedding:0.6b",
  dimension: 1024,
  batch_size: 16,
  normalize: true,
  revision: 0,
  extra_body: {},
  query: {
    prefix: "Instruct: Given a question or keywords, retrieve memory notes that answer or relate to it\nQuery: ",
    params: {},
  },
  document: { prefix: "", params: {} },
};

/** オブジェクトのキーを再帰的に辞書順に並べた JSON */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x === undefined ? null : x)).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const parts = Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** 指紋に含める項目。url・api_key_env・batch_size・rpm は含めない */
export function fingerprintParts(cfg: EmbeddingConfig): Record<string, unknown> {
  return {
    provider: cfg.provider,
    model: cfg.model,
    dimension: cfg.dimension,
    normalize: cfg.normalize,
    revision: cfg.revision,
    query: { prefix: cfg.query.prefix, params: cfg.query.params },
    document: { prefix: cfg.document.prefix, params: cfg.document.params },
    extra_body: cfg.extra_body,
  };
}

export function embeddingFingerprint(cfg: EmbeddingConfig): string {
  return createHash("sha256").update(stableJson(fingerprintParts(cfg))).digest("hex").slice(0, 16);
}

const MAX_RETRIES = 3;
const BODY_HEAD = 300;

function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(message: string, status: number, retryAfterMs: number | undefined) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(h: string | null): number | undefined {
  if (h === null) return undefined;
  const n = Number(h.trim());
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n * 1000;
}

class HttpEmbedder implements Embedder {
  readonly fingerprint: string;
  readonly dimension: number;
  private readonly cfg: EmbeddingConfig;
  private readonly cacheDir: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly useLegacyCache: boolean;
  private lastRequestAt: number | undefined;

  constructor(cfg: EmbeddingConfig, cacheDir: string, opts: EmbedderOptions) {
    this.cfg = cfg;
    this.cacheDir = cacheDir;
    this.dimension = cfg.dimension;
    this.fingerprint = embeddingFingerprint(cfg);
    this.useLegacyCache = this.fingerprint === embeddingFingerprint(LEGACY_EMBEDDING);
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  private cachePath(hash: string): string {
    return path.join(this.cacheDir, this.fingerprint, hash.slice(0, 2), `${hash}.json`);
  }

  private legacyCachePath(hash: string): string {
    const model = this.cfg.model.replace(/[^A-Za-z0-9]/g, "_");
    return path.join(this.cacheDir, model, hash.slice(0, 2), `${hash}.json`);
  }

  private async readCacheFile(p: string): Promise<number[] | null> {
    try {
      const v: unknown = JSON.parse(await readFile(p, "utf8"));
      if (Array.isArray(v) && v.length === this.cfg.dimension) return v as number[];
    } catch {
      // 無い・壊れている場合は再計算する
    }
    return null;
  }

  private async readCache(hash: string): Promise<number[] | null> {
    const v = await this.readCacheFile(this.cachePath(hash));
    if (v !== null) return v;
    if (this.useLegacyCache) return this.readCacheFile(this.legacyCachePath(hash));
    return null;
  }

  private redact(s: string, key: string | undefined): string {
    return key === undefined ? s : s.split(key).join("***");
  }

  /** rpm があれば、前回のリクエストから 60000 / rpm ms たつまで待つ */
  private async throttle(): Promise<void> {
    const rpm = this.cfg.rpm;
    if (rpm === undefined) return;
    if (this.lastRequestAt !== undefined) {
      const wait = this.lastRequestAt + 60000 / rpm - Date.now();
      if (wait > 0) await this.sleep(wait);
    }
  }

  private async requestOnce(input: string[], params: Record<string, unknown>): Promise<number[][]> {
    const { provider } = this.cfg;
    const key = resolveApiKey(this.cfg.api_key_env);
    const base = this.cfg.url.replace(/\/+$/, "");
    const url = provider === "ollama" ? `${base}/api/embed` : `${base}/embeddings`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key !== undefined) headers.authorization = `Bearer ${key}`;
    const body = JSON.stringify({ model: this.cfg.model, input, ...this.cfg.extra_body, ...params });

    await this.throttle();
    this.lastRequestAt = Date.now();
    let res: Response;
    try {
      res = await this.doFetch(url, { method: "POST", headers, body });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Embedding (${provider}) failed: ${this.redact(msg, key)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(
        `Embedding (${provider}) failed: HTTP ${res.status} ${this.redact(text.slice(0, BODY_HEAD), key)}`,
        res.status,
        parseRetryAfter(res.headers.get("retry-after")),
      );
    }

    let raw: number[][];
    try {
      const json = JSON.parse(text) as {
        embeddings?: number[][];
        data?: { embedding: number[]; index?: number }[];
      };
      if (provider === "ollama") {
        raw = json.embeddings as number[][];
      } else {
        const data = json.data;
        if (!Array.isArray(data)) throw new Error("data がありません");
        raw = data
          .map((d, i) => ({ d, i: typeof d.index === "number" ? d.index : i }))
          .sort((a, b) => a.i - b.i)
          .map((x) => x.d.embedding);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Embedding (${provider}) failed: invalid response (${this.redact(msg, key)})`);
    }
    if (!Array.isArray(raw) || raw.length !== input.length) {
      throw new Error(
        `Embedding (${provider}) failed: expected ${input.length} embeddings, got ${Array.isArray(raw) ? raw.length : typeof raw}`,
      );
    }
    for (const e of raw) {
      if (!Array.isArray(e) || e.length !== this.cfg.dimension) {
        throw new Error(
          `Embedding (${provider}) failed: dimension mismatch (expected ${this.cfg.dimension}, got ${Array.isArray(e) ? e.length : typeof e})`,
        );
      }
    }
    return this.cfg.normalize ? raw.map(l2normalize) : raw;
  }

  /** retry が true なら 429・5xx を最大 3 回再試行する */
  private async call(input: string[], params: Record<string, unknown>, retry: boolean): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(input, params);
      } catch (err) {
        const retriable = err instanceof HttpError && (err.status === 429 || err.status >= 500);
        if (!retry || !retriable || attempt >= MAX_RETRIES) throw err;
        await this.sleep(err.retryAfterMs ?? 1000 * 2 ** attempt);
      }
    }
  }

  async embedDocuments(
    items: { hash: string; text: string }[],
  ): Promise<{ vectors: number[][]; cached: number; embedded: number }> {
    const vectors: (number[] | null)[] = [];
    for (const it of items) vectors.push(await this.readCache(it.hash));
    const missing: number[] = [];
    vectors.forEach((v, i) => {
      if (v === null) missing.push(i);
    });
    const size = Math.max(1, this.cfg.batch_size);
    const prefix = this.cfg.document.prefix;
    for (let i = 0; i < missing.length; i += size) {
      const idxs = missing.slice(i, i + size);
      const embs = await this.call(
        idxs.map((j) => prefix + items[j]!.text),
        this.cfg.document.params,
        true,
      );
      for (let k = 0; k < idxs.length; k++) {
        const j = idxs[k]!;
        const vec = embs[k]!;
        vectors[j] = vec;
        const p = this.cachePath(items[j]!.hash);
        await mkdir(path.dirname(p), { recursive: true });
        await writeFile(p, JSON.stringify(vec));
      }
    }
    return {
      vectors: vectors as number[][],
      cached: items.length - missing.length,
      embedded: missing.length,
    };
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vec] = await this.call([this.cfg.query.prefix + query], this.cfg.query.params, false);
    return vec!;
  }
}

export function createEmbedder(cfg: EmbeddingConfig, cacheDir: string, opts: EmbedderOptions = {}): Embedder {
  return new HttpEmbedder(cfg, cacheDir, opts);
}
