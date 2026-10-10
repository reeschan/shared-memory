import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findRoot, loadConfig } from "../src/config.ts";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

test("findRoot はサブディレクトリからルートを見つける", () => {
  const found = findRoot(join(repoRoot, "packages", "core", "test"));
  assert.equal(found.toLowerCase(), join(repoRoot).toLowerCase().replace(/[\\/]+$/, ""));
});

test("findRoot は見つからなければ throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-noroot-"));
  assert.throws(() => findRoot(dir));
});

test("loadConfig はリポジトリの config.yaml を読み絶対パスに解決する", () => {
  const cfg = loadConfig(repoRoot);
  assert.ok(isAbsolute(cfg.root));
  assert.ok(isAbsolute(cfg.memories_dir));
  assert.ok(cfg.memories_dir.endsWith("memories"));
  assert.ok(isAbsolute(cfg.state_db));
  assert.ok(isAbsolute(cfg.cache_dir));
  assert.ok(isAbsolute(cfg.opensearch.template_file));
  assert.ok(isAbsolute(cfg.opensearch.pipeline_file));
  assert.equal(cfg.opensearch.alias, "memories");
  assert.equal(cfg.search.weights.knn, 0.6);
  assert.equal(cfg.mcp.port, 7820);
  assert.deepEqual(cfg.repos, {});
});

test("loadConfig は必須キー欠けで throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-bad-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), "memories_dir: memories\n");
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  assert.throws(() => loadConfig(dir), /必須キー/);
});
