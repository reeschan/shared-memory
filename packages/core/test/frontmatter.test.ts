import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_AGENTS,
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

test("scopeToDir の 3 形式", () => {
  assert.equal(scopeToDir("global"), "global");
  assert.equal(scopeToDir("project:foo"), "project/foo");
  assert.equal(scopeToDir("repo:bar.baz_1"), "repo/bar.baz_1");
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
