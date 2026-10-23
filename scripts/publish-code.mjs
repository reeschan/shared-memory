#!/usr/bin/env node
// shared-memory のコード (Git が追跡するファイルと、ignore されていない未追跡ファイル) を
// サーバー PC の配布先フォルダーにミラーする。サーバー PC 側は scripts/deploy-code.ps1 が
// manifest.json を見て作業フォルダーへ反映し、MCP を再起動する。
//
// 使い方 (どちらか一方):
//   node scripts/publish-code.mjs --ssh <user@host> --remote-dir <サーバー PC 上の配布先> [--force]
//     SSH で送る (鍵認証が前提)。変わったファイルを tar にまとめて scp し、相手側で展開して
//     manifest.json を置き換えた後、相手の SharedMemory-Deploy タスクを起動する。
//   node scripts/publish-code.mjs --dest <配布先フォルダー> [--trigger-ssh <user@host>] [--force]
//     共有フォルダーなど、この PC から直接書けるフォルダーへ送る。--trigger-ssh を付けると、
//     送った後に ssh で相手の SharedMemory-Deploy タスクを起動する。
//   --force  hook 入力の有無や差分に関わらず全ファイルを送り直し、反映タスクも起動する
// 配布先には <配布先>/files/ に中身、<配布先>/manifest.json に一覧とハッシュを置く。
//
// Claude Code の hook (PostToolUse / SessionEnd) からも呼べる。PostToolUse では、編集された
// ファイルがこのリポジトリ配下のときだけ動く。hook から呼ばれたときは配布を切り離した子プロセスに
// 任せてすぐに戻る。常に終了コード 0 で、標準出力には何も出さない (エージェントを止めない)。
// ログは .cache/logs/publish-code.log。
//
// node_modules・state・.cache・.env・config.local.yaml などは .gitignore にあるので対象外になる。

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = path.join(ROOT, ".cache", "logs");
const LOG_FILE = path.join(LOG_DIR, "publish-code.log");
const LOCK_FILE = path.join(ROOT, ".cache", "publish-code.lock");
const LOCK_STALE_MS = 2 * 60 * 1000;
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
// Git Bash の GNU tar ではなく Windows 同梱の bsdtar を使う (サーバー PC 側の展開も同じもの)
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DEST = arg("--dest");
const TRIGGER = arg("--trigger-ssh");
const SSH_TARGET = arg("--ssh");
const REMOTE_DIR = arg("--remote-dir");
const FORCE = process.argv.includes("--force");
const CHILD = process.argv.includes("--child"); // hook から切り離して起動した子プロセス

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref(); // 入力が先に終われば待たずに抜ける
  });
}

const norm = (p) => path.resolve(String(p)).replace(/\\/g, "/").toLowerCase();
const isUnderRoot = (p) => !!p && (norm(p) === norm(ROOT) || norm(p).startsWith(norm(ROOT) + "/"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// 相手が落ちているとファイル操作や ssh が長く固まるので、先に短く接続して確かめる
function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 2000 });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(false));
  });
}
function destReachable(dest) {
  const m = /^[\\/]{2}([^\\/]+)[\\/]/.exec(dest); // UNC パス (\\host\share)
  return m ? portOpen(m[1], 445) : Promise.resolve(true);
}
const sshHost = (target) => target.split("@").pop();

function acquireLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(LOCK_FILE, { force: true });
        return acquireLock();
      }
    } catch {}
    return false;
  }
}

function listFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, windowsHide: true });
  return [...new Set(out.toString("utf8").split("\0").filter(Boolean))]
    .filter((rel) => {
      try { return fs.statSync(path.join(ROOT, rel)).isFile(); } catch { return false; } // 追跡中でも作業ツリーで消したものは除く
    })
    .sort();
}

function buildManifest(files) {
  const map = {};
  for (const rel of files) map[rel] = sha256(fs.readFileSync(path.join(ROOT, rel)));
  const version = sha256(Buffer.from(files.map((f) => `${map[f]} ${f}`).join("\n")));
  return { version, generated_at: new Date().toISOString(), files: map };
}

function parseJson(text) {
  try { return JSON.parse(String(text).replace(/^\uFEFF/, "")); } catch { return null; }
}

// 前回の manifest と比べて、送るファイルと消すファイルを決める
function diff(prev, next) {
  const prevFiles = (!FORCE && prev?.files) || {};
  const copied = Object.keys(next.files).filter((rel) => prevFiles[rel] !== next.files[rel]);
  const removed = Object.keys(prev?.files ?? {}).filter((rel) => !(rel in next.files));
  return { copied, removed };
}

function run(cmd, args, { input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out = [], err = [];
    p.stdout.on("data", (c) => out.push(c));
    p.stderr.on("data", (c) => err.push(c));
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, stdout: "", stderr: e.message }); });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

// PowerShell のスクリプトを -EncodedCommand で相手に渡す (クォートの入れ子を避ける)
function remotePowerShell(target, script, timeoutMs) {
  // 出力は UTF-8 に固定する (日本語のファイル名が既定のコードページで化けると差分を誤る)
  const prefix = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n";
  const enc = Buffer.from(prefix + script, "utf16le").toString("base64");
  return run("ssh", [...SSH_OPTS, target, `powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`], { timeoutMs });
}
const psLiteral = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const TRIGGER_CMD = "schtasks /run /tn SharedMemory-Deploy";

function publishToDir(dest) {
  const filesDir = path.join(dest, "files");
  const manifestPath = path.join(dest, "manifest.json");
  const next = buildManifest(listFiles());
  const prev = fs.existsSync(manifestPath) ? parseJson(fs.readFileSync(manifestPath, "utf8")) : null;
  if (!FORCE && prev?.version === next.version) return { changed: false };

  const { copied, removed } = diff(prev, next);
  for (const rel of copied) {
    const target = path.join(filesDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), target);
  }
  for (const rel of removed) fs.rmSync(path.join(filesDir, rel), { force: true });
  // manifest は最後に書く。受け取り側は manifest のハッシュと中身が揃うまで反映しない
  const tmp = manifestPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1));
  fs.renameSync(tmp, manifestPath);
  return { changed: true, version: next.version, copied, removed };
}

async function publishOverSsh(target, remoteDir) {
  const next = buildManifest(listFiles());
  const got = await remotePowerShell(target,
    `$m = Join-Path ${psLiteral(remoteDir)} 'manifest.json'; if (Test-Path -LiteralPath $m) { [IO.File]::ReadAllText($m) }`, 20000);
  if (got.code !== 0) throw new Error(`manifest の取得に失敗 (exit ${got.code}): ${got.stderr.trim()}`);
  const prev = got.stdout.trim() ? parseJson(got.stdout) : null;
  if (!FORCE && prev?.version === next.version) return { changed: false };

  const { copied, removed } = diff(prev, next);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sm-publish-"));
  try {
    const upload = [];
    if (copied.length) {
      const list = path.join(work, "list.txt");
      fs.writeFileSync(list, copied.join("\n") + "\n");
      execFileSync(TAR, ["-cf", path.join(work, "payload.tar"), "-C", ROOT, "-T", list], { windowsHide: true });
      upload.push(path.join(work, "payload.tar"));
    }
    if (removed.length) {
      fs.writeFileSync(path.join(work, "removed.txt"), removed.join("\n") + "\n");
      upload.push(path.join(work, "removed.txt"));
    }
    fs.writeFileSync(path.join(work, "manifest.json"), JSON.stringify(next, null, 1));
    upload.push(path.join(work, "manifest.json"));

    const incoming = remoteDir.replace(/[\\/]+$/, "") + "\\incoming";
    const mk = await remotePowerShell(target,
      `$in = ${psLiteral(incoming)}; if (Test-Path -LiteralPath $in) { Remove-Item -LiteralPath $in -Recurse -Force }; New-Item -ItemType Directory -Force -Path $in | Out-Null`, 20000);
    if (mk.code !== 0) throw new Error(`受け取りフォルダーの用意に失敗: ${mk.stderr.trim()}`);
    const scp = await run("scp", ["-q", ...SSH_OPTS, ...upload, `${target}:${incoming.replace(/\\/g, "/")}/`], { timeoutMs: 120000 });
    if (scp.code !== 0) throw new Error(`scp に失敗 (exit ${scp.code}): ${scp.stderr.trim()}`);

    // 相手側: 展開 → 消す → manifest を最後に置き換える → 反映タスクを起動する
    const apply = await remotePowerShell(target, `
$ErrorActionPreference = 'Stop'
$d = ${psLiteral(remoteDir)}; $in = Join-Path $d 'incoming'; $files = Join-Path $d 'files'
New-Item -ItemType Directory -Force -Path $files | Out-Null
if (Test-Path -LiteralPath (Join-Path $in 'payload.tar')) {
  & (Join-Path $env:SystemRoot 'System32\\tar.exe') -xf (Join-Path $in 'payload.tar') -C $files
  if ($LASTEXITCODE -ne 0) { throw "tar の展開に失敗 (exit $LASTEXITCODE)" }
}
if (Test-Path -LiteralPath (Join-Path $in 'removed.txt')) {
  foreach ($rel in [IO.File]::ReadAllLines((Join-Path $in 'removed.txt'))) {
    if ($rel) { Remove-Item -LiteralPath (Join-Path $files ($rel -replace '/', '\\')) -Force -ErrorAction SilentlyContinue }
  }
}
Move-Item -LiteralPath (Join-Path $in 'manifest.json') -Destination (Join-Path $d 'manifest.json') -Force
Remove-Item -LiteralPath $in -Recurse -Force
${TRIGGER_CMD} | Out-Null
'applied'`, 60000);
    if (apply.code !== 0 || !apply.stdout.includes("applied")) throw new Error(`相手側での展開に失敗 (exit ${apply.code}): ${apply.stderr.trim()}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { changed: true, version: next.version, copied, removed, triggered: true };
}

async function trigger(target) {
  const r = await run("ssh", [...SSH_OPTS, target, TRIGGER_CMD], { timeoutMs: 10000 });
  return `exit ${r.code}`;
}

(async () => {
  let locked = false;
  try {
    const raw = CHILD ? "" : await readStdin();
    let input = {};
    try { input = JSON.parse(raw || "{}"); } catch {}
    const event = input.hook_event_name ?? "";
    if (!FORCE && event === "PostToolUse") {
      const fp = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "";
      if (!isUnderRoot(fp)) return; // このリポジトリと関係ない編集
    }
    if (event) {
      // hook からの呼び出しでは配布 (数秒かかる) を切り離した子プロセスに任せ、エージェントを待たせない
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--child"], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
      child.unref();
      return;
    }
    const sshMode = !!SSH_TARGET;
    if (sshMode ? !REMOTE_DIR : !DEST) { log("skip: --ssh と --remote-dir、または --dest を指定してください"); return; }
    const ok = sshMode ? await portOpen(sshHost(SSH_TARGET), 22) : await destReachable(DEST);
    if (!ok) { log(`skip: 配布先に接続できません (${sshMode ? SSH_TARGET : DEST})`); return; }
    if (!acquireLock()) { log("skip: 別の publish-code が実行中"); return; }
    locked = true;

    const r = sshMode ? await publishOverSsh(SSH_TARGET, REMOTE_DIR) : publishToDir(DEST);
    if (!r.changed) return;
    log(`event=${CHILD ? "hook" : "manual"} version=${r.version.slice(0, 12)} copied=${r.copied.length} removed=${r.removed.length}` +
      (r.copied.length + r.removed.length <= 20 ? ` [${[...r.copied, ...r.removed.map((x) => "-" + x)].join(", ")}]` : "") +
      (r.triggered ? " triggered" : ""));
    if (!sshMode && TRIGGER) log(`trigger ${TRIGGER}: ${await trigger(TRIGGER)}`);
  } catch (e) {
    log(`error: ${e?.message ?? e}`);
  } finally {
    if (locked) try { fs.rmSync(LOCK_FILE, { force: true }); } catch {}
  }
})();
