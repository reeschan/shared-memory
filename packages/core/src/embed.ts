import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";

type EmbeddingConfig = Config["embedding"];

export class Embedder {
  private readonly cfg: EmbeddingConfig;
  private readonly cacheDir: string;

  constructor(cfg: EmbeddingConfig, cacheDir: string) {
    this.cfg = cfg;
    this.cacheDir = cacheDir;
  }

  private cachePath(hash: string): string {
    const model = this.cfg.model.replace(/[^A-Za-z0-9]/g, "_");
    return path.join(this.cacheDir, model, hash.slice(0, 2), `${hash}.json`);
  }

  private async readCache(hash: string): Promise<number[] | null> {
    try {
      const v: unknown = JSON.parse(await readFile(this.cachePath(hash), "utf8"));
      if (Array.isArray(v) && v.length === this.cfg.dimension) return v as number[];
    } catch {
      // 無い・壊れている場合は再計算する
    }
    return null;
  }

  private async callOllama(input: string[]): Promise<number[][]> {
    const res = await fetch(`${this.cfg.url.replace(/\/+$/, "")}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.model, input }),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Ollama embed failed: HTTP ${res.status} ${body}`);
    }
    const json = JSON.parse(body) as { embeddings?: number[][] };
    const embeddings = json.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== input.length) {
      throw new Error(`Ollama embed: expected ${input.length} embeddings, got ${embeddings?.length}`);
    }
    for (const e of embeddings) {
      if (!Array.isArray(e) || e.length !== this.cfg.dimension) {
        throw new Error(
          `Ollama embed: dimension mismatch (expected ${this.cfg.dimension}, got ${Array.isArray(e) ? e.length : typeof e})`,
        );
      }
    }
    return embeddings;
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
    for (let i = 0; i < missing.length; i += size) {
      const idxs = missing.slice(i, i + size);
      const embs = await this.callOllama(idxs.map((j) => items[j]!.text));
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
    const [vec] = await this.callOllama([this.cfg.query_instruction + query]);
    return vec!;
  }
}
