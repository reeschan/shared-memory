import { loadConfig } from "@shared-memory/core";
import { startServer } from "./app.ts";

const cfg = loadConfig();
const { port, close } = await startServer(cfg);
const shownHost = cfg.mcp.host.includes(":") ? `[${cfg.mcp.host}]` : cfg.mcp.host;
console.log(`MCP server listening on http://${shownHost}:${port}${cfg.mcp.path}`);

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  close().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e);
      process.exit(1);
    },
  );
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
