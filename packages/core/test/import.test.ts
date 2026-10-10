import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImportJsonl } from "../src/import.ts";

function row(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Sudachi の設定",
    content: "split_mode は C を使う。",
    scope: "project:demo",
    kind: "semantic",
    source_agent: "claude",
    ...extra,
  });
}

test("(a) 空行・空白だけの行は飛ばし、行番号は元の行で数える", () => {
  const text = ["", row(), "   ", "\t", row({ title: "二件目" }), ""].join("\n");
  const r = parseImportJsonl(text, {});
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.inputs.map((i) => i.line), [2, 5]);
  assert.equal(r.inputs[1]!.input.title, "二件目");
});

test("(a') CRLF と先頭の BOM も読める", () => {
  const r = parseImportJsonl("﻿" + row() + "\r\n" + row({ title: "x" }) + "\r\n", {});
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.inputs.map((i) => i.line), [1, 2]);
});

test("(b) JSON として壊れた行は行番号付きでエラーになり、他の行は読める", () => {
  const text = [row(), "{ title: 壊れている", row({ title: "三件目" }), "[1, 2]"].join("\n");
  const r = parseImportJsonl(text, {});
  assert.deepEqual(r.inputs.map((i) => i.line), [1, 3]);
  assert.deepEqual(r.errors.map((e) => e.line), [2, 4]);
  assert.match(r.errors[0]!.errors[0]!, /JSON として読めません/);
  assert.match(r.errors[1]!.errors[0]!, /オブジェクトではありません/);
});

test("(b') 必須欠けはエラー", () => {
  const r = parseImportJsonl(row({ title: undefined, kind: null }), {});
  assert.equal(r.inputs.length, 0);
  assert.equal(r.errors[0]!.line, 1);
  assert.ok(r.errors[0]!.errors.some((e) => /title がありません/.test(e)));
  assert.ok(r.errors[0]!.errors.some((e) => /kind がありません/.test(e)));
});

test("(c) provenance 省略で agent_verified、指定があればそのまま", () => {
  const r = parseImportJsonl([row(), row({ provenance: "human_confirmed" })].join("\n"), {});
  assert.equal(r.inputs[0]!.input.provenance, "agent_verified");
  assert.equal(r.inputs[1]!.input.provenance, "human_confirmed");
});

test("(d) source_agent 省略で defaults の値、行の指定が優先、defaults も無ければエラー", () => {
  const text = [row({ source_agent: undefined }), row({ source_agent: "kimi" })].join("\n");
  const withDefault = parseImportJsonl(text, { source_agent: "codex" });
  assert.deepEqual(withDefault.errors, []);
  assert.equal(withDefault.inputs[0]!.input.source_agent, "codex");
  assert.equal(withDefault.inputs[1]!.input.source_agent, "kimi");

  const noDefault = parseImportJsonl(text, {});
  assert.deepEqual(noDefault.inputs.map((i) => i.line), [2]);
  assert.equal(noDefault.errors.length, 1);
  assert.equal(noDefault.errors[0]!.line, 1);
  assert.match(noDefault.errors[0]!.errors.join(";"), /source_agent がありません/);
});
