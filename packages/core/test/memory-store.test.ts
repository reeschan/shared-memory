import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { prepareMemory, type WriteInput } from "../src/memory-store.ts";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const now = new Date("2026-10-10T01:02:03.456Z");

function input(extra: Partial<WriteInput> = {}): WriteInput {
  return {
    title: "OpenSearch の Sudachi 設定",
    content: "split_mode は C を使う。",
    scope: "project:demo",
    kind: "semantic",
    provenance: "agent_verified",
    source_agent: "claude",
    ...extra,
  };
}

function errorsOf(r: ReturnType<typeof prepareMemory>): string[] {
  assert.equal(r.ok, false);
  return r.ok ? [] : r.errors;
}

test("(a) 正しい入力で ULID の id と created_at が付く", () => {
  const r = prepareMemory(input({ tags: ["opensearch"], symbol_ref: "repo:x#f" }), {
    now,
    existingIds: new Set(),
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.meta.id, ULID_RE);
  assert.equal(r.meta.created_at, "2026-10-10T01:02:03.456Z");
  assert.equal(r.meta.title, "OpenSearch の Sudachi 設定");
  assert.equal(r.meta.scope, "project:demo");
  assert.deepEqual(r.meta.tags, ["opensearch"]);
  assert.equal(r.meta.symbol_ref, "repo:x#f");
  assert.equal(r.meta.supersedes, undefined);
  assert.equal(r.body, "split_mode は C を使う。");
  const r2 = prepareMemory(input(), { now, existingIds: new Set() });
  assert.ok(r2.ok);
  assert.notEqual(r2.meta.id, r.meta.id);
});

test("(b) provenance が列挙外でエラー", () => {
  const errors = errorsOf(
    prepareMemory(input({ provenance: "guess" as WriteInput["provenance"] }), {
      now,
      existingIds: new Set(),
    }),
  );
  assert.ok(errors.some((e) => e.includes("provenance")), errors.join("; "));
});

test("(c) content に GitHub トークン形式の文字列を含むとエラー", () => {
  const token = "ghp_" + "a".repeat(36);
  const errors = errorsOf(
    prepareMemory(input({ content: `CI で使うトークンは ${token} です。` }), {
      now,
      existingIds: new Set(),
    }),
  );
  assert.ok(errors.some((e) => e.includes("秘密情報らしき文字列") && e.includes("GitHub")), errors.join("; "));
});

test("(d) 存在しない supersedes でエラー、存在すれば通る", () => {
  const missing = ulid();
  const errors = errorsOf(
    prepareMemory(input({ supersedes: missing }), { now, existingIds: new Set([ulid()]) }),
  );
  assert.ok(errors.some((e) => e.includes("supersedes") && e.includes(missing)), errors.join("; "));
  const r = prepareMemory(input({ supersedes: missing }), { now, existingIds: new Set([missing]) });
  assert.ok(r.ok);
  assert.equal(r.meta.supersedes, missing);
});

test("(e) 空の content でエラー", () => {
  for (const content of ["", "  \n\t "]) {
    const errors = errorsOf(prepareMemory(input({ content }), { now, existingIds: new Set() }));
    assert.ok(errors.some((e) => e.includes("content")), errors.join("; "));
  }
});

test("必須フィールドの欠落と不正な scope でエラー", () => {
  const bad = { ...input(), scope: "team:x" } as Partial<WriteInput>;
  delete bad.source_agent;
  const errors = errorsOf(prepareMemory(bad as WriteInput, { now, existingIds: new Set() }));
  assert.ok(errors.some((e) => e.includes("source_agent")), errors.join("; "));
  assert.ok(errors.some((e) => e.includes("scope")), errors.join("; "));
});
