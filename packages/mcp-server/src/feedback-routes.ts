// フィードバックの画面と、その下書き・確定の HTTP の道。MCP のツールにはしない。
// セッションを作る道は無い (CLI が core の createFeedbackSession でファイルを作る)。
// 検索もアクセスの記録もログも書かない (StatsStore を受け取らない)。
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  confirmSession,
  interleaveTotals,
  loadSession,
  publicView,
  readEvalSet,
  readHistory,
  saveDraft,
  signTest,
  type Draft,
  type SessionOpResult,
} from "@shared-memory/core";
import { readBody, sendJson } from "./app.ts";

export type FeedbackContext = { dir: string; staticDir: string };

const PREFIX = "/feedback/";
const STATIC_SEGMENT = "static";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HISTORY_LIMIT = 12;

/** 許可リスト。これ以外の名前は 404 */
const STATIC_FILES: ReadonlyMap<string, string> = new Map([
  ["feedback.html", "text/html; charset=utf-8"],
  ["feedback.css", "text/css; charset=utf-8"],
  ["feedback.js", "text/javascript; charset=utf-8"],
]);

const PAGE_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const NO_STORE = { "Cache-Control": "no-store" };

function sendError(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error }, { ...NO_STORE, ...headers });
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  sendError(res, 405, "method not allowed", { Allow: allow });
}

async function sendStatic(res: ServerResponse, ctx: FeedbackContext, name: string): Promise<void> {
  const type = STATIC_FILES.get(name);
  if (type === undefined) return sendError(res, 404, "not found");
  const body = await readFile(join(ctx.staticDir, name));
  const headers: Record<string, string> = {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...NO_STORE,
  };
  if (name === "feedback.html") headers["Content-Security-Policy"] = PAGE_CSP;
  res.writeHead(200, headers);
  res.end(body);
}

function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function sendData(res: ServerResponse, ctx: FeedbackContext, id: string, token: string): Promise<void> {
  const s = await loadSession(ctx.dir, id);
  if (s === undefined) return sendError(res, 404, "session not found");
  if (!tokenMatches(s.token, token)) return sendError(res, 403, "forbidden");

  const history = await readHistory(ctx.dir);
  const latest = history.at(-1);
  const totals = await interleaveTotals(ctx.dir);
  const questions = await readEvalSet(ctx.dir);
  const dashboard = {
    history: history.slice(-HISTORY_LIMIT),
    interleave: { ...totals, p: signTest(totals.wins, totals.losses) },
    created_dist: latest?.created_dist ?? null,
    eval_set: {
      questions: questions.length,
      human: questions.filter((q) => q.labels.some((l) => l.source === "human")).length,
    },
  };
  sendJson(res, 200, { session: publicView(s), dashboard }, NO_STORE);
}

function isJsonContentType(req: IncomingMessage): boolean {
  const ct = req.headers["content-type"];
  if (typeof ct !== "string") return false;
  return ct.split(";")[0]!.trim().toLowerCase() === "application/json";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 本文 `{ "draft": Draft }` を読む。応答を返したら undefined */
async function readDraftBody(
  req: IncomingMessage,
  res: ServerResponse,
  required: boolean,
): Promise<{ draft: Draft | undefined } | undefined> {
  if (!isJsonContentType(req)) {
    sendError(res, 415, "Content-Type must be application/json");
    return undefined;
  }
  const raw = await readBody(req);
  if (raw === null) {
    sendError(res, 413, "request body too large");
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, "body is not valid JSON");
    return undefined;
  }
  if (!isObject(body)) {
    sendError(res, 400, "body must be an object");
    return undefined;
  }
  const draft = body.draft;
  if (draft === undefined && !required) return { draft: undefined };
  if (!isObject(draft)) {
    sendError(res, 400, "draft must be an object");
    return undefined;
  }
  return { draft: draft as Draft };
}

function sendOpResult(res: ServerResponse, r: SessionOpResult): void {
  switch (r.status) {
    case "ok":
      return sendJson(res, 200, r.written === undefined ? { status: "ok" } : { status: "ok", written: r.written }, NO_STORE);
    case "not_found":
      return sendError(res, 404, "session not found");
    case "forbidden":
      return sendError(res, 403, "forbidden");
    case "closed":
      return sendError(res, 409, "session already confirmed");
  }
}

/**
 * フィードバックの道 (`/feedback/...`) なら応答して true、違えば何もせず false。
 * - GET  /feedback/<id>                     画面の HTML
 * - GET  /feedback/static/<feedback.css|feedback.js|feedback.html>
 * - GET  /feedback/<id>/data?t=<token>
 * - POST /feedback/<id>/draft?t=<token>     本文 { "draft": Draft }
 * - POST /feedback/<id>/submit?t=<token>    本文 { "draft": Draft }
 */
export async function handleFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: FeedbackContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const segs = url.pathname.slice(PREFIX.length).split("/");
  const method = req.method ?? "GET";
  const token = url.searchParams.get("t") ?? "";

  if (segs.length === 2 && segs[0] === STATIC_SEGMENT) {
    if (method !== "GET") methodNotAllowed(res, "GET");
    else await sendStatic(res, ctx, segs[1]!);
    return true;
  }

  const id = segs[0]!;
  if (id === STATIC_SEGMENT || !ID_RE.test(id)) {
    sendError(res, 404, "not found");
    return true;
  }

  if (segs.length === 1) {
    if (method !== "GET") methodNotAllowed(res, "GET");
    else await sendStatic(res, ctx, "feedback.html");
    return true;
  }

  if (segs.length === 2 && segs[1] === "data") {
    if (method !== "GET") methodNotAllowed(res, "GET");
    else await sendData(res, ctx, id, token);
    return true;
  }

  if (segs.length === 2 && (segs[1] === "draft" || segs[1] === "submit")) {
    if (method !== "POST") {
      methodNotAllowed(res, "POST");
      return true;
    }
    const isSubmit = segs[1] === "submit";
    const body = await readDraftBody(req, res, !isSubmit);
    if (body === undefined) return true;
    const r = isSubmit
      ? await confirmSession(ctx.dir, id, token, body.draft)
      : await saveDraft(ctx.dir, id, token, body.draft!);
    sendOpResult(res, r);
    return true;
  }

  sendError(res, 404, "not found");
  return true;
}
