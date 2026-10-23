// scripts/publish-code.mjs の --dest 経路 (SSH を使わない) のテスト。
// 一時フォルダーに git init した小さなリポジトリを作り、本物のスクリプトを
// <repo>/scripts/publish-code.mjs にコピーして、配布先フォルダーへ実行する。
// スクリプトは自分の置き場所の 1 つ上をリポジトリのルートとして扱う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REAL_SCRIPT = fileURLToPath(new URL("../publish-code.mjs", import.meta.url));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

// 一時フォルダーの中に、配布元のリポジトリと配布先フォルダーを作る
function makeFixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sm-publish-code-"));
  // 途中で失敗しても消せるよう、フォルダーを作った直後に後片付けを登録する
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = path.join(tmp, "repo");
  const dest = path.join(tmp, "dest");

  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, path.join(repo, "scripts", "publish-code.mjs"));

  writeFile(repo, ".gitignore", ".env\n.cache/\n");
  writeFile(repo, "a.txt", "alpha\n");
  writeFile(repo, "dir/b.txt", "beta\n");
  writeFile(repo, "new.txt", "new\n"); // 未追跡 (ignore されていない)
  writeFile(repo, ".env", "SECRET=1\n"); // ignore される
  writeFile(repo, ".cache/data.txt", "cache\n"); // ignore される

  git(repo, ["init", "-q"]);
  git(repo, ["add", ".gitignore", "a.txt", "dir/b.txt"]);
  git(repo, [
    "-c", "user.name=t",
    "-c", "user.email=t@localhost",
    "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "init",
  ]);

  return { tmp, repo, dest };
}

function runPublish(fx, input = "") {
  return spawnSync(
    process.execPath,
    [path.join(fx.repo, "scripts", "publish-code.mjs"), "--dest", fx.dest],
    { input, cwd: fx.repo, encoding: "utf8", windowsHide: true },
  );
}

function readManifest(dest) {
  return JSON.parse(fs.readFileSync(path.join(dest, "manifest.json"), "utf8"));
}

// <配布先>/files/ に実際に置かれたファイルを、/ 区切りの相対パスで返す
function placedFiles(dest) {
  const filesDir = path.join(dest, "files");
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else out.push(childRel);
    }
  };
  if (fs.existsSync(filesDir)) walk(filesDir, "");
  return out.sort();
}

const CONTENTS = {
  ".gitignore": ".env\n.cache/\n",
  "a.txt": "alpha\n",
  "dir/b.txt": "beta\n",
  "new.txt": "new\n",
  // コピーしたスクリプト自身も ignore されていない未追跡ファイルなので配布される
  "scripts/publish-code.mjs": fs.readFileSync(REAL_SCRIPT, "utf8"),
};

function publishOrFail(fx, input = "") {
  const r = runPublish(fx, input);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  return r;
}

describe("publish-code.mjs --dest", () => {
  test("追跡ファイルと ignore されていない未追跡ファイルだけを配布し、manifest に一覧とハッシュを書く", (t) => {
    const fx = makeFixture(t);

    publishOrFail(fx);

    // 配布先の中身が配布元と同じ
    for (const [rel, content] of Object.entries(CONTENTS)) {
      assert.equal(fs.readFileSync(path.join(fx.dest, "files", rel), "utf8"), content, rel);
    }
    // .gitignore にあるものは置かない
    assert.equal(fs.existsSync(path.join(fx.dest, "files", ".env")), false);
    assert.equal(fs.existsSync(path.join(fx.dest, "files", ".cache")), false);

    const manifest = readManifest(fx.dest);
    assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(CONTENTS).sort());
    for (const [rel, content] of Object.entries(CONTENTS)) {
      assert.equal(manifest.files[rel], sha256(Buffer.from(content)), rel);
    }
    assert.match(manifest.version, /^[0-9a-f]{64}$/);
    // manifest の一覧と、実際に置かれたファイルが一致する
    assert.deepEqual(placedFiles(fx.dest), Object.keys(manifest.files).sort());
  });

  test("何も変えずにもう一度実行すると manifest を書き直さない", (t) => {
    const fx = makeFixture(t);

    publishOrFail(fx);
    const manifestPath = path.join(fx.dest, "manifest.json");
    const before = fs.readFileSync(manifestPath);
    const beforeManifest = JSON.parse(before.toString("utf8"));

    publishOrFail(fx);
    const after = fs.readFileSync(manifestPath);
    const afterManifest = JSON.parse(after.toString("utf8"));

    assert.equal(afterManifest.version, beforeManifest.version);
    assert.equal(afterManifest.generated_at, beforeManifest.generated_at);
    assert.deepEqual(after, before); // バイト単位でも変わらない (書き直されない)
  });

  test("ファイルを消してから実行すると配布先と manifest から消え、version が変わる", (t) => {
    const fx = makeFixture(t);

    publishOrFail(fx);
    const before = readManifest(fx.dest);
    assert.ok("a.txt" in before.files);

    fs.rmSync(path.join(fx.repo, "a.txt"));
    publishOrFail(fx);
    const after = readManifest(fx.dest);

    assert.equal(fs.existsSync(path.join(fx.dest, "files", "a.txt")), false);
    assert.equal("a.txt" in after.files, false);
    assert.notEqual(after.version, before.version);
    // 消していないファイルは残る
    assert.equal(fs.existsSync(path.join(fx.dest, "files", "dir", "b.txt")), true);
  });

  test("中身を変えてから実行すると配布先と manifest のハッシュが新しくなる", (t) => {
    const fx = makeFixture(t);

    publishOrFail(fx);
    const before = readManifest(fx.dest);
    const oldVersion = before.version;
    const oldHash = before.files["new.txt"];
    assert.equal(oldHash, sha256(Buffer.from("new\n")));

    writeFile(fx.repo, "new.txt", "changed\n");
    publishOrFail(fx);
    const after = readManifest(fx.dest);

    assert.equal(fs.readFileSync(path.join(fx.dest, "files", "new.txt"), "utf8"), "changed\n");
    assert.equal(after.files["new.txt"], sha256(Buffer.from("changed\n")));
    assert.notEqual(after.files["new.txt"], oldHash);
    assert.notEqual(after.version, oldVersion);
  });

  test("リポジトリの外のファイルを編集した PostToolUse では何も配布しない", (t) => {
    const fx = makeFixture(t);

    const outside = path.join(fx.tmp, "outside", "note.txt");
    writeFile(fx.tmp, "outside/note.txt", "outside\n");
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_input: { file_path: outside },
    });

    const r = runPublish(fx, input);

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(fs.existsSync(path.join(fx.dest, "manifest.json")), false);
  });
});
