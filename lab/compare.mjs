// 2 つの variant の nDCG@10 をクエリ単位で比べる (勝ち/負け/引き分けと、対応のあるブートストラップの 95% 区間)
import { readFileSync } from "node:fs";
import { bootstrapDiff } from "../packages/core/src/index.ts";
const load = n => JSON.parse(readFileSync(`lab/data/results/${n.replace(/:/g, "_")}.json`, "utf8")).per;
const [a, ...bs] = process.argv.slice(2);
if (a !== undefined) {
  const A = load(a);
  for (const b of bs) {
    const B = load(b);
    const r = bootstrapDiff(A.map(x => x.ndcg10), A.map((_, i) => B[i].ndcg10));
    console.log(`${b} - ${a}: Δ=${r.mean.toFixed(3)} 95%CI[${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}] win ${r.win} lose ${r.lose} tie ${r.tie}`);
  }
}
