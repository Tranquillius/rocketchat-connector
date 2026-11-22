# Privacy Policy – Rocket.Chat Connector

Last updated: 2026-11-22

The Rocket.Chat Connector ("the connector") is a local MCP server that runs on your computer as a Claude plugin or Claude Desktop extension. It connects Claude to a Rocket.Chat server that you choose, using your own Rocket.Chat account. This policy explains what data the connector handles and how.

## Data the connector collects

The connector does not collect data for itself. When Claude calls one of its tools, it requests from your Rocket.Chat server exactly the data that tool needs, for example:

- your user profile (name, username, e-mail address, roles, status);
- the rooms you are a member of, with unread and mention counters, topics and member lists;
- messages, threads, attachments metadata, reactions and mentions in those rooms, including direct messages;
- directory entries of other users, channels and teams.

It also reads the settings you enter: the server URL, your user ID, your personal access token and the connector options.

## How the data is used

- Data returned by Rocket.Chat is passed to Claude as tool results so that Claude can answer your request (for example to summarize unread messages).
- Write tools (send, react, mark as read, pin/star, edit own messages, create rooms, invite users, set room topics) change data in Rocket.Chat only when Claude calls them. They can be switched off in the settings.
- The connector does not use the data for any other purpose, does not build profiles, shows no advertising and has no analytics or telemetry.

## Storage and retention

- **Credentials:** your access token is stored by Claude – in the operating system's secure credential store when installed as a plugin, or in Claude Desktop's encrypted extension settings. The connector receives it as an environment variable at start and keeps it only in memory.
- **Cached data:** to save API calls, the connector keeps your room and subscription lists and looked-up users in memory for at most 60 seconds. Nothing is written to disk.
- **After the process ends:** the connector retains no data. Content in your Claude conversations is retained according to your Claude account settings and Anthropic's policies.
- Messages you send or edit through the connector are stored by your Rocket.Chat server like any other message from your account.

## Sharing with third parties

The connector sends data only to:

1. **your Rocket.Chat server** – the URL you configure, over the protocol given in that URL (use `https://`);
2. **Claude**, as tool results within your conversation. Anthropic's processing of conversation content is governed by Anthropic's [Privacy Policy](https://www.anthropic.com/legal/privacy) and the terms of your Claude plan.

It contacts no other service and does not sell or share data with anyone else.

## Your choices

- Use the *Read only* option or switch off individual write groups.
- Revoke the personal access token in Rocket.Chat (Profile → Personal Access Tokens) at any time; the connector then loses access immediately.
- Uninstall the plugin or extension to remove the connector and its stored settings.

## Children

The connector is a tool for workplace and organisational chat and is not directed at children.

## Changes

Changes to this policy are published in this file in the project repository: <https://github.com/Tranquillius/rocketchat-connector>.

## Contact

Alexander von Schmidsfeld – git@von-schmidsfeld.net
