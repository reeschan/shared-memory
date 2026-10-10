import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { memoryRelPath, serializeMemory, type MemoryMeta, type SourceAgent } from "./frontmatter.ts";
import { indexIncremental, scanMemories, type Deps, type IndexReport } from "./indexing.ts";
import { prepareMemory, type WriteInput } from "./memory-store.ts";

export type ImportLineError = { line: number; errors: string[] };

export type ImportPlan = {
  ok: { line: number; meta: MemoryMeta; body: string }[];
  errors: ImportLineError[];
};

const REQUIRED = ["title", "content", "scope", "kind"] as const;

/** JSONL を読み、1 行 = 1 つの WriteInput にする。行番号は 1 始まり。空行は飛ばす */
export function parseImportJsonl(
  text: string,
  defaults: { source_agent?: SourceAgent },
): { inputs: { line: number; input: WriteInput }[]; errors: ImportLineError[] } {
  const inputs: { line: number; input: WriteInput }[] = [];
  const errors: ImportLineError[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === "") return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      errors.push({ line, errors: [`JSON として読めません: ${(e as Error).message}`] });
      return;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      errors.push({ line, errors: ["JSON のオブジェクトではありません"] });
      return;
    }
    const obj = { ...(data as Record<string, unknown>) };
    if (obj.provenance === undefined || obj.provenance === null) obj.provenance = "agent_verified";
    if (obj.source_agent === undefined || obj.source_agent === null) {
      if (defaults.source_agent !== undefined) obj.source_agent = defaults.source_agent;
    }
    const lineErrors: string[] = [];
    for (const k of REQUIRED) {
      if (obj[k] === undefined || obj[k] === null) lineErrors.push(`${k} がありません`);
    }
    if (obj.source_agent === undefined || obj.source_agent === null) {
      lineErrors.push("source_agent がありません (--source-agent でも指定できます)");
    }
    if (lineErrors.length > 0) {
      errors.push({ line, errors: lineErrors });
      return;
    }
    inputs.push({ line, input: obj as unknown as WriteInput });
  });
  return { inputs, errors };
}

/** 各行を検証してメタデータを作る (書き込みはしない) */
export async function planImport(
  cfg: Config,
  inputs: { line: number; input: WriteInput }[],
  now: Date = new Date(),
): Promise<ImportPlan> {
  const { memories } = await scanMemories(cfg);
  const existingIds = new Set(memories.map((m) => m.id));
  const usedIds = new Set<string>(existingIds);
  const seen = new Map<string, number>();
  const plan: ImportPlan = { ok: [], errors: [] };

  inputs.forEach(({ line, input }, i) => {
    // 同じミリ秒の ULID が並ばないよう、行ごとに 1ms ずつずらす
    const at = new Date(now.getTime() + i);
    let r = prepareMemory(input, { now: at, existingIds });
    for (let retry = 0; r.ok && usedIds.has(r.meta.id) && retry < 10; retry++) {
      r = prepareMemory(input, { now: at, existingIds });
    }
    const errors = r.ok ? [] : [...r.errors];
    if (r.ok && usedIds.has(r.meta.id)) errors.push(`id ${r.meta.id} を重複なく採番できません`);

    const key = JSON.stringify([input.title, input.content]);
    const dup = seen.get(key);
    if (dup !== undefined) errors.push(`L${dup} と title と content が同じです`);
    else seen.set(key, line);

    if (errors.length > 0 || !r.ok) {
      plan.errors.push({ line, errors });
      return;
    }
    usedIds.add(r.meta.id);
    plan.ok.push({ line, meta: r.meta, body: r.body });
  });
  return plan;
}

/** plan の全ファイルを書いてから、インデックスを 1 回だけ更新する */
export async function commitImport(
  cfg: Config,
  deps: Deps,
  plan: ImportPlan,
): Promise<{ created: { id: string; path: string }[]; report: IndexReport }> {
  if (plan.errors.length > 0) {
    throw new Error(`エラーのある行があるため書き込みません (${plan.errors.length} 件)`);
  }
  const dirName = path.basename(cfg.memories_dir);
  const created: { id: string; path: string }[] = [];
  for (const { meta, body } of plan.ok) {
    const relPath = memoryRelPath(meta, dirName);
    const file = path.join(cfg.memories_dir, ...relPath.split("/").slice(1));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, serializeMemory(meta, body), { encoding: "utf8", flag: "wx" });
    created.push({ id: meta.id, path: relPath });
  }
  const report = await indexIncremental(cfg, deps);
  return { created, report };
}
