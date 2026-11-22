// Minimal Model Context Protocol server (tools and prompts over stdio, JSON-RPC 2.0).
// Implements only what this connector needs, so it runs without third-party packages.
// Spec: https://modelcontextprotocol.io/specification

import { SchemaError, objectSchema, parseObject } from "./schema.js";

/** Newest first; the client's version is accepted if listed, otherwise the newest is offered. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class McpServer {
  /**
   * @param {{name: string, version: string}} info
   * @param {{instructions?: string}} [options]
   */
  constructor(info, { instructions } = {}) {
    this.info = info;
    this.instructions = instructions;
    this.tools = new Map();
    this.prompts = new Map();
  }

  /**
   * @param {string} name
   * @param {{title?: string, description?: string, inputSchema?: object, annotations?: object}} def
   * @param {(args: object) => Promise<object>} handler Returns a CallToolResult ({content, isError?}).
   */
  registerTool(name, def, handler) {
    if (this.tools.has(name)) throw new Error(`Tool ${name} is already registered.`);
    this.tools.set(name, { def, handler });
  }

  /**
   * @param {string} name
   * @param {{title?: string, description?: string, argsSchema?: object}} def
   * @param {(args: object) => object} handler Returns a GetPromptResult ({messages}).
   */
  registerPrompt(name, def, handler) {
    if (this.prompts.has(name)) throw new Error(`Prompt ${name} is already registered.`);
    this.prompts.set(name, { def, handler });
  }

  listTools() {
    return [...this.tools].map(([name, { def }]) => ({
      name,
      ...(def.title ? { title: def.title } : {}),
      description: def.description,
      inputSchema: objectSchema(def.inputSchema),
      ...(def.annotations ? { annotations: { ...(def.title ? { title: def.title } : {}), ...def.annotations } } : {}),
    }));
  }

  listPrompts() {
    return [...this.prompts].map(([name, { def }]) => ({
      name,
      ...(def.title ? { title: def.title } : {}),
      description: def.description,
      arguments: Object.entries(def.argsSchema ?? {}).map(([arg, schema]) => ({
        name: arg,
        ...(schema.props.description ? { description: schema.props.description } : {}),
        required: !schema.isOptional,
      })),
    }));
  }

  async callTool(name, args) {
    const tool = this.tools.get(name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
    let parsed;
    try {
      parsed = parseObject(tool.def.inputSchema, args ?? {});
    } catch (err) {
      if (err instanceof SchemaError) return { isError: true, content: [{ type: "text", text: `Invalid arguments for ${name}: ${err.message}` }] };
      throw err;
    }
    try {
      return await tool.handler(parsed);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err?.message ?? String(err) }] };
    }
  }

  async getPrompt(name, args) {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new RpcError(INVALID_PARAMS, `Unknown prompt: ${name}`);
    try {
      return await prompt.handler(parseObject(prompt.def.argsSchema, args ?? {}));
    } catch (err) {
      if (err instanceof SchemaError) throw new RpcError(INVALID_PARAMS, `Invalid arguments for ${name}: ${err.message}`);
      throw err;
    }
  }

  async dispatch(method, params = {}) {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: this.info,
          ...(this.instructions ? { instructions: this.instructions } : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.listTools() };
      case "tools/call":
        return this.callTool(params.name, params.arguments);
      case "prompts/list":
        return { prompts: this.listPrompts() };
      case "prompts/get":
        return this.getPrompt(params.name, params.arguments);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /**
   * Handles one JSON-RPC message. Returns the response, or undefined for notifications and responses.
   * @param {any} msg
   */
  async handle(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: INVALID_REQUEST, message: "Invalid JSON-RPC message" } };
    }
    // Notifications (no id) such as notifications/initialized need no answer; neither do responses.
    if (msg.id === undefined || msg.method === undefined) return undefined;
    try {
      const result = await this.dispatch(msg.method, msg.params ?? {});
      return { jsonrpc: "2.0", id: msg.id, result };
    } catch (err) {
      const code = err instanceof RpcError ? err.code : INTERNAL_ERROR;
      return { jsonrpc: "2.0", id: msg.id, error: { code, message: err?.message ?? String(err) } };
    }
  }

  /**
   * Serves newline-delimited JSON-RPC over the given streams (stdio by default).
   * @returns {Promise<void>} Resolves when the input stream ends.
   */
  serve({ input = process.stdin, output = process.stdout } = {}) {
    const write = (obj) => output.write(JSON.stringify(obj) + "\n");
    const onLine = async (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
        return;
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      const responses = (await Promise.all(batch.map((m) => this.handle(m)))).filter(Boolean);
      if (Array.isArray(msg)) {
        if (responses.length) write(responses);
      } else if (responses[0]) {
        write(responses[0]);
      }
    };

    return new Promise((resolve) => {
      let buffer = "";
      input.setEncoding("utf8");
      input.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          onLine(line);
        }
      });
      input.on("end", () => {
        if (buffer.trim()) onLine(buffer);
        resolve();
      });
    });
  }
}
