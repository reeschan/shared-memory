// `sm eval` と `sm eval import-lab <file>` の処理。CLI のプロセスを起動せずにテストできるよう、
// cfg と依存 (検索の関数・memories) を受け取る関数にしてある。
// 評価はアクセスもログも書かない (searchMemories を直接呼び、stats の logSearch を呼ばない)。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendHistory,
  createReranker,
  evalDir,
  fromLabEvalJsonl,
  interleaveTotals,
  primaryOnlyConfig,
  questionKey,
  readEvalSet,
  readHistory,
  renderReport,
  runEvaluation,
  scanMemories,
  searchMemories,
  summaryLines,
  writeEvalSet,
  type Config,
  type Embedder,
  type EvalRun,
  type MemoryInfo,
  type OpenSearchClient,
  type Searcher,
  type SessionSearcher,
} from "@shared-memory/core";

export type EvalIO = { out: (text: string) => void; err: (text: string) => void };

const defaultIO: EvalIO = {
  out: (t) => console.log(t),
  err: (t) => console.error(t),
};

export const EMPTY_EVAL_SET_MESSAGE = "評価セットがありません。sm eval import-lab <file> で取り込めます";

export type EvalCommandDeps = {
  production: Searcher;
  primary: Searcher;
  /** id → created_at・supersedes。評価セットが空でないと分かってから呼ぶ */
  loadMemories: () => Promise<ReadonlyMap<string, MemoryInfo>>;
  now?: Date;
  io?: EvalIO;
};

/** ローカル時刻の日付 YYYY-MM-DD */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `sm eval`: 評価を流し、履歴に追記し、レポートを書き、要約を出す。警告が出ても終了コードは 0 */
export async function runEvalCommand(
  cfg: Config,
  deps: EvalCommandDeps,
  opts: { json: boolean },
): Promise<{ code: number; run?: EvalRun; reportPath?: string }> {
  const io = deps.io ?? defaultIO;
  const dir = evalDir(cfg);
  const questions = await readEvalSet(dir);
  if (questions.length === 0) {
    if (opts.json) io.out(JSON.stringify({ error: EMPTY_EVAL_SET_MESSAGE }, null, 2));
    else io.err(EMPTY_EVAL_SET_MESSAGE);
    return { code: 1 };
  }
  const memories = await deps.loadMemories();
  const history = await readHistory(dir);
  const totals = await interleaveTotals(dir);
  const now = deps.now ?? new Date();
  const { run, perQuestion } = await runEvaluation({
    questions,
    production: deps.production,
    primary: deps.primary,
    memories,
    history,
    interleave: { wins: totals.wins, losses: totals.losses, ties: totals.ties },
    halfLifeDays: cfg.search.half_life_days,
    now,
  });
  await appendHistory(dir, run);
  const reportsDir = join(dir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `${localDate(now)}.md`);
  await writeFile(reportPath, renderReport(run, perQuestion, questions), "utf8");
  if (opts.json) io.out(JSON.stringify(run, null, 2));
  else io.out([...summaryLines(run), `レポート: ${reportPath}`].join("\n"));
  return { code: 0, run, reportPath };
}

/** `sm eval import-lab <file>`: lab の評価セットを取り込む。questionKey が同じ問いは足さない */
export async function importLabCommand(
  cfg: Config,
  file: string,
  opts: { json: boolean; io?: EvalIO },
): Promise<{ code: number; added: number; skipped: number; total: number }> {
  const io = opts.io ?? defaultIO;
  const dir = evalDir(cfg);
  const incoming = fromLabEvalJsonl(await readFile(file, "utf8"));
  const existing = await readEvalSet(dir);
  const keys = new Set(existing.map((q) => questionKey(q.query, q.filters)));
  const next = [...existing];
  let added = 0;
  let skipped = 0;
  for (const q of incoming) {
    const k = questionKey(q.query, q.filters);
    if (keys.has(k)) {
      skipped++;
      continue;
    }
    keys.add(k);
    next.push(q);
    added++;
  }
  if (added > 0) await writeEvalSet(dir, next);
  const result = { added, skipped, total: next.length };
  if (opts.json) io.out(JSON.stringify({ ...result, dir }, null, 2));
  else io.out(`取り込み ${added} 件 / 既にある問い ${skipped} 件 / 評価セット ${next.length} 件 (${dir})`);
  return { code: 0, ...result };
}

/**
 * 問われた時点 (asOf) で検索し、SearchResult をそのまま返す関数を作る (sm eval と sm feedback で共有)。
 * 一次スコアだけは primaryOnlyConfig(cfg) を渡す。リランクの有無は cfgX.rerank に従う。アクセスもログも書かない
 */
export function makeSessionSearcher(cfgX: Config, deps: { os: OpenSearchClient; embedder: Embedder }): SessionSearcher {
  const reranker = createReranker(cfgX.rerank);
  return (input, asOf) =>
    searchMemories(
      cfgX,
      { os: deps.os, embedder: deps.embedder, reranker, log: (msg) => console.error(msg) },
      input,
      undefined,
      { asOf },
    );
}

/** 本番の検索 (cfg) を Searcher にする。一次スコアだけは primaryOnlyConfig(cfg) を渡す。リランクの有無は cfg.rerank に従う */
export function makeSearcher(cfgX: Config, deps: { os: OpenSearchClient; embedder: Embedder }): Searcher {
  const search = makeSessionSearcher(cfgX, deps);
  return async (q, asOf) => {
    const results = await search({ query: q.query, ...q.filters, limit: 10 }, asOf);
    return results.map((r) => r.id);
  };
}

/** memories_dir を走査して id → created_at・supersedes */
export async function loadMemoryInfo(cfg: Config): Promise<Map<string, MemoryInfo>> {
  const { memories } = await scanMemories(cfg);
  const out = new Map<string, MemoryInfo>();
  for (const m of memories) {
    out.set(m.id, m.supersedes ? { created_at: m.created_at, supersedes: m.supersedes } : { created_at: m.created_at });
  }
  return out;
}

/** cli から使う依存一式 */
export function evalDeps(cfg: Config, deps: { os: OpenSearchClient; embedder: Embedder }): EvalCommandDeps {
  return {
    production: makeSearcher(cfg, deps),
    primary: makeSearcher(primaryOnlyConfig(cfg), deps),
    loadMemories: () => loadMemoryInfo(cfg),
  };
}
