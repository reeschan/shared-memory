import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_AGENTS,
  WORKSPACE_SCOPE_PREFIX,
  isWorkspaceScope,
  memoryRelPath,
  parseMemoryFile,
  scopeToDir,
  serializeMemory,
  validateMeta,
} from "../src/frontmatter.ts";
import type { MemoryMeta } from "../src/frontmatter.ts";

const ID = "01JA0000000000000000000000";
const PATH = `memories/global/${ID}.md`;

const SAMPLE = `---
id: ${ID}
title: OpenSearch のポートはループバック限定
scope: global
kind: semantic
provenance: human_confirmed
source_agent: human
created_at: 2026-10-10T00:00:00.000Z
tags:
  - security
---

本文
`;

function baseMeta(): MemoryMeta {
  return {
    id: ID,
    title: "題名",
    scope: "global",
    kind: "semantic",
    provenance: "human_confirmed",
    source_agent: "human",
    created_at: "2026-10-10T00:00:00.000Z",
  };
}

test("正しい front matter を parse できる", () => {
  const r = parseMemoryFile(SAMPLE, PATH);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.memory.id, ID);
    assert.equal(r.memory.title, "OpenSearch のポートはループバック限定");
    assert.equal(r.memory.created_at, "2026-10-10T00:00:00.000Z");
    assert.deepEqual(r.memory.tags, ["security"]);
    assert.equal(r.memory.body, "本文");
    assert.equal(r.memory.path, PATH);
  }
});

test("front matter が無いとエラー", () => {
  const r = parseMemoryFile("本文だけ", PATH);
  assert.equal(r.ok, false);
});

test("必須項目欠けはエラー", () => {
  const r = parseMemoryFile(SAMPLE.replace("title: OpenSearch のポートはループバック限定\n", ""), PATH);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("title")));
});

test("列挙外の値はエラー", () => {
  const r = parseMemoryFile(SAMPLE.replace("kind: semantic", "kind: bogus"), PATH);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("kind")));
});

test("source_agent grok は受け付ける", () => {
  assert.ok(SOURCE_AGENTS.includes("grok"));
  assert.deepEqual(validateMeta({ ...baseMeta(), source_agent: "grok" }), []);
  const r = parseMemoryFile(SAMPLE.replace("source_agent: human", "source_agent: grok"), PATH);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.memory.source_agent, "grok");
});

test("source_agent harness2 は受け付ける", () => {
  assert.ok(SOURCE_AGENTS.includes("harness2"));
  assert.deepEqual(validateMeta({ ...baseMeta(), source_agent: "harness2" }), []);
  const r = parseMemoryFile(SAMPLE.replace("source_agent: human", "source_agent: harness2"), PATH);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.memory.source_agent, "harness2");
});

test("ULID でない id はエラー", () => {
  const r = parseMemoryFile(SAMPLE.replace(`id: ${ID}`, "id: not-a-ulid"), PATH);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("ULID")));
});

test("id とファイル名の不一致はエラー", () => {
  const r = parseMemoryFile(SAMPLE, "memories/global/01JA0000000000000000000001.md");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("id")));
});

test("scope とディレクトリの不一致はエラー", () => {
  const r = parseMemoryFile(SAMPLE, `memories/project/foo/${ID}.md`);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("scope")));
});

test("serializeMemory -> parseMemoryFile で元に戻る (tags・supersedes あり)", () => {
  const meta: MemoryMeta = {
    ...baseMeta(),
    scope: "repo:my-repo",
    kind: "episodic",
    provenance: "agent_verified",
    source_agent: "claude",
    supersedes: "01JA0000000000000000000001",
    symbol_ref: "src/a.ts#foo",
    tags: ["a", "b: c"],
  };
  const body = "# 見出し\n\n段落1\n\n段落2";
  const path = memoryRelPath(meta);
  assert.equal(path, `memories/repo/my-repo/${ID}.md`);
  const text = serializeMemory(meta, body);
  assert.ok(text.startsWith("---\nid: "));
  const r = parseMemoryFile(text, path);
  assert.equal(r.ok, true);
  if (r.ok) {
    const { body: b, path: p, ...rest } = r.memory;
    assert.deepEqual(rest, meta);
    assert.equal(b, body);
    assert.equal(p, path);
  }
});

test("serializeMemory は undefined のキーを出さずキー順を守る", () => {
  const text = serializeMemory(baseMeta(), "x");
  assert.ok(!text.includes("supersedes"));
  assert.ok(!text.includes("tags"));
  assert.ok(text.indexOf("id:") < text.indexOf("title:"));
  assert.ok(text.indexOf("source_agent:") < text.indexOf("created_at:"));
  assert.ok(text.endsWith("---\n\nx\n"));
});

test("source_path と source_sha256 を書き出して読み直すと同じ値になる", () => {
  const sha = "0123456789abcdef".repeat(4);
  const meta: MemoryMeta = {
    ...baseMeta(),
    tags: ["a"],
    source_path: "docs/design.md",
    source_sha256: sha,
  };
  assert.deepEqual(validateMeta(meta), []);
  const text = serializeMemory(meta, "本文");
  assert.ok(text.indexOf("tags:") < text.indexOf("source_path:"));
  assert.ok(text.indexOf("source_path:") < text.indexOf("source_sha256:"));
  const r = parseMemoryFile(text, memoryRelPath(meta));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.memory.source_path, "docs/design.md");
    assert.equal(r.memory.source_sha256, sha);
  }
});

test("source_path と source_sha256 が無いメモリは今までどおり有効", () => {
  assert.deepEqual(validateMeta(baseMeta()), []);
  const text = serializeMemory(baseMeta(), "x");
  assert.ok(!text.includes("source_path"));
  assert.ok(!text.includes("source_sha256"));
  const r = parseMemoryFile(SAMPLE, PATH);
  assert.equal(r.ok, true);
});

test("source_path が空文字・文字列以外・1000 字超ならエラー", () => {
  for (const source_path of ["", 123, null, "a".repeat(1001)]) {
    const errs = validateMeta({ ...baseMeta(), source_path });
    assert.ok(errs.some((e) => e.includes("source_path")), `${String(source_path)}: ${errs.join("; ")}`);
  }
  const r = parseMemoryFile(SAMPLE.replace("tags:\n  - security\n", 'source_path: ""\n'), PATH);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("source_path")));
});

test("source_sha256 が 64 桁の小文字 16 進でなければエラー", () => {
  for (const source_sha256 of [
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    123,
  ]) {
    const errs = validateMeta({ ...baseMeta(), source_sha256 });
    assert.ok(errs.some((e) => e.includes("source_sha256")), `${String(source_sha256)}: ${errs.join("; ")}`);
  }
  const r = parseMemoryFile(SAMPLE.replace("tags:\n  - security\n", `source_sha256: ${"A".repeat(64)}\n`), PATH);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("source_sha256")));
});

test("scopeToDir の 3 形式", () => {
  assert.equal(scopeToDir("global"), "global");
  assert.equal(scopeToDir("project:foo"), "project/foo");
  assert.equal(scopeToDir("repo:bar.baz_1"), "repo/bar.baz_1");
});

test("isWorkspaceScope: project:work. で始まるときだけ作業空間", () => {
  assert.equal(WORKSPACE_SCOPE_PREFIX, "project:work.");
  assert.equal(isWorkspaceScope("project:work.x"), true);
  assert.equal(isWorkspaceScope("project:work.shared-memory.main.W-001"), true);
  assert.equal(isWorkspaceScope("project:work."), true);
  assert.equal(isWorkspaceScope("project:work"), false);
  assert.equal(isWorkspaceScope("project:workshop"), false);
  assert.equal(isWorkspaceScope("repo:work.x"), false);
  assert.equal(isWorkspaceScope("global"), false);
});

test("scopeToDir は不正値で throw", () => {
  assert.throws(() => scopeToDir("other"));
  assert.throws(() => scopeToDir("project:"));
  assert.throws(() => scopeToDir("project:a/b"));
  assert.throws(() => scopeToDir("repo:.."));
});

test("validateMeta: 妥当なら空、不正値は複数エラー", () => {
  assert.deepEqual(validateMeta(baseMeta()), []);
  assert.ok(validateMeta(null).length > 0);
  const errs = validateMeta({ ...baseMeta(), title: "", created_at: "xx", tags: [1], supersedes: "z" });
  assert.ok(errs.length >= 4);
  assert.ok(validateMeta({ ...baseMeta(), title: "a".repeat(201) }).length > 0);
});
