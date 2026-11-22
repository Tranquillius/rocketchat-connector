# Rocket.Chat Connector

Connects Claude to [Rocket.Chat](https://www.rocket.chat): rooms, messages, threads, mentions and unread overviews as context for chats, digests and scheduled tasks – and, in write groups that can be switched off one by one, sending messages, reactions and room management.

**User documentation, settings, tools and privacy policy: [plugin/README.md](plugin/README.md).**

The same server is distributed in two ways:

| | Source | Runs in |
|---|---|---|
| Claude plugin | [`plugin/`](plugin/) (`.claude-plugin/plugin.json`, `.mcp.json`) | Claude Code, Cowork on your computer |
| Claude Desktop extension | [`manifest.json`](manifest.json) + `plugin/server`, built into `releases/rocketchat-connector-latest.mcpb` | Claude Desktop |

Install the plugin straight from this repository:

```
/plugin install rocketchat-connector --marketplace Tranquillius/rocketchat-connector
```

The plugin is not listed in the Claude directory: the directory accepts plugins with local MCP servers only from verified organizations.

The server in [`plugin/server/`](plugin/server/) is plain Node.js (18+) without third-party packages. It includes a minimal MCP implementation (`mcp.js`, stdio JSON-RPC with tools and prompts) and argument schemas (`schema.js`).

## Repository layout

```
.claude-plugin/marketplace.json   lists the plugin for /plugin install
plugin/                           the plugin (Claude Code, Cowork)
  .claude-plugin/plugin.json
  .mcp.json                       starts node ${CLAUDE_PLUGIN_ROOT}/server/index.js
  server/                         MCP server (source, no dependencies)
  README.md PRIVACY.md LICENSE icon.png
manifest.json                     Claude Desktop extension manifest (MCPB 0.3)
scripts/build.mjs                 builds and checks the .mcpb
scripts/release.mjs               release: version, tests, .mcpb, commit, tag, push
test/                             tests against a simulated Rocket.Chat server
releases/                         built .mcpb files
```

## Development

No installation needed.

```bash
npm test
```

```bash
npm run validate:plugin
```

```bash
npm run validate
```

```bash
npm run pack
```

- `npm test` runs the protocol tests and the tool tests against a mock Rocket.Chat server (`test/`), not against a real server.
- `validate:plugin` runs `claude plugin validate` with the directory profile in strict mode.
- `validate` checks the extension manifest.
- `pack` builds `dist/rocketchat-connector.mcpb` and checks it with an MCP handshake: all 19 tools with every write group enabled, and diagnostic mode without configuration.

Try the plugin locally in Claude Code:

```bash
claude --plugin-dir ./plugin
```

Or as a plain MCP server:

```bash
claude mcp add rocketchat -e ROCKETCHAT_URL=https://chat.example.org -e ROCKETCHAT_USER_ID=… -e ROCKETCHAT_AUTH_TOKEN=… -- node "$PWD/plugin/server/index.js"
```

## Releases

Requires a Git repository with branch `main` and remote `origin`.

```bash
npm run release -- patch
```

Instead of `patch`, use `minor`, `major` or an explicit version (`0.2.0`). Optional `-m "notes"`; otherwise the commit subjects since the last release become the notes. `--no-push` keeps everything local.

The script sets the version in `package.json`, `manifest.json`, `plugin/.claude-plugin/plugin.json` and `plugin/server/version.js`, runs the tests and the manifest validation, builds `releases/rocketchat-connector-X.Y.Z.mcpb` and `releases/rocketchat-connector-latest.mcpb`, commits, tags `vX.Y.Z` and pushes.

## License

Code: MIT ([LICENSE](LICENSE)). The icon is the Rocket.Chat logo, a trademark of Rocket.Chat Technologies Corp., and not covered by the MIT license.
