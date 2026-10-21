// 机上の実験: kNN (Qwen3) 上位 50 チャンクを min_max で正規化し、rescore のパラメーターのセットを総当たりで比べる
// 使い方: node sim.mjs <lab/data のパス>
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = process.argv[2];
const jl = p => readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 32);
const QI = "Instruct: Given a question or keywords, retrieve memory notes that answer or relate to it\nQuery: ";
const chunks = jl(`${dir}/chunks.jsonl`).filter(c => !c.is_superseded && (c.tier === "hot" || c.tier === "warm"));
const E = jl(`${dir}/eval.jsonl`);
const qv = JSON.parse(readFileSync(`${dir}/cache/qvec.json`, "utf8"));
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
for (const c of chunks) c.e = norm(c.embedding);
const NOW = Date.parse(process.env.NOW ?? "2026-10-17T06:00:00Z");

// クエリごとの候補 (チャンク、正規化済みスコア)
const cands = E.map(e => {
  let v = qv[sha("qwen" + QI + e.query)] ?? qv[sha("qwen" + e.query)];
  if (!v) throw new Error("no qvec " + e.qid);
  v = norm(v);
  const s = chunks.map(c => ({ c, s: c.e.reduce((a, x, i) => a + x * v[i], 0) })).sort((a, b) => b.s - a.s).slice(0, 50);
  const mx = s[0].s, mn = s[s.length - 1].s;
  return s.map(x => ({ c: x.c, s: (x.s - mn) / (mx - mn || 1) }));
});

function ndcg(ranking, rel) {
  const g = id => rel[id] ?? 0;
  const dcg = ranking.slice(0, 10).reduce((s, id, i) => s + (2 ** g(id) - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(rel).sort((a, b) => b - a).slice(0, 10).reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0);
  return dcg / ideal;
}
const PROVS = { flat: { human_confirmed: 1, agent_verified: 1, agent_inferred: 1 }, mild: { human_confirmed: 1, agent_verified: 0.95, agent_inferred: 0.9 }, cur: { human_confirmed: 1, agent_verified: 0.85, agent_inferred: 0.7 } };
function run(p) {
  return E.map((e, qi) => {
    const best = new Map();
    for (const { c, s } of cands[qi]) {
      const days = Math.max(0, (NOW - Date.parse(p.byCreated ? c.created_at : (c.last_accessed_at ?? c.created_at))) / 864e5);
      const decay = p.hl === Infinity ? 1 : 0.5 ** (days / p.hl);
      const r = s * (p.floor + (1 - p.floor) * decay) * (1 + p.aw * Math.log(1 + (c.access_count ?? 0))) * PROVS[p.prov][c.provenance];
      if (!best.has(c.memory_id) || best.get(c.memory_id) < r) best.set(c.memory_id, r);
    }
    return ndcg([...best.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]), e.relevant);
  });
}
const grid = [];
for (const hl of [7, 14, 30, 60, 120, Infinity]) for (const floor of [0, 0.5, 0.7, 0.85]) for (const aw of [0, 0.1, 0.2, 0.5, 1]) for (const prov of ["flat", "mild", "cur"]) for (const byCreated of [false, true])
  grid.push({ hl, floor, aw, prov, byCreated });
const name = p => `hl${p.hl}/f${p.floor}/aw${p.aw}/${p.prov}/${p.byCreated ? "created" : "accessed"}`;
const per = grid.map(p => ({ p, x: run(p) }));
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const none = per.find(r => r.p.hl === Infinity && r.p.floor === 0 && r.p.aw === 0 && r.p.prov === "flat" && !r.p.byCreated);
const cur = per.find(r => r.p.hl === 30 && r.p.floor === 0.7 && r.p.aw === 0.2 && r.p.prov === "cur" && !r.p.byCreated);
console.log("rescore なし", mean(none.x).toFixed(3), " 現行 (soft)", mean(cur.x).toFixed(3));
const sorted = [...per].sort((a, b) => mean(b.x) - mean(a.x));
console.log("上位 8:"); for (const r of sorted.slice(0, 8)) console.log(" ", name(r.p), mean(r.x).toFixed(3));
console.log("下位 3:"); for (const r of sorted.slice(-3)) console.log(" ", name(r.p), mean(r.x).toFixed(3));
// 減衰の項だけの効き (aw=0, prov=flat) と、各セットの「なし」との差の 95% 区間
let seed = 1; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
function ci(d) { const m = []; for (let r = 0; r < 2000; r++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(rnd() * d.length)]; m.push(s / d.length); } m.sort((a, b) => a - b); return [m[50], m[1950]]; }
const distinct = per.filter(r => r.x.some((v, i) => Math.abs(v - none.x[i]) > 1e-9));
let sigBetter = 0, sigWorse = 0;
for (const r of per) { const d = r.x.map((v, i) => v - none.x[i]); const [lo, hi] = ci(d); if (lo > 0) sigBetter++; if (hi < 0) sigWorse++; }
console.log(`全 ${per.length} セット中、なしと順位が変わるもの ${distinct.length}、有意に良い ${sigBetter}、有意に悪い ${sigWorse}`);
console.log("減衰の項だけ (aw0, flat):"); for (const r of per.filter(r => r.p.aw === 0 && r.p.prov === "flat" && r.p.floor === 0.7)) console.log(" ", name(r.p), mean(r.x).toFixed(3), `変わった問 ${r.x.filter((v, i) => Math.abs(v - none.x[i]) > 1e-9).length}`);
console.log("アクセスの項だけ (hl∞, flat):"); for (const r of per.filter(r => r.p.hl === Infinity && r.p.prov === "flat" && r.p.floor === 0 && !r.p.byCreated)) console.log(" ", name(r.p), mean(r.x).toFixed(3));
console.log("出所の項だけ:"); for (const r of per.filter(r => r.p.hl === Infinity && r.p.aw === 0 && r.p.floor === 0 && !r.p.byCreated)) console.log(" ", name(r.p), mean(r.x).toFixed(3));

// 交差検証: 5 分割を 50 回。学習側で最良のセットを選び、検証側で「なし」「現行」と比べる
const idx = E.map((_, i) => i);
const pick = (tr, cand) => cand.reduce((b, r) => { const m = mean(tr.map(i => r.x[i])); return m > b.m ? { r, m } : b; }, { r: null, m: -1 });
let gainsNone = [], gainsCur = [], optimism = [], chosen = new Map();
for (let rep = 0; rep < 50; rep++) {
  const sh = idx.slice().sort(() => rnd() - 0.5);
  for (let f = 0; f < 5; f++) {
    const te = sh.filter((_, i) => i % 5 === f), tr = sh.filter((_, i) => i % 5 !== f);
    const { r, m } = pick(tr, per);
    chosen.set(name(r.p), (chosen.get(name(r.p)) ?? 0) + 1);
    const t = mean(te.map(i => r.x[i]));
    gainsNone.push(t - mean(te.map(i => none.x[i]))); gainsCur.push(t - mean(te.map(i => cur.x[i]))); optimism.push(m - t);
  }
}
console.log(`CV: 選んだセットの検証側での差 vs なし ${mean(gainsNone).toFixed(4)}、vs 現行 ${mean(gainsCur).toFixed(4)}、学習側の楽観 (学習 - 検証) ${mean(optimism).toFixed(4)}`);
console.log(`CV: 選ばれたセットの種類 ${chosen.size} / ${50 * 5} 回。多い順:`, [...chosen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5));
// 1 問ずつの差の標準偏差 (なし vs 現行) から、Δ=0.01 を検出するのに要る問数
const d = cur.x.map((v, i) => v - none.x[i]); const sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2)));
console.log(`なし vs 現行: Δ ${mean(d).toFixed(4)} 区間 ${ci(d).map(x => x.toFixed(3))}、1 問の差の SD ${sd.toFixed(3)}、Δ0.01 を 95% で分けるのに要る問数 ≈ ${Math.ceil((1.96 * sd / 0.01) ** 2)}`);
// アクセス項の効きを synthetic / real に分ける。正解と非正解のアクセス回数
const aw2 = per.find(r => r.p.hl === Infinity && r.p.floor === 0 && r.p.aw === 0.2 && r.p.prov === "flat" && !r.p.byCreated);
for (const set of ["synthetic", "real"]) { const ii = idx.filter(i => E[i].set === set); console.log(set, "aw0.2 - なし", mean(ii.map(i => aw2.x[i] - none.x[i])).toFixed(4)); }
const byId = new Map(chunks.map(c => [c.memory_id, c]));
for (const set of ["synthetic", "real"]) {
  const gold = new Set(E.filter(e => e.set === set).flatMap(e => Object.keys(e.relevant)));
  const ac = [...gold].map(id => byId.get(id)?.access_count ?? 0);
  console.log(set, "正解の access>0 の割合", (ac.filter(x => x > 0).length / ac.length).toFixed(2), "平均", mean(ac).toFixed(2));
}
const all = [...new Set(chunks.map(c => c.memory_id))].map(id => byId.get(id).access_count ?? 0);
console.log("検索対象全体の access>0 の割合", (all.filter(x => x > 0).length / all.length).toFixed(2), "平均", mean(all).toFixed(2));
