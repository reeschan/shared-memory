// 検証用の共通処理。本番のエイリアス memories には書き込まない (memory_lab_* だけを使う)
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildFilter, loadConfig } from "../packages/core/src/index.ts";

export const OS = "http://127.0.0.1:9200";
export const OLLAMA = "http://127.0.0.1:11434";
export const QWEN_INSTR = "Instruct: Given a question or keywords, retrieve memory notes that answer or relate to it\nQuery: ";
export const SARASHINA = "https://api.sarashina.ai/v1";

export function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv();

export async function os(method, path, body, query = "") {
  const res = await fetch(`${OS}${path}${query}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${JSON.stringify(json).slice(0, 800)}`);
  return json;
}

export function readJsonl(p) {
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}
export function writeJsonl(p, rows) { writeFileSync(p, rows.map(r => JSON.stringify(r)).join("\n") + "\n"); }

export async function qwenEmbed(texts) {
  const res = await fetch(`${OLLAMA}/api/embed`, { method: "POST", body: JSON.stringify({ model: "qwen3-embedding:0.6b", input: texts }) });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  return (await res.json()).embeddings;
}

// ディスクキャッシュ (lab/data/cache/<ns>.json)。API 呼び出しを再実行しないため
const caches = new Map();
function cacheFile(ns) { mkdirSync("lab/data/cache", { recursive: true }); return `lab/data/cache/${ns}.json`; }
export function cacheGet(ns, key) {
  if (!caches.has(ns)) caches.set(ns, existsSync(cacheFile(ns)) ? JSON.parse(readFileSync(cacheFile(ns), "utf8")) : {});
  return caches.get(ns)[key];
}
export function cacheSet(ns, key, val) { cacheGet(ns, key); caches.get(ns)[key] = val; }
export function cacheFlush(ns) { if (caches.has(ns)) writeFileSync(cacheFile(ns), JSON.stringify(caches.get(ns))); }
export const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 32);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastCall = {};
// RPM を守って Sarashina API を呼ぶ。429 は Retry-After を見て再試行
export async function sarashina(path, body, rpm) {
  const gap = 60000 / rpm + 50;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = (lastCall[path + body.model] ?? 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[path + body.model] = Date.now();
    const res = await fetch(`${SARASHINA}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SARASHINA_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) { await sleep((Number(res.headers.get("retry-after")) || 10) * 1000); continue; }
    if (res.status >= 500) { await sleep(5000); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`sarashina ${path} ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  throw new Error(`sarashina ${path}: retries exhausted`);
}

// 本番の検索と同じ絞り込み (is_superseded と tier。query 以外を渡さないので scope などは付かない)
export const LIVE_FILTER = buildFilter(loadConfig(), { query: "" });

// チャンク単位のヒットを memory_id 単位に畳む (本番の searchMemories と同じく最大スコア)
export function toMemoryRanking(hits) {
  const seen = new Set(); const out = [];
  for (const h of hits) { const m = h._source.memory_id; if (!seen.has(m)) { seen.add(m); out.push(m); } }
  return out;
}
