// 同じ評価セットで検索設定 (variant) を比べる。指標はメモリ単位の Recall@5 / nDCG@10 / MRR@10 と遅延
// 使い方: node lab/eval.mjs [variant 名の部分一致...]   結果は lab/data/results/<variant>.json と標準出力の表
import { mkdirSync, writeFileSync } from "node:fs";
import { os, readJsonl, qwenEmbed, QWEN_INSTR, sarashina, cacheGet, cacheSet, cacheFlush, sha, LIVE_FILTER, toMemoryRanking } from "./lib.mjs";
import { rescore, loadConfig, memoryMetrics } from "../packages/core/src/index.ts";

const evalSet = readJsonl(process.env.EVAL ?? "lab/data/eval.jsonl");
const K = 50; // 本番と同じ候補数

// ---- クエリベクトル (キャッシュ) ----
async function qvec(kind, q) {
  const key = sha(kind + q);
  const hit = cacheGet("qvec", key);
  if (hit) return hit;
  let v;
  if (kind === "qwen") [v] = await qwenEmbed([QWEN_INSTR + q]);
  else if (kind === "qwen-noinstr") [v] = await qwenEmbed([q]);
  else if (kind === "sara") v = (await sarashina("/embeddings", { model: "sarashina3-embedding", input: q, task_type: "RETRIEVAL_QUERY" }, 60)).data[0].embedding;
  else if (kind === "sara-qa") v = (await sarashina("/embeddings", { model: "sarashina3-embedding", input: q, task_type: "QUESTION_ANSWERING" }, 60)).data[0].embedding;
  cacheSet("qvec", key, v);
  cacheFlush("qvec");
  return v;
}

// ---- クエリの部品 ----
const bm25 = (q, fields = ["title^2", "content"]) => ({ bool: { must: { multi_match: { query: q, fields } }, filter: LIVE_FILTER } });
const knn = (field, vector) => ({ knn: { [field]: { vector, k: K, filter: { bool: { filter: LIVE_FILTER } } } } });
// nested の子には LIVE_FILTER のフィールドが無いので、親側で絞る
const nestedLive = vector => ({ bool: { must: { nested: { path: "question_vecs", score_mode: "max",
  query: { knn: { "question_vecs.vec": { vector, k: K } } } } }, filter: LIVE_FILTER } });
const D2Q_FIELDS = ["title^1.5", "content^1", "questions^1.5", "keywords^2", "summary^0.5"];
const EXCLUDES = ["embedding", "question_vecs", "sara_vec"];

// ---- 本番 MCP の再スコア (時間減衰・アクセス回数・出所)。core の rescore と config.yaml の値を使う ----
// mode は設定の上書きで表す: full = 減衰そのまま・アクセス係数 1 / soft = 本番の設定のまま / prov = 出所の係数だけ
const CFG = loadConfig();
const withRescore = r => ({ ...CFG, search: { ...CFG.search, rescore: r } });
const RESCORE_CFG = {
  full: withRescore({ decay_floor: 0, access_weight: 1 }),
  soft: CFG,
  prov: withRescore({ decay_floor: 1, access_weight: 0 }),
};

// ---- variant 定義 ----
const V = [];
const add = (name, desc, fn) => V.push({ name, desc, fn });
const hyb = (index, pipeline, parts) => ({ index, pipeline, body: { size: K, _source: { excludes: EXCLUDES }, query: { hybrid: { queries: parts } } } });
const single = (index, query) => ({ index, body: { size: K, _source: { excludes: EXCLUDES }, query } });
const qwenHyb = (index, pipeline, fields) => async q => hyb(index, pipeline, [bm25(q, fields), knn("embedding", await qvec("qwen", q))]);

add("bm25", "BM25 のみ (title^2, content)", async q => single("memory_lab_base", bm25(q)));
add("knn-qwen", "kNN のみ (Qwen3、検索用 Instruction あり)", async q => single("memory_lab_base", knn("embedding", await qvec("qwen", q))));
add("knn-qwen-noinstr", "kNN のみ (Qwen3、Instruction なし)", async q => single("memory_lab_base", knn("embedding", await qvec("qwen-noinstr", q))));
add("base", "現行構成: hybrid min_max 0.4/0.6", qwenHyb("memory_lab_base", "lab-minmax-46"));
add("base+rescore", "現行構成 + MCP の再スコア (減衰・アクセス・出所)", async q => ({ ...(await qwenHyb("memory_lab_base", "lab-minmax-46")(q)), rescore: "full" }));
add("base+rescore-soft", "現行構成 + 弱めた再スコア (減衰の下限 0.7、アクセス係数 0.2 倍)", async q => ({ ...(await qwenHyb("memory_lab_base", "lab-minmax-46")(q)), rescore: "soft" }));
add("base+rescore-prov", "現行構成 + 出所の係数だけ", async q => ({ ...(await qwenHyb("memory_lab_base", "lab-minmax-46")(q)), rescore: "prov" }));
add("hyb-b0-zscore", "hybrid z_score 0.4/0.6 / BM25 b=0", qwenHyb("memory_lab_b0", "lab-zscore-46"));
add("hyb-b0-zscore+rescore-soft", "hyb-b0-zscore + 弱めた再スコア", async q => ({ ...(await qwenHyb("memory_lab_b0", "lab-zscore-46")(q)), rescore: "soft" }));
for (const p of ["minmax-28", "minmax-37", "minmax-55", "minmax-64", "l2-46", "zscore-46", "rrf-60", "rrf-20"])
  add(`hyb-${p}`, `hybrid ${p}`, qwenHyb("memory_lab_base", `lab-${p}`));
for (const [ix, d] of [["b0", "BM25 b=0"], ["b05", "BM25 b=0.5"], ["k1_2", "BM25 k1=2.0"], ["split_a", "Sudachi split A"], ["split_b", "Sudachi split B"], ["pos", "助詞・助動詞を除外"], ["syn", "検索時同義語"]]) {
  add(`bm25-${ix}`, `BM25 のみ / ${d}`, async q => single(`memory_lab_${ix}`, bm25(q)));
  add(`hyb-${ix}`, `hybrid 0.4/0.6 / ${d}`, qwenHyb(`memory_lab_${ix}`, "lab-minmax-46"));
}
const RAW_FIELDS = ["title^2", "content", "title.std", "content.std^0.5"];
add("bm25-raw", "BM25 のみ / standard サブフィールド併用", async q => single("memory_lab_raw", bm25(q, RAW_FIELDS)));
add("hyb-raw", "hybrid 0.4/0.6 / standard サブフィールド併用", qwenHyb("memory_lab_raw", "lab-minmax-46", RAW_FIELDS));
// Sarashina 埋め込み (memory_lab_sara: sara_vec 1536 次元、cosinesimil)
add("knn-sara", "kNN のみ (Sarashina3 embedding, RETRIEVAL_QUERY)", async q => single("memory_lab_sara", knn("sara_vec", await qvec("sara", q))));
add("knn-sara-qa", "kNN のみ (Sarashina3 embedding, QUESTION_ANSWERING)", async q => single("memory_lab_sara", knn("sara_vec", await qvec("sara-qa", q))));
add("hyb-sara", "hybrid 0.4/0.6 (BM25 + Sarashina kNN)", async q => hyb("memory_lab_sara", "lab-minmax-46", [bm25(q), knn("sara_vec", await qvec("sara", q))]));
add("hyb-sara-rrf", "hybrid RRF60 (BM25 + Sarashina kNN)", async q => hyb("memory_lab_sara", "lab-rrf-60", [bm25(q), knn("sara_vec", await qvec("sara", q))]));
add("hyb-qwen+sara", "hybrid RRF60 (BM25 + Qwen kNN + Sarashina kNN)", async q => hyb("memory_lab_sara", "lab-rrf-60-3way",
  [bm25(q), knn("embedding", await qvec("qwen", q)), knn("sara_vec", await qvec("sara", q))]));
// doc2query (memory_lab_d2q_<model>)
for (const m of ["nano", "nano_q3", "mini"]) {
  const ix = `memory_lab_d2q_${m}`;
  add(`bm25-d2q-${m}`, `BM25 のみ / 想定質問・キーワード・要約も対象 (${m})`, async q => single(ix, bm25(q, D2Q_FIELDS)));
  add(`hyb-d2q-${m}`, `hybrid 0.4/0.6 / BM25 に想定質問等 (${m})`, qwenHyb(ix, "lab-minmax-46", D2Q_FIELDS));
  add(`hyb3-d2q-${m}`, `hybrid 3本 min_max 0.3/0.4/0.3 / + 想定質問ベクトル (${m})`, async q => hyb(ix, "lab-minmax-3way",
    [bm25(q, D2Q_FIELDS), knn("embedding", await qvec("qwen", q)), nestedLive(await qvec("qwen", q))]));
  add(`hyb3rrf-d2q-${m}`, `hybrid 3本 RRF60 / + 想定質問ベクトル (${m})`, async q => hyb(ix, "lab-rrf-60-3way",
    [bm25(q, D2Q_FIELDS), knn("embedding", await qvec("qwen", q)), nestedLive(await qvec("qwen", q))]));
}
// リランク (Sarashina3 rerank、上位 20 メモリ)
for (const baseName of ["base", "hyb-rrf-60", "hyb-d2q-nano", "hyb-sara", "hyb-zscore-46", "hyb-b0-zscore", "hyb-b0-zscore+rescore-soft"])
  add(`rerank:${baseName}`, `${baseName} の上位 20 メモリを Sarashina3 rerank で並べ替え`, async q => ({ ...(await V.find(v => v.name === baseName).fn(q)), rerank: true }));

// ---- 指標 (メモリ単位。grade 2 が無いクエリは grade 1 を正解とする) は core の memoryMetrics() ----

async function rerankMemories(q, hits) {
  const best = new Map();
  for (const h of hits) if (!best.has(h._source.memory_id)) best.set(h._source.memory_id, h._source.content);
  const all = [...best.keys()];
  const ids = all.slice(0, 20);
  const key = sha("rerank" + q + ids.join(","));
  let res = cacheGet("rerank", key);
  let apiMs = cacheGet("rerank-ms", key) ?? 0;
  if (!res) {
    const t = performance.now();
    res = (await sarashina("/rerank", { model: "sarashina3-rerank", query: q, documents: ids.map(id => best.get(id)), task_type: "GENERAL_RETRIEVAL" }, 60)).data[0].result;
    apiMs = performance.now() - t;
    cacheSet("rerank", key, res); cacheSet("rerank-ms", key, apiMs);
    cacheFlush("rerank"); cacheFlush("rerank-ms");
  }
  return { ranking: [...res.map(r => ids[r.document_id]), ...all.slice(20)], apiMs };
}

async function indexExists(ix) { try { await os("GET", `/${ix}/_count`); return true; } catch { return false; } }

const filters = process.argv.slice(2);
const chosen = V.filter(v => !filters.length || filters.some(f => v.name === f || (f.endsWith("*") && v.name.startsWith(f.slice(0, -1)))));
mkdirSync("lab/data/results", { recursive: true });
const now = new Date();
const agg = (xs, k) => xs.length ? xs.reduce((s, x) => s + x[k], 0) / xs.length : NaN;
const p50 = xs => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(["variant", "R@5", "nDCG@10", "MRR@10", "nDCG(syn)", "nDCG(real)", "took_p50", "search_ms_p50", "rerank_ms_p50"].join("\t"));
for (const v of chosen) {
  const probe = await v.fn(evalSet[0].query);
  if (!(await indexExists(probe.index))) { console.log(`skip ${v.name} (index ${probe.index} なし)`); continue; }
  const per = [];
  for (const e of evalSet) {
    const req = await v.fn(e.query); // ベクトルはキャッシュから。ここから先を検索の遅延として測る
    const t = performance.now();
    const res = await os("POST", `/${req.index}/_search`, req.body, req.pipeline ? `?search_pipeline=${req.pipeline}` : "");
    const searchMs = performance.now() - t;
    let hits = res.hits.hits;
    if (req.rescore) hits = hits.map(h => ({ ...h, _score: rescore(h._score, h._source, RESCORE_CFG[req.rescore], now) })).sort((a, b) => b._score - a._score);
    let ranking = toMemoryRanking(hits);
    let rerankMs = 0;
    if (req.rerank) ({ ranking, apiMs: rerankMs } = await rerankMemories(e.query, hits));
    per.push({ qid: e.qid, set: e.set, ...memoryMetrics(ranking, e.relevant), took: res.took, searchMs, rerankMs, top: ranking.slice(0, 10) });
  }
  const summary = { name: v.name, desc: v.desc, n: per.length,
    recall5: agg(per, "recall5"), ndcg10: agg(per, "ndcg10"), mrr10: agg(per, "mrr10"),
    syn_ndcg10: agg(per.filter(p => p.set === "synthetic"), "ndcg10"), real_ndcg10: agg(per.filter(p => p.set === "real"), "ndcg10"),
    took_p50: p50(per.map(p => p.took)), search_ms_p50: p50(per.map(p => p.searchMs)), rerank_ms_p50: p50(per.map(p => p.rerankMs)) };
  writeFileSync(`lab/data/results/${v.name.replace(/:/g, "_")}.json`, JSON.stringify({ summary, per }, null, 1));
  console.log([v.name, ...[summary.recall5, summary.ndcg10, summary.mrr10, summary.syn_ndcg10, summary.real_ndcg10].map(x => x.toFixed(3)),
    summary.took_p50, summary.search_ms_p50.toFixed(0), summary.rerank_ms_p50.toFixed(0)].join("\t"));
}
