#!/usr/bin/env node
// Entry point: always serves MCP over stdio.
// (No "is this the main module?" check – it fails under the Node runtime bundled with
// Claude Desktop, and the process would exit immediately.)
import { loadConfig } from "./config.js";
import { createServer, VERSION } from "./server.js";

const log = (...args) => console.error("[rocketchat-connector]", ...args);

process.on("uncaughtException", (err) => log("Uncaught exception:", err));
process.on("unhandledRejection", (err) => log("Unhandled promise rejection:", err));

try {
  log(`Starting v${VERSION} (Node ${process.version})`);
  const cfg = loadConfig();
  if (cfg.errors.length) log(`Configuration errors: ${cfg.errors.join(" ")}`);
  const server = createServer(cfg);
  log(`Ready – ${cfg.baseUrl ?? "(no URL)"}${cfg.readOnly ? " (read-only)" : ""}`);
  await server.serve();
  log("stdio closed");
} catch (err) {
  log("Fatal error on startup:", err);
  process.exit(1);
}
