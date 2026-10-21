// 検証用の Search Pipeline (lab-*) を作る。本番の memories-hybrid には触らない
import { os } from "./lib.mjs";
const norm = (technique, w) => ({ phase_results_processors: [{ "normalization-processor": {
  normalization: { technique }, combination: { technique: "arithmetic_mean", parameters: { weights: w } } } }] });
const rrf = k => ({ phase_results_processors: [{ "score-ranker-processor": { combination: { technique: "rrf", rank_constant: k } } }] });
export const PIPELINES = {
  "lab-minmax-46": norm("min_max", [0.4, 0.6]),
  "lab-minmax-28": norm("min_max", [0.2, 0.8]),
  "lab-minmax-37": norm("min_max", [0.3, 0.7]),
  "lab-minmax-55": norm("min_max", [0.5, 0.5]),
  "lab-minmax-64": norm("min_max", [0.6, 0.4]),
  "lab-l2-46": norm("l2", [0.4, 0.6]),
  "lab-zscore-46": norm("z_score", [0.4, 0.6]),
  "lab-rrf-60": rrf(60),
  "lab-rrf-20": rrf(20),
  // 3 本のサブクエリ用 (BM25, 本文ベクトル, 想定質問ベクトル)
  "lab-minmax-3way": norm("min_max", [0.3, 0.4, 0.3]),
  "lab-rrf-60-3way": rrf(60),
};
for (const [id, body] of Object.entries(PIPELINES)) {
  try { await os("PUT", `/_search/pipeline/${id}`, body); console.log("ok", id); }
  catch (e) { console.log("NG", id, e.message.slice(0, 300)); }
}
