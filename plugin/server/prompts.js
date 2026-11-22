import { s } from "./schema.js";

const msg = (text) => ({ messages: [{ role: "user", content: { type: "text", text } }] });

/** Templates for typical (scheduled) tasks. */
export function registerPrompts(server) {
  server.registerPrompt(
    "rocketchat_daily_digest",
    {
      title: "Chat digest: unread",
      description: "Summary of all unread messages, mentions and direct messages.",
      argsSchema: {
        focus: s.string().optional().describe("Optional: topic or rooms the digest should focus on"),
      },
    },
    ({ focus }) =>
      msg(
        `Create a compact digest of my unread Rocket.Chat messages${focus ? ` focusing on: ${focus}` : ""}.\n` +
          `1. Call rocketchat_unread_overview.\n` +
          `2. For unread threads or truncated rooms, load details with rocketchat_get_messages (thread_id or filter "unread") where needed.\n` +
          `Structure: mentions and direct messages (what is expected of me?), decisions and important news per room, the rest in one sentence per room. ` +
          `Include a link to each message. Do not mark anything as read and do not send anything.`,
      ),
  );

  server.registerPrompt(
    "rocketchat_room_summary",
    {
      title: "Room summary",
      description: "What was discussed and decided in a channel or group during a period?",
      argsSchema: {
        room: s.string().describe("Room: short name, display name or ID"),
        since: s.string().optional().describe("Period start, default now-7d"),
      },
    },
    ({ room, since }) =>
      msg(
        `Summarize the Rocket.Chat room "${room}" since ${since || "now-7d"}.\n` +
          `1. Load the room with rocketchat_get_room (include_members false).\n` +
          `2. Load the messages with rocketchat_get_messages (since "${since || "now-7d"}", limit 300) and active threads with rocketchat_list_threads; read important threads with thread_id.\n` +
          `Structure: topics, decisions, open questions and tasks (who, what), links to the key messages. Do not send anything.`,
      ),
  );

  server.registerPrompt(
    "rocketchat_my_mentions",
    {
      title: "Where was I mentioned?",
      description: "Mentions from the last days that may need a response.",
      argsSchema: { since: s.string().optional().describe("Default now-7d") },
    },
    ({ since }) =>
      msg(
        `List my Rocket.Chat mentions since ${since || "now-7d"} (rocketchat_list_mentions). ` +
          `For threads, check with rocketchat_get_messages (thread_id) whether I have already replied. ` +
          `Order: unanswered questions or requests to me first, then information. For each: room, sender, gist and link. Do not send anything.`,
      ),
  );
}
