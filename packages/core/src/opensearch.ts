export class OpenSearchClient {
  baseUrl: string;

  constructor(url: string) {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  async #raw(method: string, path: string, body?: unknown, contentType?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    let payload: string | undefined;
    if (body !== undefined) {
      if (typeof body === "string") {
        payload = body;
        headers["Content-Type"] = contentType ?? "application/json";
      } else {
        payload = JSON.stringify(body);
        headers["Content-Type"] = contentType ?? "application/json";
      }
    }
    return fetch(this.baseUrl + path, { method, headers, body: payload });
  }

  async #call<T>(method: string, path: string, body?: unknown, contentType?: string, okStatuses: number[] = []): Promise<{ status: number; data: T }> {
    const res = await this.#raw(method, path, body, contentType);
    const text = await res.text();
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new Error(`OpenSearch ${method} ${path} ${res.status}: ${text}`);
    }
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, data: data as T };
  }

  async request<T = any>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
    return (await this.#call<T>(method, path, body, contentType)).data;
  }

  async indexExists(name: string): Promise<boolean> {
    const path = `/${encodeURIComponent(name)}`;
    const res = await this.#raw("HEAD", path);
    await res.text();
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`OpenSearch HEAD ${path} ${res.status}: `);
    return true;
  }

  async createIndex(name: string, body: object): Promise<void> {
    await this.request("PUT", `/${encodeURIComponent(name)}`, body);
  }

  async deleteIndex(name: string): Promise<void> {
    await this.request("DELETE", `/${encodeURIComponent(name)}`);
  }

  async getAliasTargets(alias: string): Promise<string[]> {
    const r = await this.#call<Record<string, unknown>>("GET", `/_alias/${encodeURIComponent(alias)}`, undefined, undefined, [404]);
    if (r.status === 404) return [];
    return Object.keys(r.data ?? {});
  }

  async swapAlias(alias: string, newIndex: string, oldIndices: string[]): Promise<void> {
    const actions: object[] = [
      ...oldIndices.map((index) => ({ remove: { index, alias } })),
      { add: { index: newIndex, alias } },
    ];
    await this.request("POST", "/_aliases", { actions });
  }

  async bulk(lines: object[], refresh = false): Promise<{ errors: boolean; failed: { id: string; error: unknown }[] }> {
    if (lines.length === 0) return { errors: false, failed: [] };
    const ndjson = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const path = `/_bulk${refresh ? "?refresh=true" : ""}`;
    const r = await this.request<any>("POST", path, ndjson, "application/x-ndjson");
    const failed: { id: string; error: unknown }[] = [];
    for (const item of r.items ?? []) {
      const op = Object.values(item)[0] as any;
      if (op && op.error) failed.push({ id: String(op._id), error: op.error });
    }
    return { errors: Boolean(r.errors), failed };
  }

  async search<T = any>(
    index: string,
    body: object,
    params?: Record<string, string>,
  ): Promise<{ hits: { _id: string; _score: number; _source: T }[] }> {
    const qs = params && Object.keys(params).length > 0 ? "?" + new URLSearchParams(params).toString() : "";
    const r = await this.request<any>("POST", `/${encodeURIComponent(index)}/_search${qs}`, body);
    return { hits: r.hits?.hits ?? [] };
  }

  async scanAll<T = any>(index: string, query: object, sourceFields: string[]): Promise<{ _id: string; _source: T }[]> {
    const first = await this.#call<any>(
      "POST",
      `/${encodeURIComponent(index)}/_search?scroll=1m`,
      { size: 500, query, _source: sourceFields },
      undefined,
      [404],
    );
    if (first.status === 404) return [];
    const out: { _id: string; _source: T }[] = [];
    let scrollId: string | undefined = first.data._scroll_id;
    let hits: any[] = first.data.hits?.hits ?? [];
    try {
      while (hits.length > 0) {
        for (const h of hits) out.push({ _id: h._id, _source: h._source });
        if (!scrollId) break;
        const next: any = await this.request("POST", "/_search/scroll", { scroll: "1m", scroll_id: scrollId });
        scrollId = next._scroll_id ?? scrollId;
        hits = next.hits?.hits ?? [];
      }
    } finally {
      if (scrollId) {
        try {
          await this.#call("DELETE", "/_search/scroll", { scroll_id: [scrollId] }, undefined, [404]);
        } catch {
          // 解放失敗は無視 (1m で自動失効)
        }
      }
    }
    return out;
  }

  async updateByQuery(
    index: string,
    query: object,
    script: { source: string; params?: object },
    refresh = true,
  ): Promise<number> {
    const r = await this.request<any>(
      "POST",
      `/${encodeURIComponent(index)}/_update_by_query?refresh=${refresh}&conflicts=proceed`,
      { query, script: { lang: "painless", ...script } },
    );
    return r.updated ?? 0;
  }

  async putSearchPipeline(name: string, body: object): Promise<void> {
    await this.request("PUT", `/_search/pipeline/${encodeURIComponent(name)}`, body);
  }

  async refresh(index: string): Promise<void> {
    await this.request("POST", `/${encodeURIComponent(index)}/_refresh`);
  }
}
