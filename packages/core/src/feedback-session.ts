import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addHumanLabels, questionKey, readEvalSet, writeEvalSet } from "./evalset.ts";
import type { EvalFilters, EvalQuestion } from "./evalset.ts";
import type { Provenance } from "./frontmatter.ts";
import { interleaveOutcome, teamDraft, topDiffers } from "./interleave.ts";
import type { Team } from "./interleave.ts";
import type { Grades } from "./metrics.ts";
import type { AsOf, SearchInput, SearchResult } from "./search.ts";
import type { SearchLogEntry } from "./stats.ts";

export type FeedbackCard = {
  id: string;
  title: string;
  excerpt: string;
  created_at: string;
  provenance: Provenance;
  scope: string;
  stale: boolean;
  age_days: number;
};
/** cards と teams は同じ順・同じ長さ */
export type FeedbackItem = {
  qid: string;
  query: string;
  asked_at: string;
  kind: "real" | "synthetic";
  filters?: EvalFilters;
  differs: boolean;
  cards: FeedbackCard[];
  teams: Team[];
};
export type DraftEntry = { grades: Record<string, 0 | 1 | 2>; stale_ids: string[] };
/** qid → 判定 */
export type Draft = Record<string, DraftEntry>;
export type FeedbackSession = {
  id: string;
  token: string;
  created_at: string;
  seed: number;
  status: "open" | "confirmed";
  items: FeedbackItem[];
  draft: Draft;
  confirmed_at?: string;
  /** a = 本番の設定、b = 一次スコアだけ */
  outcomes?: Record<string, "a" | "b" | "tie">;
};
export type SessionSearcher = (input: SearchInput, asOf: AsOf) => Promise<SearchResult[]>;
export type SessionOpResult = { status: "ok" | "not_found" | "forbidden" | "closed"; written?: number };

/** <evalDir>/sessions/<id>.json */
export const SESSIONS_DIR = "sessions";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEARCH_LIMIT = 10;
const DEFAULT_QUESTIONS = 10;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function defaultId(now: Date): string {
  const ts =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `fb-${ts}-${randomBytes(3).toString("hex")}`;
}

function defaultToken(): string {
  return randomBytes(24).toString("base64url");
}

function sessionFile(dir: string, id: string): string {
  return join(dir, SESSIONS_DIR, `${id}.json`);
}

async function writeSession(dir: string, s: FeedbackSession): Promise<void> {
  await mkdir(join(dir, SESSIONS_DIR), { recursive: true });
  const file = sessionFile(dir, s.id);
  // 同じセッションを並んで書いても一時ファイルがぶつからないように、名前に乱数を入れる
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

/** ログの filters から scope・kind・tags だけを取る (limit は落とす)。空なら undefined */
function logFilters(f: SearchLogEntry["filters"]): EvalFilters | undefined {
  const out: EvalFilters = {};
  if (f.scope !== undefined) out.scope = f.scope;
  if (f.kind !== undefined) out.kind = f.kind;
  if (f.tags !== undefined) out.tags = [...f.tags];
  return Object.keys(out).length > 0 ? out : undefined;
}

function toCard(r: SearchResult): FeedbackCard {
  return {
    id: r.id,
    title: r.title,
    excerpt: r.excerpt,
    created_at: r.created_at,
    provenance: r.provenance,
    scope: r.scope,
    stale: r.freshness.stale,
    age_days: r.freshness.age_days,
  };
}

type Candidate = {
  qid?: string;
  query: string;
  asked_at: string;
  kind: "real" | "synthetic";
  filters?: EvalFilters;
};
type Measured = Candidate & { differs: boolean; a: SearchResult[]; b: SearchResult[]; t: number };

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** 上位が違うものを先に、同じ組の中では新しい問いを先に (安定) */
function byPriority(x: Measured, y: Measured): number {
  if (x.differs !== y.differs) return x.differs ? -1 : 1;
  return y.t - x.t;
}

/**
 * その週の実クエリ (logs) と評価セットから問いを選び、本番 (a) と一次スコアだけ (b) の順位を
 * 問われた時点で測り直して team-draft で混ぜ、`<dir>/sessions/<id>.json` に保存する
 */
export async function createFeedbackSession(args: {
  dir: string;
  questions: EvalQuestion[];
  logs: SearchLogEntry[];
  production: SessionSearcher;
  primary: SessionSearcher;
  supersededAt: ReadonlyMap<string, string>;
  now: Date;
  seed?: number;
  limit?: number;
  newId?: () => string;
  newToken?: () => string;
}): Promise<FeedbackSession> {
  const limit =
    args.limit !== undefined && Number.isFinite(args.limit) ? Math.max(0, Math.floor(args.limit)) : DEFAULT_QUESTIONS;
  const seed =
    args.seed !== undefined && Number.isFinite(args.seed) && Math.floor(args.seed) >= 1
      ? Math.floor(args.seed)
      : randomInt(1, 2147483646);

  const evalByKey = new Map<string, EvalQuestion>();
  for (const q of args.questions) {
    const k = questionKey(q.query, q.filters);
    if (!evalByKey.has(k)) evalByKey.set(k, q);
  }

  // 同じ問いのログは最新の 1 つにまとめる
  const latest = new Map<string, SearchLogEntry>();
  for (const l of args.logs) {
    const k = questionKey(l.query, logFilters(l.filters));
    const cur = latest.get(k);
    if (cur === undefined || timeOf(l.at) > timeOf(cur.at)) latest.set(k, l);
  }

  const measure = async (c: Candidate): Promise<Measured> => {
    const input: SearchInput = { query: c.query, ...(c.filters ?? {}), limit: SEARCH_LIMIT };
    const asOf: AsOf = { at: new Date(c.asked_at), supersededAt: args.supersededAt };
    const a = await args.production(input, asOf);
    const b = await args.primary(input, asOf);
    const differs = topDiffers(a.map((r) => r.id), b.map((r) => r.id), SEARCH_LIMIT);
    return { ...c, differs, a, b, t: timeOf(c.asked_at) };
  };

  const real: Measured[] = [];
  for (const [k, l] of latest) {
    const c: Candidate = { query: l.query, asked_at: l.at, kind: "real" };
    const f = logFilters(l.filters);
    if (f !== undefined) c.filters = f;
    const ev = evalByKey.get(k);
    if (ev !== undefined) c.qid = ev.qid;
    real.push(await measure(c));
  }
  real.sort(byPriority);
  const chosen: Measured[] = real.slice(0, limit);

  // 実クエリが足りなければ、評価セットのうち人のラベルが無い問いで埋める
  if (chosen.length < limit) {
    const used = new Set(latest.keys());
    const fill: Measured[] = [];
    for (const q of args.questions) {
      const k = questionKey(q.query, q.filters);
      if (used.has(k)) continue;
      used.add(k);
      if (q.labels.some((l) => l.source === "human")) continue;
      const c: Candidate = { qid: q.qid, query: q.query, asked_at: q.asked_at, kind: q.kind };
      if (q.filters !== undefined) c.filters = q.filters;
      fill.push(await measure(c));
    }
    fill.sort(byPriority);
    chosen.push(...fill.slice(0, limit - chosen.length));
  }

  // qid はセッションの中で一意にする (評価セットに無い実クエリには r-<番号> を振る)
  const qids = new Set<string>();
  let seq = 0;
  const items: FeedbackItem[] = chosen.map((m, i) => {
    let qid = m.qid;
    if (qid === undefined || qids.has(qid)) {
      do {
        seq++;
        qid = `r-${pad(seq, 2)}`;
      } while (qids.has(qid) || evalQidTaken(args.questions, qid));
    }
    qids.add(qid);
    const il = teamDraft(m.a.map((r) => r.id), m.b.map((r) => r.id), seed + i, SEARCH_LIMIT);
    const byId = new Map<string, SearchResult>();
    for (const r of m.b) byId.set(r.id, r);
    for (const r of m.a) byId.set(r.id, r);
    const item: FeedbackItem = {
      qid,
      query: m.query,
      asked_at: m.asked_at,
      kind: m.kind,
      differs: m.differs,
      cards: il.ids.map((id) => toCard(byId.get(id)!)),
      teams: il.teams,
    };
    if (m.filters !== undefined) item.filters = m.filters;
    return item;
  });

  const session: FeedbackSession = {
    id: (args.newId ?? (() => defaultId(args.now)))(),
    token: (args.newToken ?? defaultToken)(),
    created_at: args.now.toISOString(),
    seed,
    status: "open",
    items,
    draft: {},
  };
  if (!ID_RE.test(session.id)) throw new Error(`セッションの id が不正です: ${session.id}`);
  await writeSession(args.dir, session);
  return session;
}

function evalQidTaken(qs: EvalQuestion[], qid: string): boolean {
  return qs.some((q) => q.qid === qid);
}

/** `<dir>/sessions/<id>.json` を読む。id の形が不正、またはファイルが無ければ undefined */
export async function loadSession(dir: string, id: string): Promise<FeedbackSession | undefined> {
  if (!ID_RE.test(id)) return undefined;
  let text: string;
  try {
    text = await readFile(sessionFile(dir, id), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return JSON.parse(text) as FeedbackSession;
}

function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** セッションを開き、合言葉と状態を確かめる */
async function openForWrite(
  dir: string,
  id: string,
  token: string,
): Promise<{ session: FeedbackSession } | { result: SessionOpResult }> {
  const s = await loadSession(dir, id);
  if (s === undefined) return { result: { status: "not_found" } };
  if (typeof token !== "string" || !tokenMatches(s.token, token)) return { result: { status: "forbidden" } };
  if (s.status === "confirmed") return { result: { status: "closed" } };
  return { session: s };
}

/** セッションにある qid だけを残し、等級は 0・1・2、stale_ids は文字列だけにする */
function cleanDraft(s: FeedbackSession, draft: Draft): Draft {
  const out: Draft = {};
  const known = new Set(s.items.map((it) => it.qid));
  if (typeof draft !== "object" || draft === null) return out;
  for (const [qid, e] of Object.entries(draft)) {
    if (!known.has(qid) || typeof e !== "object" || e === null) continue;
    const grades: Record<string, 0 | 1 | 2> = {};
    if (typeof e.grades === "object" && e.grades !== null) {
      for (const [mid, g] of Object.entries(e.grades)) if (g === 0 || g === 1 || g === 2) grades[mid] = g;
    }
    const stale_ids = Array.isArray(e.stale_ids) ? [...new Set(e.stale_ids.filter((x) => typeof x === "string"))] : [];
    out[qid] = { grades, stale_ids };
  }
  return out;
}

/** 評価のディレクトリ → そこへの読み書きの列の末尾 */
const writeQueues = new Map<string, Promise<unknown>>();

/**
 * 同じ評価のディレクトリへの読み書き (下書きの保存と確定) を、このプロセスの中で 1 つずつ流す。
 * 確定のあとに古い下書きの保存がセッションを open に戻したり、2 つの確定が評価セットの
 * ラベルを取りこぼしたりしないようにする。画面の道はすべて MCP サーバーの 1 プロセスで動く
 */
function serialized<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  writeQueues.set(key, tail);
  // 列が空になったら消す (長く動くサーバーで Map が育たないように)
  void tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return next;
}

/** 下書きを保存する */
export function saveDraft(dir: string, id: string, token: string, draft: Draft): Promise<SessionOpResult> {
  return serialized(dir, async () => {
    const r = await openForWrite(dir, id, token);
    if ("result" in r) return r.result;
    const s = r.session;
    s.draft = cleanDraft(s, draft);
    await writeSession(dir, s);
    return { status: "ok" };
  });
}

function hasJudgment(e: DraftEntry | undefined): e is DraftEntry {
  return e !== undefined && (Object.keys(e.grades).length > 0 || e.stale_ids.length > 0);
}

/**
 * 確定する。判定のある問いだけ評価セットに人のラベルを書き (relevant は等級 1 以上)、
 * outcomes に勝ち負けを記録する (上位 10 件が同じ問いは "tie")。written は書いた問いの数
 */
export function confirmSession(dir: string, id: string, token: string, draft?: Draft): Promise<SessionOpResult> {
  return serialized(dir, () => confirmNow(dir, id, token, draft));
}

async function confirmNow(dir: string, id: string, token: string, draft?: Draft): Promise<SessionOpResult> {
  const r = await openForWrite(dir, id, token);
  if ("result" in r) return r.result;
  const s = r.session;
  const d = cleanDraft(s, draft ?? s.draft);
  const at = new Date().toISOString();

  const labels: Parameters<typeof addHumanLabels>[1] = [];
  const outcomes: Record<string, "a" | "b" | "tie"> = {};
  for (const it of s.items) {
    const e = d[it.qid];
    if (!hasJudgment(e)) continue;
    const relevant: Grades = {};
    for (const [mid, g] of Object.entries(e.grades)) if (g >= 1) relevant[mid] = g;
    const label: (typeof labels)[number] = {
      query: it.query,
      asked_at: it.asked_at,
      kind: it.kind,
      relevant,
      stale_ids: [...e.stale_ids],
    };
    if (it.filters !== undefined) label.filters = it.filters;
    labels.push(label);
    outcomes[it.qid] = it.differs
      ? interleaveOutcome({ ids: it.cards.map((c) => c.id), teams: it.teams }, e.grades)
      : "tie";
  }

  if (labels.length > 0) {
    const qs = await readEvalSet(dir);
    await writeEvalSet(dir, addHumanLabels(qs, labels, s.id, at));
  }
  s.draft = d;
  s.status = "confirmed";
  s.confirmed_at = at;
  s.outcomes = outcomes;
  await writeSession(dir, s);
  return { status: "ok", written: labels.length };
}

/** 画面に渡す形。token と各 item の teams を除く */
export function publicView(
  s: FeedbackSession,
): Omit<FeedbackSession, "token" | "items"> & { items: Omit<FeedbackItem, "teams">[] } {
  const { token: _token, items, ...rest } = s;
  return {
    ...rest,
    items: items.map(({ teams: _teams, ...it }) => it),
  };
}

/** 確定したセッションの outcomes を数える。wins = a (本番の設定) の勝ち */
export async function interleaveTotals(
  dir: string,
): Promise<{ wins: number; losses: number; ties: number; sessions: number }> {
  const out = { wins: 0, losses: 0, ties: 0, sessions: 0 };
  let names: string[];
  try {
    names = await readdir(join(dir, SESSIONS_DIR));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const s = await loadSession(dir, name.slice(0, -".json".length));
    if (s === undefined || s.status !== "confirmed") continue;
    out.sessions++;
    for (const o of Object.values(s.outcomes ?? {})) {
      if (o === "a") out.wins++;
      else if (o === "b") out.losses++;
      else if (o === "tie") out.ties++;
    }
  }
  return out;
}
