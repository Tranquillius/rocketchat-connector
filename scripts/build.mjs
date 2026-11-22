#!/usr/bin/env node
// Builds the Claude Desktop extension (.mcpb) from the plugin sources: copies plugin/server
// unchanged (no dependencies, no bundling), checks it with an MCP handshake and packs it
// with the mcpb CLI.
//
//   node scripts/build.mjs [target.mcpb]      (default: dist/rocketchat-connector.mcpb)
//   node scripts/build.mjs --validate         (only validate the staged manifest)

import { execFileSync, spawn } from "node:child_process";
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const EXPECTED_TOOLS = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")).tools.length;

/** Starts the server, sends initialize/tools/list/prompts/list and returns the answers. */
export function handshake(entry, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], { env, stdio: ["pipe", "pipe", "pipe"] });
    const answers = new Map();
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`No answer from the server. stderr:\n${stderr}`));
    }, 10000);
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        answers.set(msg.id, msg);
        if (answers.size === 3) child.stdin.end();
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      const get = (id) => {
        const a = answers.get(id);
        if (!a?.result) throw new Error(`Request ${id} failed: ${JSON.stringify(a?.error ?? "no answer")}\n${stderr}`);
        return a.result;
      };
      try {
        resolvePromise({ server: get(1).serverInfo, tools: get(2).tools.length, prompts: get(3).prompts.length });
      } catch (err) {
        reject(err);
      }
    });
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build-smoke-test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "prompts/list" });
  });
}

export async function smokeTest(entry) {
  // With placeholder configuration and all write groups enabled: every tool from manifest.json must register.
  const ok = await handshake(entry, {
    ROCKETCHAT_URL: "https://rocketchat.invalid",
    ROCKETCHAT_USER_ID: "x",
    ROCKETCHAT_AUTH_TOKEN: "x",
    ROCKETCHAT_ALLOW_SEND: "true",
    ROCKETCHAT_ALLOW_REACTIONS: "true",
    ROCKETCHAT_ALLOW_EDIT: "true",
    ROCKETCHAT_ALLOW_ROOMS: "true",
    PATH: process.env.PATH,
  });
  if (ok.tools !== EXPECTED_TOOLS) throw new Error(`Server reports ${ok.tools} tools, expected ${EXPECTED_TOOLS}.`);
  // Without configuration: diagnostic mode with only rocketchat_whoami; the process must not crash.
  const diag = await handshake(entry, { PATH: process.env.PATH });
  if (diag.tools !== 1) throw new Error(`Diagnostic mode reports ${diag.tools} tools, expected 1.`);
  return ok;
}

/** Lays out the extension: manifest.json at the top, server, icon, README and LICENSE from plugin/. */
function stageExtension() {
  const stage = mkdtempSync(join(tmpdir(), "rocketchat-build-"));
  copyFileSync(join(ROOT, "manifest.json"), join(stage, "manifest.json"));
  for (const f of ["icon.png", "README.md", "LICENSE"]) copyFileSync(join(ROOT, "plugin", f), join(stage, f));
  cpSync(join(ROOT, "plugin", "server"), join(stage, "server"), { recursive: true });
  return stage;
}

export function validateManifest() {
  const stage = stageExtension();
  try {
    execFileSync("npx", ["-y", MCPB_CLI, "validate", join(stage, "manifest.json")], { stdio: "inherit" });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function buildBundle(outFile) {
  const stage = stageExtension();
  try {
    const info = await smokeTest(join(stage, "server", "index.js"));
    console.log(`→ Server checked: ${info.server.name} ${info.server.version}, ${info.tools} tools, ${info.prompts} prompts`);

    const out = resolve(outFile);
    mkdirSync(dirname(out), { recursive: true });
    execFileSync("npx", ["-y", MCPB_CLI, "pack", stage, out], { stdio: "pipe" });
    console.log(`→ ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
    return out;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--validate") validateManifest();
  else await buildBundle(process.argv[2] ?? join(ROOT, "dist", "rocketchat-connector.mcpb"));
}
