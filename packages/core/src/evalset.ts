import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import type { Kind } from "./frontmatter.ts";
import type { Grades } from "./metrics.ts";

export type LabelSource = "agent" | "human";
export type EvalFilters = { scope?: string; kind?: Kind; tags?: string[] };
export type EvalLabel = {
  source: LabelSource;
  /** ISO */
  labeled_at: string;
  /** human のときだけ */
  session_id?: string;
  /** memory_id → 2 | 1 (0 は入れない) */
  relevant: Grades;
  /** 「新しい版があり、これは古い」と付けた id */
  stale_ids?: string[];
};
export type EvalQuestion = {
  qid: string;
  query: string;
  /** 問われた時点 (ISO) */
  asked_at: string;
  kind: "synthetic" | "real";
  filters?: EvalFilters;
  freshness_sensitive?: boolean;
  /** 古い順 */
  labels: EvalLabel[];
};

export const EVAL_SET_FILE = "eval-set.jsonl";

const DEFAULT_LAB_ASKED_AT = "2026-10-17T00:00:00.000Z";

/** 評価のディレクトリ。cfg.eval.dir が空でなければそれ (絶対パス)、空なら memories_dir の隣の eval/ */
export function evalDir(cfg: Config): string {
  return cfg.eval.dir !== "" ? cfg.eval.dir : join(dirname(cfg.memories_dir), "eval");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkQuestion(v: unknown): string | undefined {
  if (!isObj(v)) return "1 問がオブジェクトではありません";
  if (typeof v.qid !== "string" || v.qid === "") return "qid がありません";
  if (typeof v.query !== "string") return "query がありません";
  if (typeof v.asked_at !== "string") return "asked_at がありません";
  if (v.kind !== "synthetic" && v.kind !== "real") return "kind は synthetic か real にしてください";
  if (!Array.isArray(v.labels)) return "labels が配列ではありません";
  for (const l of v.labels) {
    if (!isObj(l)) return "labels の要素がオブジェクトではありません";
    if (l.source !== "agent" && l.source !== "human") return "labels[].source は agent か human にしてください";
    if (typeof l.labeled_at !== "string") return "labels[].labeled_at がありません";
    if (!isObj(l.relevant)) return "labels[].relevant がマップではありません";
  }
  return undefined;
}

/** `<dir>/eval-set.jsonl` を読む。無ければ []。空行は無視し、壊れた行は行番号入りの Error */
export async function readEvalSet(dir: string): Promise<EvalQuestion[]> {
  const file = join(dir, EVAL_SET_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: EvalQuestion[] = [];
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
    const why = checkQuestion(v);
    if (why !== undefined) throw new Error(`${file}: ${i + 1} 行目: ${why}`);
    out.push(v as EvalQuestion);
  }
  return out;
}

/** 1 行 1 問で書く (末尾に改行)。一時ファイルに書いてから rename する。dir が無ければ作る */
export async function writeEvalSet(dir: string, qs: EvalQuestion[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, EVAL_SET_FILE);
  const tmp = `${file}.tmp`;
  const body = qs.map((q) => JSON.stringify(q) + "\n").join("");
  await writeFile(tmp, body, "utf8");
  await rename(tmp, file);
}

/** 最新の human のラベル。無ければ最新の agent のラベル */
export function effectiveLabel(q: EvalQuestion): EvalLabel | undefined {
  let agent: EvalLabel | undefined;
  for (let i = q.labels.length - 1; i >= 0; i--) {
    const l = q.labels[i]!;
    if (l.source === "human") return l;
    if (agent === undefined && l.source === "agent") agent = l;
  }
  return agent;
}

function normalizeFilters(f?: EvalFilters): EvalFilters {
  const out: EvalFilters = {};
  if (f === undefined) return out;
  if (f.scope !== undefined && f.scope !== "") out.scope = f.scope;
  if (f.kind !== undefined) out.kind = f.kind;
  if (f.tags !== undefined && f.tags.length > 0) out.tags = [...new Set(f.tags)].sort();
  return out;
}

/** 同じ問いかを見分けるキー。query は前後の空白を除き、連続空白を 1 つにし、小文字にする。filters は正規化した JSON */
export function questionKey(query: string, filters?: EvalFilters): string {
  const q = query.trim().replace(/\s+/g, " ").toLowerCase();
  return `${q}\n${JSON.stringify(normalizeFilters(filters))}`;
}

/** 0 以下の段階を落とした relevant */
function positiveGrades(g: Grades): Grades {
  const out: Grades = {};
  for (const [id, v] of Object.entries(g)) if (typeof v === "number" && v > 0) out[id] = v;
  return out;
}

/** lab の評価セット ({qid,set,query,relevant} の JSONL) を、agent のラベルの EvalQuestion にする */
export function fromLabEvalJsonl(text: string, askedAt: string = DEFAULT_LAB_ASKED_AT): EvalQuestion[] {
  const out: EvalQuestion[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch (e) {
      throw new Error(`lab の評価セット: ${i + 1} 行目が JSON として読めません (${(e as Error).message})`);
    }
    if (
      !isObj(v) || typeof v.qid !== "string" || typeof v.query !== "string" || !isObj(v.relevant) ||
      (v.set !== "synthetic" && v.set !== "real")
    ) {
      throw new Error(`lab の評価セット: ${i + 1} 行目は {qid, set (synthetic|real), query, relevant} にしてください`);
    }
    out.push({
      qid: v.qid,
      query: v.query,
      asked_at: askedAt,
      kind: v.set,
      labels: [{ source: "agent", labeled_at: askedAt, relevant: positiveGrades(v.relevant as Grades) }],
    });
  }
  return out;
}

/**
 * 人のラベルを足した新しい配列を返す (元の配列と問いは変えない)。
 * questionKey が同じ問いがあればそこに label を足し、無ければ qid "h-<連番 4 桁>" の新しい問いを足す
 */
export function addHumanLabels(
  qs: EvalQuestion[],
  items: {
    query: string;
    asked_at: string;
    kind: "synthetic" | "real";
    filters?: EvalFilters;
    relevant: Grades;
    stale_ids: string[];
  }[],
  sessionId: string,
  at: string,
): EvalQuestion[] {
  const out = qs.map((q) => ({ ...q, labels: [...q.labels] }));
  const byKey = new Map<string, EvalQuestion>();
  for (const q of out) {
    const k = questionKey(q.query, q.filters);
    if (!byKey.has(k)) byKey.set(k, q);
  }
  let seq = 0;
  for (const q of out) {
    const m = /^h-(\d+)$/.exec(q.qid);
    if (m) seq = Math.max(seq, Number(m[1]));
  }
  for (const it of items) {
    const label: EvalLabel = {
      source: "human",
      labeled_at: at,
      session_id: sessionId,
      relevant: positiveGrades(it.relevant),
      stale_ids: [...it.stale_ids],
    };
    const k = questionKey(it.query, it.filters);
    const found = byKey.get(k);
    if (found) {
      found.labels.push(label);
      continue;
    }
    seq++;
    const q: EvalQuestion = {
      qid: `h-${String(seq).padStart(4, "0")}`,
      query: it.query,
      asked_at: it.asked_at,
      kind: it.kind,
      labels: [label],
    };
    if (it.filters !== undefined) q.filters = it.filters;
    out.push(q);
    byKey.set(k, q);
  }
  return out;
}
