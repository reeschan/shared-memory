// `sm feedback` の処理。CLI のプロセスを起動せずにテストできるよう、cfg と依存 (検索の関数・ログの読み出し・
// 置き換えの時点) を受け取る関数にしてある。
// フィードバックはアクセスもログも書かない (searchMemories を直接呼び、StatsStore は readLogs だけを使う)。
import {
  createFeedbackSession,
  evalDir,
  primaryOnlyConfig,
  readEvalSet,
  scanMemories,
  supersededAtMap,
  type Config,
  type Embedder,
  type FeedbackSession,
  type OpenSearchClient,
  type SearchLogEntry,
  type SessionSearcher,
  type StatsStore,
} from "@shared-memory/core";
import { makeSessionSearcher } from "./eval-command.ts";

export const DEFAULT_FEEDBACK_DAYS = 7;
export const NO_QUESTIONS_MESSAGE = "今週は判定する問いがありません";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FeedbackCommandDeps = {
  production: SessionSearcher;
  primary: SessionSearcher;
  /** 検索ログを読むだけ (StatsStore をそのまま渡せる) */
  stats: Pick<StatsStore, "readLogs">;
  /** 置き換えられた memory_id → 置き換えた側の created_at */
  loadSupersededAt: () => Promise<ReadonlyMap<string, string>>;
  now?: Date;
  seed?: number;
  newId?: () => string;
  newToken?: () => string;
};

export type FeedbackCommandResult =
  | { status: "created"; session: FeedbackSession; url: string }
  | { status: "empty"; message: string };

/** 画面の URL。合言葉が入るのでログには書かない */
export function feedbackUrl(cfg: Config, s: Pick<FeedbackSession, "id" | "token">): string {
  return `http://${cfg.mcp.host}:${cfg.mcp.port}/feedback/${encodeURIComponent(s.id)}?t=${encodeURIComponent(s.token)}`;
}

/** 過去 days 日の source "mcp" の検索ログ */
export function recentMcpSearches(
  stats: Pick<StatsStore, "readLogs">,
  now: Date,
  days: number,
): SearchLogEntry[] {
  const from = new Date(now.getTime() - days * DAY_MS).toISOString();
  const to = new Date(now.getTime() + 1).toISOString(); // now ちょうどのログも含める
  return stats.readLogs(from, to).searches.filter((s) => s.source === "mcp");
}

/**
 * `sm feedback`: 過去 days 日 (既定 7) の MCP の検索ログと評価セットから問いを選び、セッションを
 * `<evalDir>/sessions/` に作って画面の URL を返す。判定する問いが無ければセッションを作らない
 */
export async function runFeedbackCommand(
  cfg: Config,
  deps: FeedbackCommandDeps,
  opts: { days?: number } = {},
): Promise<FeedbackCommandResult> {
  const days = opts.days ?? DEFAULT_FEEDBACK_DAYS;
  if (!Number.isInteger(days) || days < 1) throw new Error(`days は 1 以上の整数にしてください: ${days}`);
  const now = deps.now ?? new Date();
  const dir = evalDir(cfg);
  const logs = recentMcpSearches(deps.stats, now, days);
  const questions = await readEvalSet(dir);
  // createFeedbackSession の材料は、ログの問いと、人のラベルが無い評価セットの問い
  const fillable = questions.some((q) => !q.labels.some((l) => l.source === "human"));
  if (logs.length === 0 && !fillable) return { status: "empty", message: NO_QUESTIONS_MESSAGE };

  const session = await createFeedbackSession({
    dir,
    questions,
    logs,
    production: deps.production,
    primary: deps.primary,
    supersededAt: await deps.loadSupersededAt(),
    now,
    ...(deps.seed !== undefined ? { seed: deps.seed } : {}),
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
    ...(deps.newToken !== undefined ? { newToken: deps.newToken } : {}),
  });
  return { status: "created", session, url: feedbackUrl(cfg, session) };
}

/** cli から使う依存一式 */
export function feedbackDeps(
  cfg: Config,
  deps: { os: OpenSearchClient; embedder: Embedder; stats: Pick<StatsStore, "readLogs"> },
): FeedbackCommandDeps {
  return {
    production: makeSessionSearcher(cfg, deps),
    primary: makeSessionSearcher(primaryOnlyConfig(cfg), deps),
    stats: deps.stats,
    loadSupersededAt: async () => supersededAtMap((await scanMemories(cfg)).memories),
  };
}
