// 評価の核。本番の設定と一次スコアだけを、問われた時点の状態で測り、差の 95% 区間からガードの判定を出す。
// 検索の関数は外から受け取る (アクセスもログも書かない)。ファイルに書くのは appendHistory だけ。
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { effectiveLabel, type EvalQuestion } from "./evalset.ts";
import { signTest } from "./interleave.ts";
import { bootstrapDiff, memoryMetrics, type BootstrapDiff, type Grades, type MemoryMetrics } from "./metrics.ts";
import { supersededAtMap, type AsOf } from "./search.ts";

/** memory_id を上位から返す */
export type Searcher = (q: EvalQuestion, asOf: AsOf) => Promise<string[]>;
export type MemoryInfo = { created_at: string; supersedes?: string };
export type ConfigMetrics = { ndcg10: number; recall5: number; mrr10: number };
export type EvalRun = {
  at: string;
  /** 正解のある (effectiveLabel の relevant が空でない) 問いの数 */
  n: number;
  /** 問いの平均 */
  production: ConfigMetrics;
  primary: ConfigMetrics;
  /** bootstrapDiff(primary の nDCG@10 の列, production の列) → mean = 本番 - 一次スコアだけ */
  diff: BootstrapDiff;
  guard: { worse: boolean; alert: boolean; reason: string | null };
  interleave: { wins: number; losses: number; ties: number; p: number };
  freshness: {
    n: number;
    production_ndcg10: number | null;
    primary_ndcg10: number | null;
    newer_above_rate: number | null;
  };
  /** ISO 週 "2026-W43"。corpus は memories の全件、gold は正解 (等級 1 以上) の id の数 */
  created_dist: { weeks: string[]; corpus: number[]; gold: number[] };
  review: {
    span_days: number;
    span_ok: boolean;
    human_n: number;
    human_ok: boolean;
    fresh_n: number;
    fresh_ok: boolean;
    signal: boolean;
    ready: boolean;
  };
};
export type PerQuestion = { qid: string; fresh: boolean; production: MemoryMetrics; primary: MemoryMetrics };

export const HISTORY_FILE = "history.jsonl";

const TOP_K = 10;
const P_ALERT = 0.05;
const HUMAN_MIN = 150;
const FRESH_MIN = 30;
const NEWER_ABOVE_MIN = 0.6;
const DAY_MS = 86_400_000;

/** ISO 週 (月曜始まり、1 月 4 日を含む週が第 1 週) を "YYYY-Www" で。UTC で数える */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; // 月=1 … 日=7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // その週の木曜
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** その ISO 週の月曜 (UTC 0 時) */
function weekMonday(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() - (dow - 1));
  return t;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function avgMetrics(ms: MemoryMetrics[]): ConfigMetrics {
  return {
    ndcg10: mean(ms.map((m) => m.ndcg10)),
    recall5: mean(ms.map((m) => m.recall5)),
    mrr10: mean(ms.map((m) => m.mrr10)),
  };
}

function goldIds(rel: Grades): string[] {
  return Object.entries(rel)
    .filter(([, g]) => typeof g === "number" && g >= 1)
    .map(([id]) => id);
}

/** 正解 g ごとの「古い版」の id (supersedes の相手と stale_ids)。g 自身は除く */
function oldPairs(gold: string[], staleIds: string[], memories: ReadonlyMap<string, MemoryInfo>): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const g of gold) {
    const olds: string[] = [];
    const sup = memories.get(g)?.supersedes;
    if (sup) olds.push(sup);
    olds.push(...staleIds);
    for (const o of olds) {
      if (o === g) continue;
      const k = `${g}\u0000${o}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([g, o]);
    }
  }
  return out;
}

function createdDist(
  memories: ReadonlyMap<string, MemoryInfo>,
  gold: Set<string>,
): { weeks: string[]; corpus: number[]; gold: number[] } {
  const corpusBy = new Map<string, number>();
  const goldBy = new Map<string, number>();
  let min: Date | undefined;
  let max: Date | undefined;
  for (const [id, m] of memories) {
    const t = Date.parse(m.created_at);
    if (Number.isNaN(t)) continue;
    const d = new Date(t);
    const w = isoWeek(d);
    corpusBy.set(w, (corpusBy.get(w) ?? 0) + 1);
    if (gold.has(id)) goldBy.set(w, (goldBy.get(w) ?? 0) + 1);
    if (min === undefined || t < min.getTime()) min = d;
    if (max === undefined || t > max.getTime()) max = d;
  }
  const weeks: string[] = [];
  if (min !== undefined && max !== undefined) {
    // 最初の週から最後の週まで、間の週も 0 で埋める
    const last = weekMonday(max).getTime();
    for (let t = weekMonday(min).getTime(); t <= last; t += 7 * DAY_MS) weeks.push(isoWeek(new Date(t)));
  }
  return {
    weeks,
    corpus: weeks.map((w) => corpusBy.get(w) ?? 0),
    gold: weeks.map((w) => goldBy.get(w) ?? 0),
  };
}

function spanDays(memories: ReadonlyMap<string, MemoryInfo>): number {
  let min = Infinity;
  let max = -Infinity;
  for (const m of memories.values()) {
    const t = Date.parse(m.created_at);
    if (Number.isNaN(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return max >= min ? (max - min) / DAY_MS : 0;
}

/**
 * 正解のある問いごとに、本番 (production) と一次スコアだけ (primary) の検索を、問われた時点の状態で直列に流して採点する。
 * 副作用は持たない (history は読むだけ)
 */
export async function runEvaluation(input: {
  questions: EvalQuestion[];
  production: Searcher;
  primary: Searcher;
  memories: ReadonlyMap<string, MemoryInfo>;
  history: EvalRun[];
  interleave: { wins: number; losses: number; ties: number };
  halfLifeDays: number;
  now: Date;
}): Promise<{ run: EvalRun; perQuestion: PerQuestion[] }> {
  const { questions, memories, history, halfLifeDays, now } = input;
  const supersededAt = supersededAtMap(
    [...memories].map(([id, m]) => ({ id, created_at: m.created_at, supersedes: m.supersedes })),
  );

  const perQuestion: PerQuestion[] = [];
  const allGold = new Set<string>();
  let humanN = 0;
  let freshHumanN = 0;
  let pairs = 0;
  let pairsAbove = 0;

  for (const q of questions) {
    const label = effectiveLabel(q);
    if (label === undefined) continue;
    const gold = goldIds(label.relevant);
    if (gold.length === 0) continue;

    const asOf: AsOf = { at: new Date(q.asked_at), supersededAt };
    // OpenSearch への負荷を抑えるため直列に流す
    const prodRanking = await input.production(q, asOf);
    const primRanking = await input.primary(q, asOf);

    const staleIds = label.stale_ids ?? [];
    const prodTop = new Set(prodRanking.slice(0, TOP_K));
    const primTop = new Set(primRanking.slice(0, TOP_K));
    const supersededShown = gold.some((g) => {
      const o = memories.get(g)?.supersedes;
      return o !== undefined && o !== "" && (prodTop.has(o) || primTop.has(o));
    });
    const fresh = q.freshness_sensitive === true || supersededShown || staleIds.length > 0;

    if (fresh) {
      const pos = new Map<string, number>();
      prodRanking.forEach((id, i) => {
        if (!pos.has(id)) pos.set(id, i);
      });
      for (const [g, o] of oldPairs(gold, staleIds, memories)) {
        const pg = pos.get(g);
        const po = pos.get(o);
        if (pg === undefined || po === undefined) continue;
        pairs++;
        if (pg < po) pairsAbove++;
      }
    }

    for (const g of gold) allGold.add(g);
    if (label.source === "human") {
      humanN++;
      if (fresh) freshHumanN++;
    }
    perQuestion.push({
      qid: q.qid,
      fresh,
      production: memoryMetrics(prodRanking, label.relevant),
      primary: memoryMetrics(primRanking, label.relevant),
    });
  }

  const n = perQuestion.length;
  const diff: BootstrapDiff =
    n === 0
      ? { mean: 0, lo: 0, hi: 0, win: 0, lose: 0, tie: 0 }
      : bootstrapDiff(
          perQuestion.map((p) => p.primary.ndcg10),
          perQuestion.map((p) => p.production.ndcg10),
        );

  const { wins, losses, ties } = input.interleave;
  const p = signTest(wins, losses);
  const worse = n > 0 && diff.hi < 0;
  const prevWorse = history.length > 0 && history[history.length - 1]!.guard.worse;
  const reasons: string[] = [];
  if (worse && prevWorse) reasons.push("本番の nDCG@10 が一次スコアだけより、2 回続けて有意に低い (差の 95% 区間の上端が 0 未満)");
  else if (worse) reasons.push("本番の nDCG@10 が一次スコアだけより有意に低い (差の 95% 区間の上端が 0 未満)。次も続けば alert");
  const interleaveLose = losses > wins && p < P_ALERT;
  if (interleaveLose) reasons.push(`インターリービングで一次スコアだけが有意に勝っている (${wins} 勝 ${losses} 敗、p=${p.toFixed(4)})`);
  const alert = (worse && prevWorse) || interleaveLose;

  const freshQs = perQuestion.filter((q) => q.fresh);
  const newerAboveRate = pairs === 0 ? null : pairsAbove / pairs;

  const span = spanDays(memories);
  const spanOk = span >= 2 * halfLifeDays;
  const humanOk = humanN >= HUMAN_MIN;
  const freshOk = freshHumanN >= FRESH_MIN;
  const signal = alert || (newerAboveRate !== null && newerAboveRate < NEWER_ABOVE_MIN);

  const run: EvalRun = {
    at: now.toISOString(),
    n,
    production: avgMetrics(perQuestion.map((q) => q.production)),
    primary: avgMetrics(perQuestion.map((q) => q.primary)),
    diff,
    guard: { worse, alert, reason: reasons.length === 0 ? null : reasons.join(" / ") },
    interleave: { wins, losses, ties, p },
    freshness: {
      n: freshQs.length,
      production_ndcg10: freshQs.length === 0 ? null : mean(freshQs.map((q) => q.production.ndcg10)),
      primary_ndcg10: freshQs.length === 0 ? null : mean(freshQs.map((q) => q.primary.ndcg10)),
      newer_above_rate: newerAboveRate,
    },
    created_dist: createdDist(memories, allGold),
    review: {
      span_days: span,
      span_ok: spanOk,
      human_n: humanN,
      human_ok: humanOk,
      fresh_n: freshHumanN,
      fresh_ok: freshOk,
      signal,
      ready: spanOk && humanOk && freshOk && signal,
    },
  };
  return { run, perQuestion };
}

/** 履歴の 1 行で、読む側 (ガードの判定・画面) が使うオブジェクトの欄のうち、無いものの名前 */
function missingRunField(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "実行の記録 (オブジェクト)";
  const r = v as Record<string, unknown>;
  for (const k of ["production", "primary", "diff", "guard", "interleave"]) {
    if (typeof r[k] !== "object" || r[k] === null) return k;
  }
  return undefined;
}

/** `<dir>/history.jsonl` を古い順に読む。無ければ []。空行は無視し、壊れた行は行番号入りの Error */
export async function readHistory(dir: string): Promise<EvalRun[]> {
  const file = join(dir, HISTORY_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: EvalRun[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch (e) {
      throw new Error(`${file}: ${i + 1} 行目が JSON として読めません (${(e as Error).message})`);
    }
    const missing = missingRunField(v);
    if (missing !== undefined) throw new Error(`${file}: ${i + 1} 行目に ${missing} がありません`);
    out.push(v as EvalRun);
  }
  return out;
}

/** 1 回の実行を 1 行で追記する。dir が無ければ作る */
export async function appendHistory(dir: string, run: EvalRun): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, HISTORY_FILE), JSON.stringify(run) + "\n", "utf8");
}
