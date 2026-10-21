// 評価の 1 回の実行 (EvalRun) を、人が読む Markdown のレポートと、標準出力用の数行にする。
// ファイルには書かない (書くのは呼び出し側)。
import type { EvalQuestion } from "./evalset.ts";
import type { EvalRun, PerQuestion } from "./evaluate.ts";

/** 「本番より一次スコアだけが良かった問い」の最大件数 */
const WORSE_LIMIT = 10;

function f3(x: number): string {
  return x.toFixed(3);
}

function signed(x: number): string {
  return (x >= 0 ? "+" : "") + x.toFixed(3);
}

function orNone(x: number | null, fmt: (v: number) => string = f3): string {
  return x === null ? "該当なし" : fmt(x);
}

function yesNo(b: boolean): string {
  return b ? "はい" : "いいえ";
}

/** Markdown の表のセルに入れられるようにする (縦棒と改行を逃がす) */
function cell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** 本番より一次スコアだけの nDCG@10 が高かった問いを、差の大きい順に最大 10 件 */
function primaryBetter(
  perQuestion: PerQuestion[],
  questions: EvalQuestion[],
): { qid: string; query: string; diff: number }[] {
  const byQid = new Map(questions.map((q) => [q.qid, q]));
  return perQuestion
    .map((p) => ({ qid: p.qid, query: byQid.get(p.qid)?.query ?? p.qid, diff: p.production.ndcg10 - p.primary.ndcg10 }))
    .filter((x) => x.diff < 0)
    .sort((a, b) => a.diff - b.diff || a.qid.localeCompare(b.qid))
    .slice(0, WORSE_LIMIT);
}

/** 人が読む Markdown のレポート */
export function renderReport(run: EvalRun, perQuestion: PerQuestion[], questions: EvalQuestion[]): string {
  const L: string[] = [];
  L.push(`# 評価レポート (${run.at})`, "");
  L.push(`正解のある問い: ${run.n} 件`, "");

  L.push("## 指標 (問いの平均)", "");
  L.push("| 設定 | nDCG@10 | Recall@5 | MRR@10 |", "| --- | --- | --- | --- |");
  L.push(`| 本番 | ${f3(run.production.ndcg10)} | ${f3(run.production.recall5)} | ${f3(run.production.mrr10)} |`);
  L.push(`| 一次スコアだけ | ${f3(run.primary.ndcg10)} | ${f3(run.primary.recall5)} | ${f3(run.primary.mrr10)} |`);
  L.push("");
  L.push(
    `nDCG@10 の差 (本番 - 一次スコアだけ): ${signed(run.diff.mean)} (95% 区間 ${signed(run.diff.lo)} 〜 ${signed(run.diff.hi)})`,
  );
  L.push(`問いごとの勝ち負け: 本番が上 ${run.diff.win} / 下 ${run.diff.lose} / 同じ ${run.diff.tie}`, "");

  L.push("## ガード", "");
  L.push(`- 警告: ${run.guard.alert ? "あり" : "なし"}`);
  L.push(`- 本番が有意に低い (差の 95% 区間の上端が 0 未満): ${yesNo(run.guard.worse)}`);
  L.push(`- 理由: ${run.guard.reason ?? "なし"}`, "");

  L.push("## インターリービング (累計)", "");
  L.push(
    `- 本番の勝ち ${run.interleave.wins} / 一次スコアだけの勝ち ${run.interleave.losses} / 引き分け ${run.interleave.ties}`,
  );
  L.push(`- 符号検定の p 値: ${run.interleave.p.toFixed(4)}`, "");

  L.push("## 鮮度が効く問い", "");
  L.push(`問いの数: ${run.freshness.n} 件`, "");
  L.push("| 指標 | 値 |", "| --- | --- |");
  L.push(`| 本番の nDCG@10 | ${orNone(run.freshness.production_ndcg10)} |`);
  L.push(`| 一次スコアだけの nDCG@10 | ${orNone(run.freshness.primary_ndcg10)} |`);
  L.push(`| 新しい版が古い版より上に出た割合 (本番) | ${orNone(run.freshness.newer_above_rate)} |`);
  L.push("");

  L.push("## 作成日の分布 (週ごと)", "");
  if (run.created_dist.weeks.length === 0) {
    L.push("該当なし", "");
  } else {
    L.push("| 週 | 検索対象 | 正解 |", "| --- | --- | --- |");
    run.created_dist.weeks.forEach((w, i) => {
      L.push(`| ${w} | ${run.created_dist.corpus[i] ?? 0} | ${run.created_dist.gold[i] ?? 0} |`);
    });
    L.push("");
  }

  L.push("## 見直す条件", "");
  const r = run.review;
  L.push("| 条件 | 値 | 満たす |", "| --- | --- | --- |");
  L.push(`| 作成日の幅が半減期の 2 倍以上 | ${r.span_days.toFixed(1)} 日 | ${yesNo(r.span_ok)} |`);
  L.push(`| 人のラベルの問いが 150 以上 | ${r.human_n} | ${yesNo(r.human_ok)} |`);
  L.push(`| 人のラベルの鮮度が効く問いが 30 以上 | ${r.fresh_n} | ${yesNo(r.fresh_ok)} |`);
  L.push(
    `| 合図 (ガードの警告、または新しい版が上に出た割合が 0.6 未満) | ${orNone(run.freshness.newer_above_rate)} | ${yesNo(r.signal)} |`,
  );
  L.push("");
  L.push(`4 つそろっているか: ${r.ready ? "そろっている (見直しを検討する)" : "そろっていない"}`, "");

  L.push("## 注意", "");
  L.push(
    "- アクセスの項は評価の時点の値で、漏れを含む (問われた時点より後のアクセスも、本番の並びに効いている)。",
    "",
  );

  L.push("## 本番より一次スコアだけが良かった問い (nDCG@10、最大 10 件)", "");
  const worse = primaryBetter(perQuestion, questions);
  if (worse.length === 0) {
    L.push("該当なし");
  } else {
    L.push("| qid | 問い | 差 (本番 - 一次スコアだけ) |", "| --- | --- | --- |");
    for (const w of worse) L.push(`| ${cell(w.qid)} | ${cell(w.query)} | ${signed(w.diff)} |`);
  }
  L.push("");
  return L.join("\n");
}

/** 標準出力用の数行 */
export function summaryLines(run: EvalRun): string[] {
  const lines = [
    `評価 ${run.at}: 正解のある問い ${run.n} 件`,
    `nDCG@10 本番 ${f3(run.production.ndcg10)} / 一次スコアだけ ${f3(run.primary.ndcg10)} (差 ${signed(run.diff.mean)}、95% 区間 ${signed(run.diff.lo)} 〜 ${signed(run.diff.hi)})`,
    `Recall@5 本番 ${f3(run.production.recall5)} / 一次スコアだけ ${f3(run.primary.recall5)}、MRR@10 本番 ${f3(run.production.mrr10)} / 一次スコアだけ ${f3(run.primary.mrr10)}`,
    run.guard.alert ? `ガード: 警告あり (${run.guard.reason ?? ""})` : `ガード: 警告なし${run.guard.reason ? ` (${run.guard.reason})` : ""}`,
    `インターリービング: 本番の勝ち ${run.interleave.wins} / 負け ${run.interleave.losses} / 引き分け ${run.interleave.ties} (p=${run.interleave.p.toFixed(4)})`,
    `鮮度が効く問い ${run.freshness.n} 件: nDCG@10 本番 ${orNone(run.freshness.production_ndcg10)} / 一次スコアだけ ${orNone(run.freshness.primary_ndcg10)}`,
    `見直す条件: ${run.review.ready ? "4 つそろっている" : "そろっていない"}`,
  ];
  return lines;
}
