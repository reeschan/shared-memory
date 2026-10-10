import { createHash } from "node:crypto";
import type { MemoryMeta } from "./frontmatter.ts";

export type Chunk = { chunk_no: number; text: string };

function splitSections(body: string): string[] {
  const sections: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const fm = /^\s*(```+|~~~+)/.exec(line);
    if (fm) {
      const marker = fm[1]!.slice(0, 3);
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    } else if (fence === null && /^#{1,6}\s/.test(line)) {
      sections.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  sections.push(cur.join("\n"));
  return sections.map((s) => s.trim()).filter((s) => s.length > 0);
}

function mergeShort(sections: string[], min: number, max: number): string[] {
  const out: string[] = [];
  for (const sec of sections) {
    const last = out.length - 1;
    if (last >= 0 && out[last]!.length < min && out[last]!.length + 2 + sec.length <= max) {
      out[last] = `${out[last]}\n\n${sec}`;
    } else {
      out.push(sec);
    }
  }
  // 最後の節が短ければ前と結合
  if (out.length >= 2) {
    const tail = out[out.length - 1]!;
    const prev = out[out.length - 2]!;
    if (tail.length < min && prev.length + 2 + tail.length <= max) {
      out.splice(out.length - 2, 2, `${prev}\n\n${tail}`);
    }
  }
  return out;
}

function splitLong(section: string, max: number): string[] {
  if (section.length <= max) return [section];
  const pieces: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.length > 0) pieces.push(cur);
    cur = "";
  };
  for (const para of section.split(/\n[ \t]*\n/)) {
    const p = para.trim();
    if (p.length === 0) continue;
    if (p.length > max) {
      flush();
      for (let i = 0; i < p.length; i += max) pieces.push(p.slice(i, i + max));
      continue;
    }
    if (cur.length === 0) cur = p;
    else if (cur.length + 2 + p.length <= max) cur += `\n\n${p}`;
    else {
      flush();
      cur = p;
    }
  }
  flush();
  return pieces;
}

export function chunkMemory(
  title: string,
  body: string,
  opts: { min_chars: number; max_chars: number },
): Chunk[] {
  const sections = splitSections(body);
  if (sections.length === 0) return [{ chunk_no: 0, text: title }];
  const pieces = mergeShort(sections, opts.min_chars, opts.max_chars).flatMap((s) =>
    splitLong(s, opts.max_chars),
  );
  return pieces.map((p, i) => ({ chunk_no: i, text: `${title}\n\n${p}` }));
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function contentHash(chunkText: string, meta: MemoryMeta, path: string): string {
  const payload = JSON.stringify({
    title: meta.title,
    scope: meta.scope,
    kind: meta.kind,
    provenance: meta.provenance,
    source_agent: meta.source_agent,
    created_at: meta.created_at,
    supersedes: meta.supersedes ?? null,
    symbol_ref: meta.symbol_ref ?? null,
    tags: [...(meta.tags ?? [])].sort(),
    path,
  });
  return sha256(chunkText + "\n" + payload);
}
