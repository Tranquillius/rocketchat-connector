// Tiny in-process MCP client for tests: talks JSON-RPC to McpServer.handle()
// (the same code path as stdio, minus the line framing).

export async function rpcClient(server, { protocolVersion = "2025-06-18" } = {}) {
  let id = 0;
  const request = async (method, params) => {
    const res = await server.handle({ jsonrpc: "2.0", id: ++id, method, params });
    if (res.error) {
      const err = new Error(res.error.message);
      err.code = res.error.code;
      throw err;
    }
    return res.result;
  };
  const init = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
  await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    init,
    request,
    listTools: () => request("tools/list", {}),
    listPrompts: () => request("prompts/list", {}),
    getPrompt: (name, args) => request("prompts/get", { name, arguments: args }),
    callTool: ({ name, arguments: args }) => request("tools/call", { name, arguments: args }),
  };
}
