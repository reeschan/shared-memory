// HNSW (近似) の kNN が、総当たりの厳密検索の上位 10 チャンクをどれだけ再現するか (recall@10) と速度を比べる
import { os, readJsonl, qwenEmbed, QWEN_INSTR, LIVE_FILTER } from "./lib.mjs";
const evalSet = readJsonl("lab/data/eval.jsonl");
let hit = 0, total = 0, tA = 0, tE = 0;
for (const e of evalSet) {
  const [v] = await qwenEmbed([QWEN_INSTR + e.query]);
  const approx = await os("POST", "/memory_lab_base/_search", { size: 10, _source: false,
    query: { knn: { embedding: { vector: v, k: 10, filter: { bool: { filter: LIVE_FILTER } } } } } });
  const exact = await os("POST", "/memory_lab_base/_search", { size: 10, _source: false,
    query: { script_score: { query: { bool: { filter: LIVE_FILTER } },
      script: { source: "knn_score", lang: "knn", params: { field: "embedding", query_value: v, space_type: "cosinesimil" } } } } });
  const ex = new Set(exact.hits.hits.map(h => h._id));
  hit += approx.hits.hits.filter(h => ex.has(h._id)).length; total += ex.size;
  tA += approx.took; tE += exact.took;
}
console.log(`HNSW recall@10 vs exact: ${(hit / total).toFixed(3)}  took avg approx ${(tA / evalSet.length).toFixed(1)}ms exact ${(tE / evalSet.length).toFixed(1)}ms`);
