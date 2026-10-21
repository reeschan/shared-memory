// 全チャンクを sarashina3-embedding (RETRIEVAL_DOCUMENT) で埋め込み、キャッシュに保存する
import { readJsonl, sarashina, cacheGet, cacheSet, cacheFlush, sha } from "./lib.mjs";
const NS = "sarashina-emb-doc";
const chunks = readJsonl("lab/data/chunks.jsonl");
let n = 0;
for (const c of chunks) {
  const key = sha(c.content);
  if (cacheGet(NS, key)) continue;
  const r = await sarashina("/embeddings", { model: "sarashina3-embedding", input: c.content, task_type: "RETRIEVAL_DOCUMENT" }, 60);
  cacheSet(NS, key, r.data[0].embedding);
  if (++n % 20 === 0) { cacheFlush(NS); console.log(new Date().toISOString(), n); }
}
cacheFlush(NS); console.log("done", n);
