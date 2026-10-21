// Search Relevance Workbench (REST) で BM25 系の設定を比べる。評価セットを Query set / Judgment に入れて Pointwise 評価する
import { os, readJsonl } from "./lib.mjs";
const P = "/_plugins/_search_relevance";
const evalSet = readJsonl("lab/data/eval.jsonl");
const qs = await os("PUT", `${P}/query_sets`, { name: "lab-eval-60", description: "shared-memory lab eval", sampling: "manual",
  querySetQueries: evalSet.map(e => ({ queryText: e.query })) });
console.log("query set", qs);
const cfgs = {};
for (const [name, index, fields] of [["srw-bm25-base", "memory_lab_base", ["title^2", "content"]], ["srw-bm25-b0", "memory_lab_b0", ["title^2", "content"]], ["srw-bm25-pos", "memory_lab_pos", ["title^2", "content"]]]) {
  const r = await os("PUT", `${P}/search_configurations`, { name, index,
    query: JSON.stringify({ query: { bool: { must: { multi_match: { query: "%SearchText%", fields } }, filter: [{ term: { is_superseded: false } }, { terms: { tier: ["hot", "warm"] } }] } } }) });
  cfgs[name] = r.search_configuration_id; console.log(name, r);
}
// SRW の判定は文書 (_id) 単位なので、正解メモリの全チャンクに同じ grade を付ける
const chunks = readJsonl("lab/data/chunks.jsonl");
const byMem = new Map();
for (const c of chunks) { if (!byMem.has(c.memory_id)) byMem.set(c.memory_id, []); byMem.get(c.memory_id).push(c._id); }
const j = await os("PUT", `${P}/judgments`, { name: "lab-eval-60-judgments", type: "IMPORT_JUDGMENT",
  judgmentRatings: evalSet.map(e => ({ query: e.query, ratings: Object.entries(e.relevant).flatMap(([m, g]) => (byMem.get(m) ?? []).map(docId => ({ docId, rating: String(g) }))) })) });
console.log("judgment", j);
// POINTWISE_EVALUATION は 1 設定ずつ
const exps = {};
for (const [name, id] of Object.entries(cfgs)) {
  const ex = await os("PUT", `${P}/experiments`, { querySetId: qs.query_set_id, searchConfigurationList: [id], judgmentList: [j.judgment_id], size: 10, type: "POINTWISE_EVALUATION" });
  exps[name] = ex.experiment_id;
}
await new Promise(r => setTimeout(r, 15000));
for (const [name, id] of Object.entries(exps)) {
  const ex = await os("GET", `${P}/experiments/${id}`);
  const src = ex.hits?.hits?.[0]?._source ?? ex;
  console.log(name, src.status);
  // 結果はクエリごとの指標。平均を出す
  const r = await os("POST", "/search-relevance-evaluation-result/_search", { size: 200, query: { term: { experimentId: id } } }).catch(e => ({ error: e.message }));
  if (r.error) { console.log(r.error.slice(0, 300)); continue; }
  const sums = {}; let n = 0;
  for (const h of r.hits.hits) { n++; for (const m of h._source.metrics ?? []) sums[m.metric] = (sums[m.metric] ?? 0) + Number(m.value); }
  console.log(name, n, Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, (v / n).toFixed(3)])));
}
