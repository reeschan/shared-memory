import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  loadConfig,
  createEmbedder,
  createReranker,
  OpenSearchClient,
  StatsStore,
  LOG_RETENTION_DAYS,
  checkEmbeddingCompat,
  ensureSetup,
  indexIncremental,
  reindexAll,
  runDecay,
  runGc,
  searchMemories,
  parseImportJsonl,
  planImport,
  commitImport,
  SOURCE_AGENTS,
  type Config,
  type Deps,
  type IndexReport,
  type SourceAgent,
} from "@shared-memory/core";
import { evalDeps, importLabCommand, runEvalCommand } from "./eval-command.ts";
import { feedbackDeps, runFeedbackCommand } from "./feedback-command.ts";
import { evalNotice, notify, openUrl } from "./notify.ts";

type Args = {
  positionals: string[];
  json: boolean;
  keepOld: boolean;
  scope?: string;
  limit?: number;
  dryRun: boolean;
  sourceAgent?: string;
  notify: boolean;
  days?: number;
};

type Command = {
  usage: string;
  /** 数値を返したときはそれを終了コードにする */
  run: (cfg: Config, deps: Deps, args: Args) => Promise<number | void>;
};

class UsageError extends Error {}

/** 結果を出力する。--json のときは標準出力に JSON だけを出す */
function emit(json: boolean, data: unknown, text: string): void {
  console.log(json ? JSON.stringify(data, null, 2) : text);
}

function summary(r: IndexReport): string {
  return `走査 ${r.scanned} 件 / 埋め込み ${r.embedded} (キャッシュ ${r.cached}) / 投入 ${r.upserted} / 更新 ${r.updated} / 削除 ${r.deleted}`;
}

function invalidLines(r: IndexReport): string[] {
  return r.invalid.map((i) => `不正なメモリをスキップ: ${i.path}\n  ${i.errors.join("\n  ")}`);
}

const COMMANDS: Record<string, Command> = {
  setup: {
    usage: "setup                       エイリアス・インデックス・検索パイプラインを用意する",
    run: async (cfg, deps, args) => {
      const r = await ensureSetup(cfg, deps.os);
      const text = r.createdIndex
        ? `セットアップ完了 (インデックス ${r.createdIndex} を作成)`
        : "セットアップ完了 (既存のエイリアスを使用)";
      emit(args.json, r, text);
    },
  },
  index: {
    usage: "index                         メモリを差分インデックスに反映する",
    run: async (cfg, deps, args) => {
      await ensureSetup(cfg, deps.os);
      const r = await indexIncremental(cfg, deps);
      emit(args.json, r, [summary(r), ...invalidLines(r)].join("\n"));
    },
  },
  reindex: {
    usage: "reindex [--keep-old]         新しいインデックスを作って全件入れ直し、エイリアスを切り替える",
    run: async (cfg, deps, args) => {
      const r = await reindexAll(cfg, deps, { keepOld: args.keepOld });
      emit(args.json, r, [`再構築 → ${r.index}`, summary(r), ...invalidLines(r)].join("\n"));
    },
  },
  decay: {
    usage: "decay                         最終アクセス日から tier を再計算する (1 日 1 回)",
    run: async (cfg, deps, args) => {
      const r = await runDecay(cfg, { os: deps.os, stats: deps.stats });
      const lines = [`メモリ ${r.total} 件 / tier 変更 ${r.changed.length} 件`];
      for (const c of r.changed) lines.push(`  ${c.memory_id}: ${c.from} → ${c.to}`);
      const before = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const pruned = deps.stats.pruneLogs(before);
      lines.push(`ログ削除: 検索 ${pruned.searches} 件 / get ${pruned.gets} 件`);
      emit(args.json, { ...r, pruned }, lines.join("\n"));
    },
  },
  gc: {
    usage: "gc                            置き換え済みメモリを archive に送り、symbol_ref の参照切れを一覧する (週 1 回)",
    run: async (cfg, deps, args) => {
      const r = await runGc(cfg, { os: deps.os, stats: deps.stats });
      const lines = [`archive に送った件数: ${r.archived.length}`];
      for (const id of r.archived) lines.push(`  ${id}`);
      lines.push(`symbol_ref の参照切れ: ${r.brokenSymbolRefs.length} 件`);
      for (const b of r.brokenSymbolRefs) lines.push(`  ${b.memory_id} ${b.symbol_ref} (${b.reason})`);
      emit(args.json, r, lines.join("\n"));
    },
  },
  import: {
    usage: "import <file.jsonl> [--dry-run] [--source-agent <a>]  JSONL のメモリをまとめて作成し、インデックスを 1 回だけ更新する",
    run: async (cfg, deps, args) => {
      const file = args.positionals[0];
      if (file === undefined || args.positionals.length > 1) {
        throw new UsageError("JSONL ファイルを 1 つ指定してください");
      }
      if (args.sourceAgent !== undefined && !(SOURCE_AGENTS as readonly string[]).includes(args.sourceAgent)) {
        throw new UsageError(`--source-agent は ${SOURCE_AGENTS.join(" / ")} のどれかにしてください: ${args.sourceAgent}`);
      }
      const text = await readFile(file, "utf8");
      const parsed = parseImportJsonl(text, { source_agent: args.sourceAgent as SourceAgent | undefined });
      const plan = await planImport(cfg, parsed.inputs);
      const errors = [...parsed.errors, ...plan.errors].sort((a, b) => a.line - b.line);
      const entries = plan.ok.map((p) => ({
        line: p.line,
        action: p.meta.supersedes === undefined ? "new" : "supersede",
        meta: p.meta,
      }));
      const nNew = entries.filter((e) => e.action === "new").length;
      const lines = [`新規 ${nNew} / 置き換え ${entries.length - nNew} / エラー ${errors.length}`];
      const rows: { line: number; text: string }[] = [
        ...entries.map((e) => ({
          line: e.line,
          text:
            e.action === "new"
              ? `  [新規] L${e.line} ${e.meta.title}`
              : `  [置き換え] L${e.line} ${e.meta.title} (→ ${e.meta.supersedes})`,
        })),
        ...errors.map((e) => ({ line: e.line, text: `  [エラー] L${e.line} ${e.errors.join("; ")}` })),
      ];
      rows.sort((a, b) => a.line - b.line);
      lines.push(...rows.map((r) => r.text));
      const planData = { ok: entries, errors };

      if (errors.length > 0 || args.dryRun) {
        if (errors.length > 0) lines.push("エラーがあるため書き込みませんでした");
        else lines.push("--dry-run のため書き込みませんでした");
        emit(args.json, { dry_run: args.dryRun, written: false, plan: planData }, lines.join("\n"));
        return errors.length > 0 ? 1 : 0;
      }

      await ensureSetup(cfg, deps.os);
      const r = await commitImport(cfg, deps, plan);
      lines.push(`作成 ${r.created.length} 件`);
      for (const c of r.created) lines.push(`  ${c.path}`);
      lines.push(summary(r.report), ...invalidLines(r.report));
      emit(args.json, { dry_run: false, written: true, plan: planData, ...r }, lines.join("\n"));
    },
  },
  search: {
    usage: "search <query> [--scope s] [--limit n]  メモリを検索する",
    run: async (cfg, deps, args) => {
      const query = args.positionals.join(" ").trim();
      if (query === "") throw new UsageError("検索語を指定してください");
      // 検索は指紋の不一致でも止めず、警告だけにする
      try {
        const compat = await checkEmbeddingCompat(cfg, deps.os);
        if (!compat.ok) {
          console.error(
            `警告: インデックス ${compat.index} の埋め込みの指紋 (${compat.indexFingerprint}) が設定 (${compat.expected}) と一致しません。pnpm sm reindex を実行してください`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`警告: 埋め込みの指紋を確認できませんでした: ${msg}`);
      }
      const results = await searchMemories(
        cfg,
        { os: deps.os, embedder: deps.embedder, reranker: createReranker(cfg.rerank), log: (msg) => console.error(msg) },
        {
          query,
          scope: args.scope,
          limit: args.limit,
        },
      );
      try {
        deps.stats.logSearch({
          at: new Date().toISOString(),
          source: "cli",
          query,
          filters: { scope: args.scope, limit: args.limit },
          results: results.map((r, i) => ({ id: r.id, rank: i + 1, score: r.score })),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`警告: 検索ログを記録できませんでした: ${msg}`);
      }
      const text =
        results.length === 0
          ? "該当なし"
          : results
              .map((r, i) => {
                const stale = r.freshness.stale ? ` [古い記憶: ${r.freshness.age_days} 日前]` : "";
                const created = r.created_at.slice(0, 10);
                return `${i + 1}. ${r.title} [${r.id}] (${r.scope}, score ${r.score.toFixed(3)}, ${created} 作成)${stale}\n   ${r.excerpt}`;
              })
              .join("\n");
      emit(args.json, results, text);
    },
  },
  eval: {
    usage:
      "eval [--notify] | eval import-lab <file.jsonl>  評価セットを本番と一次スコアだけで測り、レポートと履歴を残す (--notify で要約をトーストで知らせる) / lab の評価セットを取り込む",
    run: async (cfg, deps, args) => {
      const [sub, ...rest] = args.positionals;
      if (sub === undefined) {
        const r = await runEvalCommand(cfg, evalDeps(cfg, deps), { json: args.json });
        if (args.notify && r.run !== undefined) {
          const ok = await notify(evalNotice(r.run));
          if (!ok) console.error("トーストで知らせられませんでした (要約は上の出力を見てください)");
        }
        return r.code;
      }
      if (sub === "import-lab") {
        if (rest.length !== 1) throw new UsageError("lab の評価セットの JSONL ファイルを 1 つ指定してください");
        const r = await importLabCommand(cfg, rest[0]!, { json: args.json });
        return r.code;
      }
      throw new UsageError(`eval のサブコマンドが不明です: ${sub}`);
    },
  },
  feedback: {
    usage:
      "feedback [--notify] [--days <n>]  過去 n 日 (既定 7) の検索から判定の画面を作り、ブラウザーで開く (--notify ならトーストで知らせる)",
    run: async (cfg, deps, args) => {
      if (args.positionals.length > 0) throw new UsageError("feedback は引数を取りません");
      const r = await runFeedbackCommand(cfg, feedbackDeps(cfg, deps), { days: args.days });
      if (r.status === "empty") {
        emit(args.json, { status: "empty", message: r.message }, r.message);
        return 0;
      }
      const n = r.session.items.length;
      const base = { status: "created", session_id: r.session.id, questions: n };
      if (args.notify) {
        const ok = await notify({
          title: "shared-memory: 今週の検索の判定",
          body: `今週の検索結果が役に立ったか、${n} 問の判定をお願いします (約 ${Math.max(1, Math.round(n / 2))} 分)。クリックで画面を開きます`,
          url: r.url,
        });
        // 定期タスクは標準出力をログに残すので、知らせられたときは URL (合言葉入り) を出さない
        if (ok) {
          emit(args.json, { ...base, notified: true }, `トーストで知らせました (セッション ${r.session.id}、問い ${n} 件)`);
          return 0;
        }
        emit(args.json, { ...base, notified: false, url: r.url }, `セッション ${r.session.id} (問い ${n} 件): ${r.url}`);
        return 0;
      }
      const opened = await openUrl(r.url);
      const note = opened ? "ブラウザーで開きます" : "ブラウザーを開けませんでした。次の URL を開いてください";
      emit(args.json, { ...base, opened, url: r.url }, `セッション ${r.session.id} (問い ${n} 件)。${note}\n${r.url}`);
      return 0;
    },
  },
};

function parseDays(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--days は 1 以上の整数にしてください: ${v}`);
  return n;
}

function usage(): string {
  const lines = Object.values(COMMANDS).map((c) => `  pnpm sm ${c.usage}`);
  return ["使い方:", ...lines, "  共通オプション: --json (結果を JSON で出力)"].join("\n");
}

function parseLimit(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--limit は 1 以上の整数にしてください: ${v}`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        "keep-old": { type: "boolean", default: false },
        scope: { type: "string" },
        limit: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "source-agent": { type: "string" },
        notify: { type: "boolean", default: false },
        days: { type: "string" },
      },
    });
  } catch (e) {
    console.error((e as Error).message);
    console.error(usage());
    return 1;
  }

  const [name, ...rest] = parsed.positionals;
  if (name === undefined || !Object.hasOwn(COMMANDS, name)) {
    console.error(usage());
    return 1;
  }
  const command = COMMANDS[name]!;
  const json = parsed.values.json === true;

  let stats: StatsStore | undefined;
  try {
    const args: Args = {
      positionals: rest,
      json,
      keepOld: parsed.values["keep-old"] === true,
      scope: parsed.values.scope,
      limit: parseLimit(parsed.values.limit),
      dryRun: parsed.values["dry-run"] === true,
      sourceAgent: parsed.values["source-agent"],
      notify: parsed.values.notify === true,
      days: parseDays(parsed.values.days),
    };
    const cfg = loadConfig();
    stats = new StatsStore(cfg.state_db);
    const deps: Deps = {
      os: new OpenSearchClient(cfg.opensearch.url),
      embedder: createEmbedder(cfg.embedding, cfg.cache_dir),
      stats,
    };
    return (await command.run(cfg, deps, args)) ?? 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (json) console.log(JSON.stringify({ error: msg }, null, 2));
    else console.error(`エラー: ${msg}`);
    if (e instanceof UsageError) console.error(usage());
    return 1;
  } finally {
    stats?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
