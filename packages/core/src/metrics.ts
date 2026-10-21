// 評価の指標 (メモリ単位の Recall@5 / nDCG@10 / MRR@10) と、2 つの結果の差のブートストラップ。
// 定義は lab/eval.mjs の metrics() と lab/compare.mjs から変えずに移したもの。

/** memory_id → 等級 (2 = 強い正解、1 = 部分的な正解) */
export type Grades = Record<string, number>;

export interface MemoryMetrics {
  recall5: number;
  ndcg10: number;
  mrr10: number;
}

/**
 * メモリ単位の指標。ranking は memory_id を上位から並べたもの。
 * - recall5: 等級 2 の id があればそれ、無ければ rel の全 id を対象に、上位 5 件に入った割合
 * - ndcg10: gain = 2^等級 - 1、割引 log2(順位 + 1)。理想 DCG が 0 なら 0
 * - mrr10: 上位 10 件で最初に等級 > 0 の id の 1/順位。無ければ 0
 */
export function memoryMetrics(ranking: string[], rel: Grades): MemoryMetrics {
  const gain = (id: string) => rel[id] ?? 0;
  const strong = Object.entries(rel).filter(([, g]) => g >= 2).map(([id]) => id);
  const target = strong.length ? strong : Object.keys(rel);
  const top5 = new Set(ranking.slice(0, 5));
  const recall5 = target.filter((id) => top5.has(id)).length / target.length;
  const dcg = ranking.slice(0, 10).reduce((s, id, i) => s + (2 ** gain(id) - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(rel)
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const first = ranking.slice(0, 10).findIndex((id) => gain(id) > 0);
  return { recall5, ndcg10: ideal ? dcg / ideal : 0, mrr10: first < 0 ? 0 : 1 / (first + 1) };
}

export interface BootstrapDiff {
  /** b - a の平均 */
  mean: number;
  /** 再標本の平均の 2.5% 点 */
  lo: number;
  /** 再標本の平均の 97.5% 点 */
  hi: number;
  win: number;
  lose: number;
  tie: number;
}

const TIE_EPS = 1e-9;

/**
 * 対応のある 2 つの結果 (問いごとの値) の差 b[i] - a[i] について、平均と
 * ブートストラップの 95% 区間、勝ち/負け/引き分けの数を返す。
 * 乱数は lab/compare.mjs と同じ線形合同法 (既定 seed 1、iterations 5000)。
 */
export function bootstrapDiff(
  a: number[],
  b: number[],
  opts: { iterations?: number; seed?: number } = {},
): BootstrapDiff {
  if (a.length !== b.length) throw new Error(`bootstrapDiff: length mismatch (${a.length} vs ${b.length})`);
  const iterations = opts.iterations ?? 5000;
  let seed = opts.seed ?? 1;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const d = a.map((x, i) => b[i]! - x);
  const means: number[] = [];
  for (let r = 0; r < iterations; r++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[Math.floor(rnd() * d.length)]!;
    means.push(s / d.length);
  }
  means.sort((x, y) => x - y);
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  return {
    mean,
    lo: means[Math.floor(iterations * 0.025)]!,
    hi: means[Math.floor(iterations * 0.975)]!,
    win: d.filter((x) => x > TIE_EPS).length,
    lose: d.filter((x) => x < -TIE_EPS).length,
    tie: d.filter((x) => Math.abs(x) <= TIE_EPS).length,
  };
}
