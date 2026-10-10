import { parse, stringify } from "yaml";

export const KINDS = ["episodic", "semantic"] as const;
export const PROVENANCES = ["human_confirmed", "agent_verified", "agent_inferred"] as const;
export const SOURCE_AGENTS = ["human", "claude", "codex", "kimi"] as const;
export const TIERS = ["hot", "warm", "cold", "archive"] as const;

export type Kind = (typeof KINDS)[number];
export type Provenance = (typeof PROVENANCES)[number];
export type SourceAgent = (typeof SOURCE_AGENTS)[number];
export type Tier = (typeof TIERS)[number];

export type MemoryMeta = {
  id: string;
  title: string;
  scope: string;
  kind: Kind;
  provenance: Provenance;
  source_agent: SourceAgent;
  created_at: string;
  supersedes?: string;
  symbol_ref?: string;
  tags?: string[];
};

export type Memory = MemoryMeta & { body: string; path: string };

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function scopeToDir(scope: string): string {
  if (scope === "global") return "global";
  const m = /^(project|repo):(.*)$/.exec(scope);
  if (m && NAME_RE.test(m[2]!) && m[2] !== "." && m[2] !== "..") return `${m[1]}/${m[2]}`;
  throw new Error(`不正な scope: ${scope}`);
}

function inList(list: readonly string[], v: unknown): boolean {
  return typeof v === "string" && list.includes(v);
}

export function validateMeta(meta: unknown): string[] {
  const errors: string[] = [];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return ["front matter がマップではありません"];
  }
  const m = meta as Record<string, unknown>;
  for (const k of ["id", "title", "scope", "kind", "provenance", "source_agent", "created_at"]) {
    if (m[k] === undefined || m[k] === null) errors.push(`${k} がありません`);
  }
  if (m.id != null && !(typeof m.id === "string" && ULID_RE.test(m.id))) {
    errors.push("id が ULID ではありません");
  }
  if (m.title != null) {
    if (typeof m.title !== "string" || m.title.trim() === "" || m.title.length > 200) {
      errors.push("title は空でない 200 字以内の文字列にしてください");
    }
  }
  if (m.scope != null) {
    try {
      if (typeof m.scope !== "string") throw new Error("not string");
      scopeToDir(m.scope);
    } catch {
      errors.push(`scope が不正です: ${String(m.scope)}`);
    }
  }
  if (m.kind != null && !inList(KINDS, m.kind)) errors.push(`kind が不正です: ${String(m.kind)}`);
  if (m.provenance != null && !inList(PROVENANCES, m.provenance)) {
    errors.push(`provenance が不正です: ${String(m.provenance)}`);
  }
  if (m.source_agent != null && !inList(SOURCE_AGENTS, m.source_agent)) {
    errors.push(`source_agent が不正です: ${String(m.source_agent)}`);
  }
  if (m.created_at != null) {
    if (typeof m.created_at !== "string" || Number.isNaN(Date.parse(m.created_at))) {
      errors.push("created_at が ISO 8601 ではありません");
    }
  }
  if (m.supersedes != null && !(typeof m.supersedes === "string" && ULID_RE.test(m.supersedes))) {
    errors.push("supersedes が ULID ではありません");
  }
  if (m.symbol_ref != null && typeof m.symbol_ref !== "string") {
    errors.push("symbol_ref は文字列にしてください");
  }
  if (m.tags != null) {
    if (!Array.isArray(m.tags) || !m.tags.every((t) => typeof t === "string")) {
      errors.push("tags は文字列の配列にしてください");
    }
  }
  return errors;
}

export function memoryRelPath(
  meta: Pick<MemoryMeta, "id" | "scope">,
  memoriesDirName = "memories",
): string {
  return `${memoriesDirName}/${scopeToDir(meta.scope)}/${meta.id}.md`;
}

export function parseMemoryFile(
  text: string,
  relPath: string,
): { ok: true; memory: Memory } | { ok: false; errors: string[] } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { ok: false, errors: ["front matter (--- で囲まれた YAML) がありません"] };
  let data: unknown;
  try {
    data = parse(m[1]!);
  } catch (e) {
    return { ok: false, errors: [`YAML を読めません: ${(e as Error).message}`] };
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.created_at instanceof Date && !Number.isNaN(d.created_at.getTime())) {
      d.created_at = d.created_at.toISOString();
    }
  }
  const errors = validateMeta(data);
  if (errors.length > 0) return { ok: false, errors };
  const meta = data as MemoryMeta;
  const base = relPath.split("/").pop() ?? relPath;
  if (base.replace(/\.md$/, "") !== meta.id) {
    errors.push(`ファイル名 ${base} が id ${meta.id} と一致しません`);
  }
  const expected = memoryRelPath(meta);
  if (relPath !== expected) {
    errors.push(`パス ${relPath} が scope と一致しません (期待: ${expected})`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const body = m[2]!.replace(/^(?:[ \t]*\r?\n)+/, "").trim();
  return { ok: true, memory: { ...meta, body, path: relPath } };
}

export function serializeMemory(meta: MemoryMeta, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const k of [
    "id", "title", "scope", "kind", "provenance", "source_agent",
    "created_at", "supersedes", "symbol_ref", "tags",
  ] as const) {
    if (meta[k] !== undefined) ordered[k] = meta[k];
  }
  return `---\n${stringify(ordered)}---\n\n${body.trim()}\n`;
}
