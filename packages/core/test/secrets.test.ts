import { test } from "node:test";
import assert from "node:assert/strict";
import { findSecrets } from "../src/secrets.ts";

test("AWS アクセスキーを検出", () => {
  assert.ok(findSecrets("key: " + "AKIA" + "ABCDEFGHIJKLMNOP").length > 0);
});

test("GitHub トークンを検出", () => {
  assert.ok(findSecrets("ghp" + "_" + "a".repeat(36)).length > 0);
  assert.ok(findSecrets("github" + "_pat_" + "A1b2C3d4E5f6G7h8I9j0K1").length > 0);
});

test("sk-ant- を検出", () => {
  const found = findSecrets("sk" + "-ant-" + "api03-abcdefghij");
  assert.ok(found.length > 0);
});

test("OpenAI 形式・Slack・Google を検出", () => {
  assert.ok(findSecrets("sk" + "-" + "A".repeat(24)).length > 0);
  assert.ok(findSecrets("xox" + "b-123456-abcdef").length > 0);
  assert.ok(findSecrets("AI" + "za" + "A".repeat(35)).length > 0);
});

test("秘密鍵ブロックを検出", () => {
  assert.ok(findSecrets("-----BEGIN " + "RSA PRIVATE KEY-----\nxxx").length > 0);
});

test("汎用の代入パターンを検出", () => {
  assert.ok(findSecrets("API_KEY = " + "abcdefghij0123456789").length > 0);
});

test("普通の日本語文では空配列", () => {
  assert.deepEqual(findSecrets("OpenSearch のポートはループバックに限定する。パスワードは別途管理する。"), []);
});

test("重複なしで返す", () => {
  const k = "AKIA" + "ABCDEFGHIJKLMNOP";
  const r = findSecrets(`${k} ${k}`);
  assert.equal(new Set(r).size, r.length);
});
