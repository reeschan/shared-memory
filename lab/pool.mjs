// 評価セット作り用: クエリごとに BM25 と kNN の上位 10 メモリ (id とタイトル) を出す
import { os, qwenEmbed, QWEN_INSTR, LIVE_FILTER } from "./lib.mjs";
const q = process.argv.slice(2).join(" ");
const [vec] = await qwenEmbed([QWEN_INSTR + q]);
const bm = await os("POST", "/memory_lab_base/_search", { size: 30, _source: ["memory_id", "title"], query: { bool: { must: { multi_match: { query: q, fields: ["title^2", "content"] } }, filter: LIVE_FILTER } } });
const kn = await os("POST", "/memory_lab_base/_search", { size: 30, _source: ["memory_id", "title"], query: { knn: { embedding: { vector: vec, k: 30, filter: { bool: { filter: LIVE_FILTER } } } } } });
const show = (name, hits) => { const seen = new Set(); console.log(`## ${name}`); for (const h of hits) { const s = h._source; if (seen.has(s.memory_id)) continue; seen.add(s.memory_id); console.log(`${s.memory_id}\t${s.title}`); if (seen.size >= 10) break; } };
show("bm25", bm.hits.hits); show("knn", kn.hits.hits);
