import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMemory, contentHash, sha256 } from "../src/chunk.ts";
import type { MemoryMeta } from "../src/frontmatter.ts";

const OPTS = { min_chars: 400, max_chars: 800 };
const SMALL = { min_chars: 5, max_chars: 800 };

const META: MemoryMeta = {
  id: "01JA0000000000000000000000",
  title: "T",
  scope: "global",
  kind: "semantic",
  provenance: "human_confirmed",
  source_agent: "human",
  created_at: "2026-01-01T00:00:00.000Z",
  tags: ["a", "b"],
};
const PATH = "memories/global/01JA0000000000000000000000.md";

test("見出しごとに分かれる", () => {
  const chunks = chunkMemory("T", "# A\n\naaaaaaaaaa\n\n## B\n\nbbbbbbbbbb", SMALL);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0]!.text, /# A/);
  assert.match(chunks[1]!.text, /## B/);
});

test("コードフェンス内の # 行で分かれない", () => {
  const body = "# A\n\n```sh\n# comment line\necho hi\n```\n\nafter text";
  const chunks = chunkMemory("T", body, SMALL);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.text, /# comment line/);
});

test("2000 字の 1 節は max_chars 以下の複数チャンクになる", () => {
  const para = "あ".repeat(500);
  const body = `# Big\n\n${[para, para, para, para].join("\n\n")}`;
  const chunks = chunkMemory("T", body, OPTS);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.slice("T\n\n".length).length <= OPTS.max_chars);
  }
});

test("1 段落が max_chars を超えると機械的に切る", () => {
  const chunks = chunkMemory("T", "x".repeat(2000), OPTS);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.text.length - 3 <= OPTS.max_chars);
});

test("全チャンクの text が title + 空行で始まる", () => {
  const chunks = chunkMemory("My Title", "# A\n\none\n\n# B\n\ntwo", SMALL);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.text.startsWith("My Title\n\n"));
});

test("chunk_no は 0 からの連番", () => {
  const body = ["# A", "aaaaaaaaaa", "# B", "bbbbbbbbbb", "# C", "cccccccccc"].join("\n\n");
  const chunks = chunkMemory("T", body, SMALL);
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.chunk_no),
    [0, 1, 2],
  );
});

test("短い節は次の節と結合される", () => {
  const chunks = chunkMemory("T", "# A\n\nx\n\n# B\n\ny", OPTS);
  assert.equal(chunks.length, 1);
});

test("空本文は title だけのチャンク 1 個", () => {
  for (const body of ["", "  \n\n"]) {
    assert.deepEqual(chunkMemory("Only", body, OPTS), [{ chunk_no: 0, text: "Only" }]);
  }
});

test("contentHash: 同じ入力で同じ、tags 順不問、title が違えば違う", () => {
  const h = contentHash("text", META, PATH);
  assert.equal(h, contentHash("text", { ...META }, PATH));
  assert.equal(h, contentHash("text", { ...META, tags: ["b", "a"] }, PATH));
  assert.notEqual(h, contentHash("text", { ...META, title: "U" }, PATH));
  assert.notEqual(h, contentHash("text2", META, PATH));
});

test("sha256('abc')", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
