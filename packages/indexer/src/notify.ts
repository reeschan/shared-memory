// 通知 (Windows のトースト) とブラウザーで開く処理。
// Windows では scripts/notify-toast.ps1 を powershell.exe で呼ぶ。Windows 以外では何もせず false を返す
// (呼び出し側が標準出力に出す)。
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { plainGuard, plainReview, points, type EvalRun } from "@shared-memory/core";

export type Notice = { title: string; body: string; url?: string };

/** コマンドを実行し、終了コード 0 なら true */
export type RunCommand = (file: string, args: string[]) => Promise<boolean>;

export const TOAST_SCRIPT = fileURLToPath(new URL("../../../scripts/notify-toast.ps1", import.meta.url));

const defaultRun: RunCommand = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err) => resolve(err === null));
  });

/** トーストで知らせる。知らせられたら true。Windows 以外と失敗のときは false */
export async function notify(
  n: Notice,
  opts: { platform?: NodeJS.Platform; run?: RunCommand } = {},
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return false;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", TOAST_SCRIPT, "-Title", n.title, "-Body", n.body];
  if (n.url !== undefined && n.url !== "") args.push("-Url", n.url);
  try {
    return await (opts.run ?? defaultRun)("powershell.exe", args);
  } catch {
    return false;
  }
}

/** ブラウザーで開くコマンド。Windows は cmd /c start "" "<url>"、macOS は open、Linux などは xdg-open */
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; verbatim: boolean } {
  if (platform === "win32") return { file: "cmd", args: ["/c", `start "" "${url}"`], verbatim: true };
  if (platform === "darwin") return { file: "open", args: [url], verbatim: false };
  return { file: "xdg-open", args: [url], verbatim: false };
}

/** URL をブラウザーで開く。起動できなければ false */
export function openUrl(url: string): Promise<boolean> {
  const c = openCommand(url);
  return new Promise((resolve) => {
    try {
      const child = spawn(c.file, c.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: c.verbatim,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * sm eval --notify の本文: 見張り (ガード) の判定・検索の質 (本番の nDCG@10 を 100 点満点で)・見直す条件。
 * 専門用語を使わない言葉にする (フィードバックの画面の一般向けと同じ言い換え)
 */
export function evalNotice(run: EvalRun): Notice {
  const check = run.guard.alert ? "。レポートを確かめてください" : "";
  return {
    title: "shared-memory: 今週の検索の測定",
    body: `検索の質 ${points(run.production.ndcg10)} 点 (100 点満点) / 悪化の見張り: ${plainGuard(run)} / 設定の見直し: ${plainReview(run)}${check}`,
  };
}
