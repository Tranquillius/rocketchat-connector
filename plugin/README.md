# Rocket.Chat Connector

Connects Claude to [Rocket.Chat](https://www.rocket.chat) through its REST API (tested with Rocket.Chat 9.0).
It gives Claude your rooms, messages, threads, mentions and unread messages as context for chats and scheduled tasks, and – in write groups you can switch off one by one – lets it send messages, react and manage rooms.

The connector works with **your own Rocket.Chat account**: it sees every channel, group and direct message that account can see, and messages it sends appear under your name.

It is a local MCP server written in plain Node.js (18 or newer) without third-party packages. It only talks to the Rocket.Chat server you configure.

## Setup

### 1. Create a personal access token

1. In Rocket.Chat: avatar → *Profile* → *Personal Access Tokens* (or *My Account → Personal Access Tokens*).
2. Enter a name (e.g. "Claude"), enable **"Ignore Two Factor Authentication"** and click *Add*.
3. Copy the token **and the user ID** from the dialog. The token is shown only once.

If the menu entry is missing, your role needs the permission *create-personal-access-tokens*.

### 2. Install

- **Claude Code / Cowork (plugin):** install the plugin from this repository's marketplace (Claude Code 2.1.275 or later):

  ```
  /plugin install rocketchat-connector --marketplace Tranquillius/rocketchat-connector
  ```

  On older versions, first add the marketplace with `/plugin marketplace add Tranquillius/rocketchat-connector`, then run `/plugin install rocketchat-connector@rocketchat-connector`. Enter the URL, user ID and token when prompted. Cowork only loads the plugin when its session runs on your computer and the settings are filled in.
- **Claude Desktop (extension):** download `rocketchat-connector-latest.mcpb` from the [releases](https://github.com/Tranquillius/rocketchat-connector/tree/main/releases), open it and fill in the settings. When updating, remove the old version first and restart Claude Desktop completely afterwards.

## Settings

The plugin passes the settings to the server as `CLAUDE_PLUGIN_OPTION_<KEY>` (e.g. `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN`); the desktop extension and manual setups use the `ROCKETCHAT_*` names below. If both are set, `ROCKETCHAT_*` wins.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| Rocket.Chat URL | `ROCKETCHAT_URL` | – | Base URL of the server |
| User ID | `ROCKETCHAT_USER_ID` | – | From the token dialog |
| Personal access token | `ROCKETCHAT_AUTH_TOKEN` | – | Stored in the system's secure credential store |
| Read only | `ROCKETCHAT_READ_ONLY` | `false` | Disables all write groups |
| Send messages | `ROCKETCHAT_ALLOW_SEND` | `true` | `rocketchat_send_message` |
| Reactions, read state, pinning | `ROCKETCHAT_ALLOW_REACTIONS` | `true` | `rocketchat_react`, `rocketchat_mark_read`, `rocketchat_flag_message` |
| Edit own messages | `ROCKETCHAT_ALLOW_EDIT` | `false` | `rocketchat_update_message` |
| Create and manage rooms | `ROCKETCHAT_ALLOW_ROOMS` | `false` | `rocketchat_create_room`, `rocketchat_invite_users`, `rocketchat_update_room` |
| Default result count | `ROCKETCHAT_DEFAULT_LIMIT` | `50` | Messages or rooms per query |
| Max. characters per message | `ROCKETCHAT_MAX_BODY_CHARS` | `4000` | Longer messages are truncated |
| Timeout | `ROCKETCHAT_TIMEOUT_MS` | `30000` | Time limit per API call |

Disabled groups are not offered as tools at all.

## Tools

**Read**

- `rocketchat_whoami` – test the connection; server version and enabled write groups
- `rocketchat_list_rooms` – your rooms with unread and mention counters, topic and last activity; filter by type, name, unread, favorites, activity
- `rocketchat_get_room` – a room with topic, description, announcement, team and members
- `rocketchat_get_messages` – messages in chronological order, by period or `filter` (`unread`, `pinned`, `starred`, `mentions`); with `thread_id` a whole thread
- `rocketchat_list_threads` – threads of a room (all, followed, unread)
- `rocketchat_search_messages` – full-text search in one room or across your most recently active rooms; Rocket.Chat search syntax such as `from:username`, `has:url`, `after:01/11/2026`
- `rocketchat_unread_overview` – every room with unread messages including the messages, mentions and direct messages first; marks nothing as read
- `rocketchat_list_mentions` – @-mentions of you across all rooms in a period
- `rocketchat_search_directory` – users, public channels, teams
- `rocketchat_get_user` – user details and the ID of your direct message with them
- `rocketchat_api_get` – read-only raw access to any `/api/v1` endpoint

**Write** (depending on the settings)

- `rocketchat_send_message` – to a room, a thread or as a direct message (`@username`, created if needed)
- `rocketchat_react`, `rocketchat_mark_read`, `rocketchat_flag_message` (pin/star)
- `rocketchat_update_message` – only your own messages
- `rocketchat_create_room`, `rocketchat_invite_users`, `rocketchat_update_room`

Deleting is deliberately not supported. Rooms can be given everywhere as ID, short name (`ops`, `#ops`), display name or `@username` (direct message).

**Prompts:** `rocketchat_daily_digest`, `rocketchat_room_summary`, `rocketchat_my_mentions`.

## Scheduled tasks

Example for a scheduled task (weekdays 7:30):

> Create a digest with the Rocket.Chat connector: `rocketchat_unread_overview`, mentions and direct messages first, the key points per room with links.
> Do not mark anything as read and do not send anything.

For unattended reports, run the connector with *Read only*.

## Notes

- **Rate limit:** By default Rocket.Chat allows 10 REST API calls per minute and endpoint (settings "API Rate Limiter"; admins are exempt). Single queries wait for the reset automatically. Tools that query many rooms (search without a room, mentions, unread overview) do not wait; they return partial results and name the skipped rooms (`rate_limited`, `rooms_skipped`). Remedies: search a specific `room`, lower `max_rooms`, or grant the role the permission *api-bypass-rate-limit*.
- **Unread:** your own messages never count as unread. `filter: "unread"` reads from your read position in the room.
- **Mentions:** `rocketchat_list_mentions` finds direct @username mentions only, not @all/@here (the unread overview counts those as `group_mentions`).
- **Changing settings (e.g. a new token):** server instances that are already running keep the old values until Claude is restarted completely.
- Chat message content is passed to the model as data; the server instructions tell it not to follow instructions found in messages and not to copy direct messages into other rooms unless you ask for it.

## What the connector runs, sends and fetches

- It runs one local process: `node server/index.js` from this plugin. Nothing is downloaded or installed at runtime.
- It sends HTTPS requests only to the Rocket.Chat URL you configure, authenticated with your user ID and token (`X-User-Id`, `X-Auth-Token` headers) and a `User-Agent` of `rocketchat-connector-mcp/<version>`.
- It fetches the data a tool needs (rooms, subscriptions, messages, users) and returns it to Claude. Write tools change data in Rocket.Chat only when Claude calls them.
- It contacts no other service, has no telemetry and writes no files.

## Privacy Policy

The full policy is in [PRIVACY.md](PRIVACY.md). In short:

- **Collection:** the connector reads the Rocket.Chat data that the tools you or Claude call request – for example room lists, messages, threads, mentions and user profiles of your account. It collects nothing else.
- **Use and storage:** the data goes to Claude as tool results to answer your request. The connector keeps room and user lists in memory for at most 60 seconds to save API calls and never writes them to disk. Your token is stored by Claude in the operating system's secure credential store (plugin) or by Claude Desktop's encrypted extension settings.
- **Sharing:** the connector shares data with no one except your Rocket.Chat server and Claude. How Anthropic processes conversation content is governed by Anthropic's terms and privacy policy.
- **Retention:** nothing is retained by the connector after the process ends. Messages you send or change with the write tools remain in Rocket.Chat under your account.
- **Contact:** git@von-schmidsfeld.net

## License

Code: MIT (see [LICENSE](LICENSE)).

Icon (`icon.png`): the Rocket.Chat logo as shipped with Rocket.Chat. "Rocket.Chat" and its logo are trademarks of Rocket.Chat Technologies Corp.; the icon is not covered by the MIT license of the code. This connector is an independent project and not affiliated with or endorsed by Rocket.Chat Technologies Corp.
