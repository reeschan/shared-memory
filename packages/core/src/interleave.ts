import type { Grades } from "./metrics.ts";

/** a は本番の設定、b は一次スコアだけ (呼び出し側で決める) */
export type Team = "a" | "b";
/** ids と teams は同じ長さ。ids は重複しない */
export type Interleaved = { ids: string[]; teams: Team[] };

const LCG_MOD = 2147483647;

/**
 * team-draft interleaving。各手で、取った数が少ない方が取る。同数ならコイン
 * (seed の線形合同法 seed = seed*48271 % 2147483647、0.5 未満なら a)。
 * 取る側は自分の順位のうちまだ入っていない最上位を出す。出せるものが無ければもう一方が出す。
 * 両方尽きるか limit 件で止める。limit 既定 10。seed は 1 以上の整数 (0 以下なら 1 に直す)。
 * 状態の初期値は seed をそのまま使わず、(seed * 6364136223846793005 + 1442695040888963407) % 2147483646 + 1 にかき混ぜる。
 */
export function teamDraft(a: string[], b: string[], seed: number, limit = 10): Interleaved {
  let base = Number.isFinite(seed) ? Math.floor(seed) : 1;
  if (base <= 0) base = 1;
  // 小さい seed でも最初のコインが偏らないよう、seed をかき混ぜてから状態にする (1〜2147483646 に収まる)
  let s = Number((BigInt(base) * 6364136223846793005n + 1442695040888963407n) % 2147483646n) + 1;
  const rnd = () => (s = (s * 48271) % LCG_MOD) / LCG_MOD;
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;

  const ids: string[] = [];
  const teams: Team[] = [];
  const picked = new Set<string>();
  let ia = 0;
  let ib = 0;
  let countA = 0;
  let countB = 0;

  while (ids.length < max) {
    while (ia < a.length && picked.has(a[ia]!)) ia++;
    while (ib < b.length && picked.has(b[ib]!)) ib++;
    const hasA = ia < a.length;
    const hasB = ib < b.length;
    if (!hasA && !hasB) break;

    let team: Team;
    if (countA < countB) team = "a";
    else if (countB < countA) team = "b";
    else team = rnd() < 0.5 ? "a" : "b";
    if (team === "a" && !hasA) team = "b";
    else if (team === "b" && !hasB) team = "a";

    const id = team === "a" ? a[ia]! : b[ib]!;
    picked.add(id);
    ids.push(id);
    teams.push(team);
    if (team === "a") countA++;
    else countB++;
  }
  return { ids, teams };
}

/** 各 team が出した id の等級 (grades、無ければ 0) の合計を比べる */
export function interleaveOutcome(il: Interleaved, grades: Grades): "a" | "b" | "tie" {
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < il.ids.length; i++) {
    const id = il.ids[i]!;
    const g = Object.prototype.hasOwnProperty.call(grades, id) ? (grades[id] ?? 0) : 0;
    if (il.teams[i] === "a") sumA += g;
    else if (il.teams[i] === "b") sumB += g;
  }
  if (sumA > sumB) return "a";
  if (sumB > sumA) return "b";
  return "tie";
}

/** 上位 k 件 (既定 10) の id の並びが違えば true */
export function topDiffers(a: string[], b: string[], k = 10): boolean {
  const ta = a.slice(0, Math.max(0, k));
  const tb = b.slice(0, Math.max(0, k));
  if (ta.length !== tb.length) return true;
  return ta.some((id, i) => id !== tb[i]);
}

/** 引き分けを除いた勝ち数・負け数の両側の正確な二項検定 (p=0.5) の p 値。wins+losses=0 なら 1 */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (!(n > 0)) return 1;
  const k = Math.min(wins, losses);
  // log P(X=i) を逐次に足していき、log-sum-exp で合計する (n が大きくても桁あふれしない)
  let logTerm = -n * Math.LN2; // log C(n,0) / 2^n
  const logs: number[] = [logTerm];
  for (let i = 0; i < k; i++) {
    logTerm += Math.log(n - i) - Math.log(i + 1);
    logs.push(logTerm);
  }
  const top = Math.max(...logs);
  let sum = 0;
  for (const l of logs) sum += Math.exp(l - top);
  const p = 2 * Math.exp(top + Math.log(sum));
  return Math.min(1, p);
}
