// Protocol tests for the minimal MCP server and the schema builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer, PROTOCOL_VERSIONS } from "../plugin/server/mcp.js";
import { s, objectSchema, parseObject } from "../plugin/server/schema.js";
import { rpcClient } from "./rpc-client.js";

function demoServer() {
  const server = new McpServer({ name: "demo", version: "1.0.0" }, { instructions: "Be nice." });
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes the input",
      inputSchema: { text: s.string().min(1).describe("Text"), times: s.number().int().min(1).max(3).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ text, times = 1 }) => ({ content: [{ type: "text", text: text.repeat(times) }] }),
  );
  server.registerTool("boom", { description: "Throws", inputSchema: {} }, async () => {
    throw new Error("kaputt");
  });
  server.registerPrompt("greet", { title: "Greet", description: "Greets", argsSchema: { name: s.string().describe("Who") } }, ({ name }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Hello ${name}` } }],
  }));
  return server;
}

test("schema: JSON Schema output", () => {
  const shape = {
    room: s.string().min(1).describe("Room"),
    limit: s.number().int().min(1).max(500).optional().describe("Limit"),
    type: s.union([s.enum(["a", "b"]), s.array(s.enum(["a", "b"]))]).optional(),
    params: s.record().optional(),
    since: s.string().regex(/^now$/, "only now").optional(),
  };
  assert.deepEqual(objectSchema(shape), {
    type: "object",
    properties: {
      room: { type: "string", minLength: 1, description: "Room" },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Limit" },
      type: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "array", items: { type: "string", enum: ["a", "b"] } }] },
      params: { type: "object", additionalProperties: true },
      since: { type: "string", pattern: "^now$" },
    },
    required: ["room"],
  });
  assert.deepEqual(objectSchema({}), { type: "object", properties: {} });
});

test("schema: validation and coercion", () => {
  const shape = { n: s.number().int().min(1).max(5).optional(), b: s.boolean().optional(), t: s.union([s.enum(["x"]), s.array(s.enum(["x"]))]).optional(), r: s.string() };
  assert.deepEqual(parseObject(shape, { r: "ok", n: "3", b: "true", extra: 1 }), { r: "ok", n: 3, b: true });
  assert.deepEqual(parseObject(shape, { r: "ok", t: ["x"] }), { r: "ok", t: ["x"] });
  assert.throws(() => parseObject(shape, {}), /r: required/);
  assert.throws(() => parseObject(shape, { r: "ok", n: 9 }), /n: must be ≤ 5/);
  assert.throws(() => parseObject(shape, { r: "ok", n: 1.5 }), /n: expected an integer/);
  assert.throws(() => parseObject(shape, { r: "ok", t: "y" }), /t: expected one of "x" or expected an array/);
  assert.throws(() => parseObject({ a: s.array(s.string()).min(1) }, { a: [] }), /a: needs at least 1 entry/);
  assert.throws(() => parseObject({ a: s.string().min(1) }, { a: "" }), /a: must not be empty/);
});

test("mcp: initialize, version negotiation, lists", async () => {
  const c = await rpcClient(demoServer());
  assert.equal(c.init.protocolVersion, "2025-06-18");
  assert.deepEqual(c.init.serverInfo, { name: "demo", version: "1.0.0" });
  assert.equal(c.init.instructions, "Be nice.");
  assert.ok(c.init.capabilities.tools && c.init.capabilities.prompts);
  assert.equal((await rpcClient(demoServer(), { protocolVersion: "1999-01-01" })).init.protocolVersion, PROTOCOL_VERSIONS[0]);

  const { tools } = await c.listTools();
  assert.deepEqual(tools[0].annotations, { title: "Echo", readOnlyHint: true });
  assert.deepEqual(tools[0].inputSchema.required, ["text"]);
  assert.equal(tools[1].annotations, undefined);
  const { prompts } = await c.listPrompts();
  assert.deepEqual(prompts[0].arguments, [{ name: "name", description: "Who", required: true }]);
  assert.equal((await c.getPrompt("greet", { name: "Ada" })).messages[0].content.text, "Hello Ada");
  assert.deepEqual(await c.request("ping", {}), {});
});

test("mcp: tool calls, errors", async () => {
  const c = await rpcClient(demoServer());
  assert.equal((await c.callTool({ name: "echo", arguments: { text: "ab", times: 2 } })).content[0].text, "abab");
  const bad = await c.callTool({ name: "echo", arguments: { text: "" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Invalid arguments for echo: text: must not be empty/);
  const boom = await c.callTool({ name: "boom", arguments: {} });
  assert.deepEqual(boom, { isError: true, content: [{ type: "text", text: "kaputt" }] });
  await assert.rejects(c.callTool({ name: "nope", arguments: {} }), (e) => e.code === -32602);
  await assert.rejects(c.request("resources/list", {}), (e) => e.code === -32601);
  await assert.rejects(c.getPrompt("greet", {}), (e) => e.code === -32602);

  const server = demoServer();
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }), undefined);
  assert.equal((await server.handle({ id: 1, method: "ping" })).error.code, -32600);
});

test("mcp: stdio framing with the real entry point", async () => {
  const entry = fileURLToPath(new URL("../plugin/server/index.js", import.meta.url));
  const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  // Two messages in one chunk, and a malformed line
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n" + "{oops\n");
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rocketchat_whoami", arguments: {} } });
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(byId[1].result.serverInfo.name, "rocketchat-connector");
  // Without configuration only the diagnostic tool is offered
  assert.deepEqual(byId[2].result.tools.map((t) => t.name), ["rocketchat_whoami"]);
  assert.match(byId[3].result.content[0].text, /not configured/);
  assert.equal(byId[null].error.code, -32700);
});
