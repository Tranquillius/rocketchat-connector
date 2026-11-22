import { s as S } from "./schema.js";
import { Resolver } from "./resolve.js";
import { ROOM_TYPES, clean, compactMessage, compactRoom, compactUser, errorResult, isoDate, json, resolveDate, roomLink } from "./format.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const MARK = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const HISTORY = { c: "/channels.history", p: "/groups.history", d: "/im.history" };
const MEMBERS = { c: "/channels.members", p: "/groups.members", d: "/im.members" };
const PREFIX = { c: "channels", p: "groups" };
const TYPE_KEYS = { channel: "c", private: "p", direct: "d" };

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const tsOf = (m) => new Date(isoDate(m.ts) ?? 0).getTime();
const byTsAsc = (a, b) => tsOf(a) - tsOf(b);

/** Runs fn for all items with limited concurrency (spares the rate limit). */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Queries several rooms. On a rate limit (429) the remaining rooms are skipped instead of waiting.
 * @returns {Promise<{results: any[], errors: string[], skipped: string[]}>}
 */
export async function perRoom(targets, fn, { concurrency = 4, empty = [] } = {}) {
  let limited = false;
  const errors = [];
  const skipped = [];
  const label = (t) => (t.t === "d" ? `@${t.name}` : t.name);
  const results = await mapLimit(targets, concurrency, async (t, idx) => {
    if (limited) {
      skipped.push(label(t));
      return empty;
    }
    try {
      return await fn(t, idx);
    } catch (err) {
      if (err.status === 429) {
        limited = true;
        skipped.push(label(t));
      } else {
        errors.push(`${label(t)}: ${err.message}`);
      }
      return empty;
    }
  });
  return { results, errors, skipped };
}

const RATE_NOTE = (n) =>
  n ? `Rocket.Chat API rate limit reached – ${n} rooms were not queried. Try again in a minute or query a specific room.` : undefined;

/** Rocket.Chat expects "from:user" without @ – "from:@user" finds nothing. */
export const normalizeSearch = (q) => q.replace(/\b(from|mention):@/g, "$1:");

/** ":+1:" bzw. "+1" -> ":+1:" */
export const normalizeEmoji = (e) => `:${String(e).trim().replace(/^:|:$/g, "")}:`;

const dateStr = S.string()
  .regex(/^(\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?|now([+-]\d+[mhdw])?)$/, "ISO date (2026-11-01) or relative (now-7d, now-24h, now-30m)");
const roomArg = S.string().min(1).describe("Room: ID, short name (e.g. 'ops' or '#ops'), display name or '@username' for direct messages");
const roomType = S.enum(["channel", "private", "direct"]);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * @param {import("./mcp.js").McpServer} server
 * @param {import("./rocketchat-client.js").RocketChatClient} api
 * @param {ReturnType<import("./config.js").loadConfig>} cfg
 */
export function registerTools(server, api, cfg) {
  const r = new Resolver(api);
  const tool = (name, def, handler) =>
    server.registerTool(name, def, async (args) => {
      try {
        return await handler(args ?? {});
      } catch (err) {
        return errorResult(err);
      }
    });

  const limitArg = (def = cfg.defaultLimit, max = 500) => S.number().int().min(1).max(max).optional().describe(`Maximum number of results (default ${def})`);
  const fmt = (m, room) => compactMessage(m, { baseUrl: cfg.baseUrl, maxBodyChars: cfg.maxBodyChars, room, me: cfg.userId });
  /** Short room reference for responses. */
  const brief = (room) =>
    clean({
      id: room.rid ?? room._id,
      name: room.t === "d" ? `@${room.name}` : room.name,
      display_name: room.fname && room.fname !== room.name ? room.fname : undefined,
      type: ROOM_TYPES[room.t] ?? room.t,
      link: roomLink(cfg.baseUrl, { t: room.t, name: room.name, rid: room.rid ?? room._id }),
    });
  const linkRoom = (room) => ({ t: room.t, name: room.name, rid: room.rid ?? room._id });
  const visible = (includeSystem) => (m) => includeSystem || !m.t || m.t === "discussion-created";

  function history(room, { oldest, latest, count, offset }, { retry = true } = {}) {
    const path = HISTORY[room.t];
    if (!path) throw new Error(`Room type ${ROOM_TYPES[room.t] ?? room.t} is not supported.`);
    return api.get(path, { roomId: room.rid, oldest, latest, count, offset }, { retry });
  }

  /**
   * Up to `limit` visible messages (newest first). System events do not count,
   * so further pages are loaded when needed (at most maxPages calls).
   * @returns {Promise<{messages: any[], more: boolean}>}
   */
  async function visibleHistory(room, { oldest, latest, limit, keep, retry = true, maxPages = 4 }) {
    const out = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const count = page === 0 ? limit : Math.min(500, Math.max(limit * 2, 50));
      const batch = (await history(room, { oldest, latest, count, offset }, { retry })).messages ?? [];
      offset += batch.length;
      out.push(...batch.filter(keep));
      if (batch.length < count) return { messages: out.slice(0, limit), more: out.length > limit };
      if (out.length >= limit) break;
    }
    return { messages: out.slice(0, limit), more: true };
  }

  /** Subscriptions with room data, most recently active first. */
  async function subsWithRooms() {
    const [subs, rooms] = await Promise.all([r.subscriptions(), r.roomsById()]);
    const last = (x) => new Date(isoDate(x.room?.lm ?? x.room?.lastMessage?.ts ?? x.sub.ts) ?? 0).getTime();
    return subs.map((sub) => ({ sub, room: rooms.get(sub.rid) })).sort((a, b) => last(b) - last(a));
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  tool(
    "rocketchat_whoami",
    {
      title: "Current user / test connection",
      description: "Shows the user the connector acts as, the Rocket.Chat version and which write functions are enabled.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      const [me, info] = await Promise.all([api.get("/me"), api.get("/api/info").catch(() => undefined)]);
      return json({
        user: compactUser(me),
        server: clean({ url: cfg.baseUrl, version: info?.version }),
        write_permissions: cfg.allow,
      });
    },
  );

  tool(
    "rocketchat_list_rooms",
    {
      title: "List my rooms",
      description:
        "Lists channels, private groups and direct messages the user is a member of – with unread and mention counters, topic and last activity. " +
        "Public channels the user has not joined are found with rocketchat_search_directory.",
      inputSchema: {
        query: S.string().optional().describe("Part of the short or display name"),
        type: S.union([roomType, S.array(roomType)]).optional().describe("channel (public), private (group), direct (direct message)"),
        unread_only: S.boolean().optional().describe("Only rooms with unread messages or mentions"),
        favorites_only: S.boolean().optional(),
        active_since: dateStr.optional().describe("Only rooms with activity since, e.g. 'now-7d'"),
        sort_by: S.enum(["activity", "name", "unread"]).optional().describe("Default activity (most recently active first)"),
        limit: limitArg(),
      },
      annotations: READ,
    },
    async (a) => {
      let list = await subsWithRooms();
      const types = asList(a.type).map((t) => TYPE_KEYS[t]);
      if (types.length) list = list.filter((x) => types.includes(x.sub.t));
      if (a.query) {
        const q = a.query.toLowerCase();
        list = list.filter((x) => `${x.sub.name} ${x.sub.fname ?? ""}`.toLowerCase().includes(q));
      }
      if (a.unread_only) list = list.filter((x) => x.sub.unread || x.sub.userMentions || x.sub.groupMentions || x.sub.tunread?.length);
      if (a.favorites_only) list = list.filter((x) => x.sub.f);
      if (a.active_since) {
        const since = new Date(resolveDate(a.active_since)).getTime();
        list = list.filter((x) => new Date(isoDate(x.room?.lm) ?? 0).getTime() >= since);
      }
      if (a.sort_by === "name") list.sort((x, y) => (x.sub.fname ?? x.sub.name).localeCompare(y.sub.fname ?? y.sub.name));
      if (a.sort_by === "unread") list.sort((x, y) => (y.sub.userMentions ?? 0) - (x.sub.userMentions ?? 0) || (y.sub.unread ?? 0) - (x.sub.unread ?? 0));
      const limit = a.limit ?? cfg.defaultLimit;
      return json({
        total: list.length,
        has_more: list.length > limit || undefined,
        rooms: list.slice(0, limit).map(({ sub, room }) => compactRoom({ sub, room, baseUrl: cfg.baseUrl, maxBodyChars: 300 })),
      });
    },
  );

  tool(
    "rocketchat_get_room",
    {
      title: "Get room",
      description: "Loads a room with topic, description, announcement, team, the user's read state and members.",
      inputSchema: {
        room: roomArg,
        include_members: S.boolean().optional().describe("Include the member list (default true)"),
        members_limit: S.number().int().min(1).max(500).optional().describe("Maximum members (default 100)"),
      },
      annotations: READ,
    },
    async (a) => {
      const ref = await r.room(a.room);
      const info = await api.get("/rooms.info", { roomId: ref.rid });
      const room = info.room;
      const out = compactRoom({ sub: ref.sub, room, baseUrl: cfg.baseUrl, maxBodyChars: cfg.maxBodyChars });
      out.created_at = isoDate(room.ts);
      if (room.u?.username) out.created_by = `@${room.u.username}`;
      if (info.team) {
        out.team = clean({ id: info.team._id, name: info.team.name, main_room: info.parent?.name });
        delete out.team_id;
      }
      if (!ref.sub) out.member = false;
      if (a.include_members !== false && MEMBERS[room.t]) {
        try {
          const { items, total } = await api.collect(MEMBERS[room.t], "members", { roomId: ref.rid }, { max: a.members_limit ?? 100 });
          out.member_list = items.map((u) => clean({ username: u.username, name: u.name, status: u.status }));
          if (total > items.length) out.member_list_truncated = `${items.length} of ${total}`;
        } catch (err) {
          out.member_list = { error: err.message };
        }
      }
      return json(clean(out));
    },
  );

  tool(
    "rocketchat_get_messages",
    {
      title: "Messages of a room or thread",
      description:
        "Returns messages in chronological order (oldest first). Without a period, the newest `limit` messages. " +
        "filter: unread = since the user's read position; pinned/starred/mentions = pinned, starred, or messages @-mentioning the user. " +
        "With thread_id instead of room: the thread's parent message and all replies.",
      inputSchema: {
        room: roomArg.optional(),
        thread_id: S.string().optional().describe("ID of the thread's parent message"),
        filter: S.enum(["all", "unread", "pinned", "starred", "mentions"]).optional().describe("Default all"),
        since: dateStr.optional().describe("Only messages from, e.g. 'now-24h' or '2026-11-01'"),
        until: dateStr.optional(),
        include_system: S.boolean().optional().describe("Include system events (joins, topic changes …) (default false)"),
        limit: limitArg(),
      },
      annotations: READ,
    },
    async (a) => {
      const limit = a.limit ?? cfg.defaultLimit;
      const keep = visible(a.include_system);
      const since = a.since ? resolveDate(a.since) : undefined;
      const until = a.until ? resolveDate(a.until) : undefined;
      const inRange = (m) => (!since || tsOf(m) >= new Date(since).getTime()) && (!until || tsOf(m) <= new Date(until).getTime());

      if (a.thread_id) {
        const parent = (await api.get("/chat.getMessage", { msgId: a.thread_id })).message;
        if (!parent) throw new Error(`Message ${a.thread_id} not found.`);
        const room = linkRoom(await r.roomInfo(parent.rid));
        const { items, total } = await api.collect("/chat.getThreadMessages", "messages", { tmid: a.thread_id }, { max: 2000 });
        const replies = items.filter(keep).filter(inRange).sort(byTsAsc);
        return json(
          clean({
            room: brief(room),
            thread: fmt(parent, room),
            total_replies: total,
            has_more: replies.length > limit || undefined,
            // When limited, the newest replies
            replies: replies.slice(-limit).map((m) => fmt(m, room)),
          }),
        );
      }

      if (!a.room) throw new Error("Give room or thread_id.");
      const ref = await r.room(a.room);
      const room = linkRoom(ref);
      const filter = a.filter ?? "all";

      if (["pinned", "starred", "mentions"].includes(filter)) {
        const path = { pinned: "/chat.getPinnedMessages", starred: "/chat.getStarredMessages", mentions: "/chat.getMentionedMessages" }[filter];
        const { items, total } = await api.collect(path, "messages", { roomId: ref.rid, sort: { ts: -1 } }, { max: Math.max(limit, 200) });
        const msgs = items.filter(inRange).sort(byTsAsc);
        return json(clean({ room: brief(room), filter, total, has_more: msgs.length > limit || undefined, messages: msgs.slice(-limit).map((m) => fmt(m, room)) }));
      }

      let oldest = since;
      if (filter === "unread") {
        if (!ref.sub) throw new Error("No read position: the user is not a member of this room.");
        const ls = isoDate(ref.sub.ls ?? ref.sub.ts);
        if (!oldest || new Date(ls) > new Date(oldest)) oldest = ls;
      }
      const { messages: page, more } = await visibleHistory(ref, { oldest, latest: until, limit, keep });
      const msgs = page.sort(byTsAsc);
      return json(
        clean({
          room: brief(room),
          filter: filter !== "all" ? filter : undefined,
          since: oldest,
          until,
          // The API returns the newest first – more exist if the page was full
          has_more: more ? "Older messages exist – page back with until (timestamp of the oldest)." : undefined,
          messages: msgs.map((m) => fmt(m, room)),
        }),
      );
    },
  );

  tool(
    "rocketchat_list_threads",
    {
      title: "Threads of a room",
      description: "Lists threads (messages with replies) of a room, optionally only followed or unread ones. Load the content with rocketchat_get_messages and thread_id.",
      inputSchema: {
        room: roomArg,
        type: S.enum(["all", "following", "unread"]).optional().describe("Default all"),
        query: S.string().optional().describe("Text in the parent message"),
        limit: limitArg(25),
      },
      annotations: READ,
    },
    async (a) => {
      const ref = await r.room(a.room);
      const room = linkRoom(ref);
      const data = await api.get("/chat.getThreadsList", { rid: ref.rid, type: a.type === "all" ? undefined : a.type, text: a.query, count: a.limit ?? 25, sort: { tlm: -1 } });
      return json({ room: brief(room), total: data.total, threads: (data.threads ?? []).map((m) => fmt(m, room)) });
    },
  );

  tool(
    "rocketchat_search_messages",
    {
      title: "Search messages",
      description:
        "Full-text search in messages. With room in one room, otherwise across the user's most recently active rooms (max_rooms). " +
        "Supports the Rocket.Chat search syntax, e.g. 'from:username', 'mention:username', 'has:url', 'is:pinned', 'has:star', 'before:DD/MM/YYYY', 'after:DD/MM/YYYY'.",
      inputSchema: {
        query: S.string().min(1).describe("Search term(s)"),
        room: roomArg.optional(),
        type: S.union([roomType, S.array(roomType)]).optional().describe("Search only rooms of these types"),
        max_rooms: S.number().int().min(1).max(200).optional().describe("Without room: number of most recently active rooms to search (default 25)"),
        active_since: dateStr.optional().describe("Without room: only rooms with activity since, e.g. 'now-30d'"),
        limit: limitArg(30),
      },
      annotations: READ,
    },
    async (a) => {
      const limit = a.limit ?? 30;
      const searchText = normalizeSearch(a.query);
      const search = async (ref) => {
        const data = await api.get("/chat.search", { roomId: ref.rid, searchText, count: limit }, { retry: !!a.room });
        return (data.messages ?? []).map((m) => ({ m, ref }));
      };
      if (a.room) {
        const ref = await r.room(a.room);
        const hits = await search(ref);
        return json({ room: brief(ref), count: hits.length, messages: hits.map(({ m }) => fmt(m, linkRoom(ref))) });
      }
      let list = await subsWithRooms();
      const types = asList(a.type).map((t) => TYPE_KEYS[t]);
      if (types.length) list = list.filter((x) => types.includes(x.sub.t));
      if (a.active_since) {
        const since = new Date(resolveDate(a.active_since)).getTime();
        list = list.filter((x) => new Date(isoDate(x.room?.lm) ?? 0).getTime() >= since);
      }
      const maxRooms = a.max_rooms ?? 25;
      const searched = list.slice(0, maxRooms).map((x) => ({ rid: x.sub.rid, t: x.sub.t, name: x.sub.name, fname: x.sub.fname }));
      const { results, errors, skipped } = await perRoom(searched, search);
      const hits = results.flat().sort((x, y) => tsOf(y.m) - tsOf(x.m));
      return json(
        clean({
          searched_rooms: searched.length - skipped.length,
          rate_limited: RATE_NOTE(skipped.length),
          rooms_skipped: skipped,
          not_searched_rooms: list.length - searched.length || undefined,
          count: hits.length,
          has_more: hits.length > limit || undefined,
          messages: hits.slice(0, limit).map(({ m, ref }) => ({ room: ref.t === "d" ? `@${ref.name}` : ref.name, ...fmt(m, linkRoom(ref)) })),
          errors,
        }),
      );
    },
  );

  tool(
    "rocketchat_unread_overview",
    {
      title: "Unread overview",
      description:
        "All rooms with unread messages, mentions or unread thread replies, including the unread messages themselves – " +
        "the basis for digests and scheduled reports. Does not mark anything as read.",
      inputSchema: {
        type: S.union([roomType, S.array(roomType)]).optional(),
        include_messages: S.boolean().optional().describe("Include the unread messages (default true)"),
        per_room_limit: S.number().int().min(1).max(200).optional().describe("Maximum messages per room (default 15, newest kept)"),
        max_rooms: S.number().int().min(1).max(200).optional().describe("Maximum rooms with message content (default 30)"),
        include_system: S.boolean().optional(),
      },
      annotations: READ,
    },
    async (a) => {
      let list = (await subsWithRooms()).filter(({ sub }) => sub.unread || sub.userMentions || sub.groupMentions || sub.tunread?.length);
      const types = asList(a.type).map((t) => TYPE_KEYS[t]);
      if (types.length) list = list.filter((x) => types.includes(x.sub.t));
      // Mentions, then direct messages, then by count
      const prio = ({ sub }) => (sub.userMentions ? 0 : sub.t === "d" ? 1 : sub.groupMentions ? 2 : 3);
      list.sort((x, y) => prio(x) - prio(y) || (y.sub.unread ?? 0) - (x.sub.unread ?? 0));

      const perRoomLimit = a.per_room_limit ?? 15;
      const maxRooms = a.max_rooms ?? 30;
      const keep = visible(a.include_system);
      const rooms = list.map(({ sub, room }) => {
        const out = compactRoom({ sub, room, baseUrl: cfg.baseUrl, maxBodyChars: 300 });
        delete out.last_seen;
        if (sub.tunread?.length) out.unread_thread_ids = sub.tunread;
        return out;
      });
      const withMessages = a.include_messages === false ? [] : list.map((x, idx) => ({ ...x, idx })).filter((x) => x.sub.unread).slice(0, maxRooms);
      const targets = withMessages.map(({ sub, idx }) => ({ rid: sub.rid, t: sub.t, name: sub.name, sub, idx }));
      const { errors, skipped } = await perRoom(targets, async (ref) => {
        const { sub, idx } = ref;
        const { messages: page } = await visibleHistory(ref, { oldest: isoDate(sub.ls ?? sub.ts), limit: Math.min(perRoomLimit, Math.max(sub.unread, 1)), keep, retry: false, maxPages: 2 });
        const msgs = page.sort(byTsAsc);
        rooms[idx].messages = msgs.map((m) => fmt(m, ref));
        if (sub.unread > msgs.length) rooms[idx].messages_truncated = `${msgs.length} of ${sub.unread} unread (newest)`;
      });
      const sum = (f) => list.reduce((n, x) => n + (f(x.sub) ?? 0), 0);
      return json(
        clean({
          summary: {
            rooms: list.length,
            unread_messages: sum((s) => s.unread),
            mentions: sum((s) => s.userMentions),
            group_mentions: sum((s) => s.groupMentions),
            unread_threads: sum((s) => s.tunread?.length),
            direct_messages: list.filter((x) => x.sub.t === "d").length,
          },
          note: withMessages.length < list.filter((x) => x.sub.unread).length && a.include_messages !== false ? `Message content only for the first ${maxRooms} rooms (increase max_rooms for more).` : undefined,
          rate_limited: RATE_NOTE(skipped.length),
          errors,
          rooms,
        }),
      );
    },
  );

  tool(
    "rocketchat_list_mentions",
    {
      title: "Mentions of the user",
      description:
        "Messages that mention the user by @username – across all of the user's rooms (or one room), read or unread. " +
        "@all/@here are not included.",
      inputSchema: {
        since: dateStr.optional().describe("Default now-7d"),
        room: roomArg.optional(),
        limit: limitArg(50),
      },
      annotations: READ,
    },
    async (a) => {
      const since = resolveDate(a.since ?? "now-7d");
      const sinceMs = new Date(since).getTime();
      const limit = a.limit ?? 50;
      let targets;
      if (a.room) {
        targets = [await r.room(a.room)];
      } else {
        // Only rooms with activity in the period; direct messages have no mentions
        targets = (await subsWithRooms())
          .filter(({ sub, room }) => sub.t !== "d" && new Date(isoDate(room?.lm) ?? 0).getTime() >= sinceMs)
          .map(({ sub }) => ({ rid: sub.rid, t: sub.t, name: sub.name, fname: sub.fname }));
      }
      const { results, errors, skipped } = await perRoom(targets, async (ref) => {
        const data = await api.get("/chat.getMentionedMessages", { roomId: ref.rid, count: limit, sort: { ts: -1 } }, { retry: !!a.room });
        return (data.messages ?? []).filter((m) => tsOf(m) >= sinceMs).map((m) => ({ m, ref }));
      });
      const hits = results.flat().sort((x, y) => tsOf(y.m) - tsOf(x.m));
      return json(
        clean({
          since,
          searched_rooms: targets.length - skipped.length,
          rate_limited: RATE_NOTE(skipped.length),
          rooms_skipped: skipped,
          count: hits.length,
          has_more: hits.length > limit || undefined,
          mentions: hits.slice(0, limit).map(({ m, ref }) => ({ room: ref.name, ...fmt(m, linkRoom(ref)) })),
          errors,
        }),
      );
    },
  );

  tool(
    "rocketchat_search_directory",
    {
      title: "Search directory",
      description: "Searches users, public channels or teams in the server directory – including ones the user has not joined.",
      inputSchema: {
        query: S.string().optional().describe("Name, username or channel name (empty: all)"),
        type: S.enum(["users", "channels", "teams"]).optional().describe("Default users"),
        limit: limitArg(25, 100),
        page: S.number().int().min(1).optional(),
      },
      annotations: READ,
    },
    async (a) => {
      const limit = a.limit ?? 25;
      const page = a.page ?? 1;
      const type = a.type ?? "users";
      const data = await api.get("/directory", { type, text: a.query, count: limit, offset: (page - 1) * limit, sort: type === "users" ? { username: 1 } : { name: 1 } });
      const result = data.result ?? [];
      const items =
        type === "users"
          ? result.map((u) => clean({ id: u._id, username: u.username, name: u.name, status: u.status, email: u.emails?.[0]?.address }))
          : result.map((x) =>
              clean({
                id: x._id,
                name: x.name,
                display_name: x.fname !== x.name ? x.fname : undefined,
                type: ROOM_TYPES[x.t] ?? x.t,
                topic: x.topic,
                members: x.usersCount,
                team: x.belongsTo,
                created_at: isoDate(x.ts),
                last_message: isoDate(x.lastMessage?.ts),
                link: roomLink(cfg.baseUrl, x),
              }),
            );
      return json({ type, total: data.total, page, has_more: page * limit < (data.total ?? 0), [type]: items });
    },
  );

  tool(
    "rocketchat_get_user",
    {
      title: "Get user",
      description: "Details of a user (name, status, roles, last login) and, if present, the ID of the direct message with them.",
      inputSchema: { user: S.string().describe("Username (with or without @), user ID or 'me'") },
      annotations: READ,
    },
    async (a) => {
      const u = await r.user(a.user);
      const dm = (await r.subscriptions()).find((s) => s.t === "d" && s.name === u.username);
      return json(clean({ ...compactUser(u), direct_message_room: dm?.rid }));
    },
  );

  tool(
    "rocketchat_api_get",
    {
      title: "Raw GET request",
      description:
        "Read-only raw access to endpoints below /api/v1 (e.g. '/rooms.getDiscussions', '/teams.list', '/chat.getMessageReadReceipts', '/emoji-custom.list'). " +
        "Use only when no specialized tool fits.",
      inputSchema: {
        path: S.string().regex(/^\/[A-Za-z0-9_.\-/]*$/, "Path relative to /api/v1, starting with /").describe("e.g. '/teams.list'"),
        params: S.record().optional().describe('Query parameters, e.g. {"roomId": "…", "count": 20}'),
      },
      annotations: READ,
    },
    async (a) => {
      if (a.path.includes("..")) throw new Error("Invalid path.");
      return json(await api.get(a.path, a.params));
    },
  );

  // -------------------------------------------------------------------------
  // Write: send messages
  // -------------------------------------------------------------------------

  if (cfg.allow.send) {
    tool(
      "rocketchat_send_message",
      {
        title: "Send message",
        description:
          "Sends a message on behalf of the user to a room, as a direct message ('@username', created if needed) or as a reply in a thread. " +
          "Visible to all room members and triggers notifications – only when explicitly asked and with text the user has confirmed.",
        inputSchema: {
          room: roomArg.optional().describe("Target room; optional with thread_id"),
          text: S.string().min(1).describe("Message text (Markdown, @mentions allowed)"),
          thread_id: S.string().optional().describe("Reply in this thread (ID of the parent message)"),
          also_send_to_room: S.boolean().optional().describe("Also show the thread reply in the room (default false)"),
        },
        annotations: CREATE,
      },
      async (a) => {
        let ref;
        if (a.thread_id) {
          const parent = (await api.get("/chat.getMessage", { msgId: a.thread_id })).message;
          if (!parent) throw new Error(`Thread ${a.thread_id} not found.`);
          if (a.room) {
            ref = await r.room(a.room);
            if (ref.rid !== parent.rid) throw new Error("thread_id does not belong to this room.");
          } else {
            ref = linkRoom(await r.roomInfo(parent.rid));
          }
        } else {
          if (!a.room) throw new Error("Give room or thread_id.");
          ref = await r.room(a.room, { createDm: true });
        }
        const message = clean({ rid: ref.rid, msg: a.text, tmid: a.thread_id, tshow: a.thread_id && a.also_send_to_room ? true : undefined });
        const res = await api.post("/chat.sendMessage", { message });
        return json({ sent: true, room: brief(ref), message: fmt(res.message, linkRoom(ref)) });
      },
    );
  }

  // -------------------------------------------------------------------------
  // Write: reactions, read state, pin/star
  // -------------------------------------------------------------------------

  if (cfg.allow.reactions) {
    tool(
      "rocketchat_react",
      {
        title: "Add or remove reaction",
        description: "Adds (or removes) an emoji reaction of the user on a message.",
        inputSchema: {
          message_id: S.string(),
          emoji: S.string().describe("Emoji short name, e.g. ':+1:', 'white_check_mark', 'eyes'"),
          remove: S.boolean().optional().describe("Remove the reaction instead of adding it"),
        },
        annotations: MARK,
      },
      async (a) => {
        const emoji = normalizeEmoji(a.emoji);
        await api.post("/chat.react", { messageId: a.message_id, emoji, shouldReact: !a.remove });
        return json({ ok: true, message_id: a.message_id, emoji, action: a.remove ? "removed" : "added" });
      },
    );

    tool(
      "rocketchat_mark_read",
      {
        title: "Mark as read",
        description: "Marks one or more rooms (or all rooms with unread messages) as read. Only when explicitly asked.",
        inputSchema: {
          rooms: S.union([roomArg, S.array(roomArg)]).optional().describe("Room or rooms"),
          all_unread: S.boolean().optional().describe("All rooms with unread messages"),
        },
        annotations: MARK,
      },
      async (a) => {
        let refs;
        if (a.all_unread) {
          refs = (await r.subscriptions()).filter((s) => s.unread || s.userMentions || s.groupMentions || s.alert).map((s) => ({ rid: s.rid, t: s.t, name: s.name }));
        } else {
          const list = asList(a.rooms);
          if (!list.length) throw new Error("Give rooms or all_unread.");
          refs = await Promise.all(list.map((x) => r.room(x)));
        }
        const done = [];
        const errors = [];
        await mapLimit(refs, 4, async (ref) => {
          try {
            await api.post("/subscriptions.read", { rid: ref.rid });
            done.push(ref.t === "d" ? `@${ref.name}` : ref.name);
          } catch (err) {
            errors.push(`${ref.name}: ${err.message}`);
          }
        });
        r.invalidate();
        return json(clean({ marked_read: done, errors }));
      },
    );

    tool(
      "rocketchat_flag_message",
      {
        title: "Pin or star message",
        description: "Pins a message in its room (pin, visible to everyone) or unpins it, or stars it (star, only for the user).",
        inputSchema: {
          message_id: S.string(),
          action: S.enum(["pin", "unpin", "star", "unstar"]),
        },
        annotations: MARK,
      },
      async (a) => {
        const path = { pin: "/chat.pinMessage", unpin: "/chat.unPinMessage", star: "/chat.starMessage", unstar: "/chat.unStarMessage" }[a.action];
        await api.post(path, { messageId: a.message_id });
        return json({ ok: true, message_id: a.message_id, action: a.action });
      },
    );
  }

  // -------------------------------------------------------------------------
  // Write: edit own messages
  // -------------------------------------------------------------------------

  if (cfg.allow.edit) {
    tool(
      "rocketchat_update_message",
      {
        title: "Edit own message",
        description: "Replaces the text of one of the user's own messages (shown as edited). Messages of other users are never changed.",
        inputSchema: {
          message_id: S.string(),
          text: S.string().min(1).describe("New complete text"),
        },
        annotations: UPDATE,
      },
      async (a) => {
        const msg = (await api.get("/chat.getMessage", { msgId: a.message_id })).message;
        if (!msg) throw new Error(`Message ${a.message_id} not found.`);
        if (msg.u?._id !== cfg.userId) throw new Error(`Message ${a.message_id} was written by @${msg.u?.username} – only your own messages can be edited.`);
        const res = await api.post("/chat.update", { roomId: msg.rid, msgId: a.message_id, text: a.text });
        const room = linkRoom(await r.roomInfo(msg.rid));
        return json({ updated: true, previous_text: msg.msg, message: fmt(res.message ?? { ...msg, msg: a.text }, room) });
      },
    );
  }

  // -------------------------------------------------------------------------
  // Write: create rooms, invite, set topic
  // -------------------------------------------------------------------------

  if (cfg.allow.rooms) {
    const roomSettings = async (ref, { topic, description, announcement }) => {
      const prefix = PREFIX[ref.t];
      if (!prefix) throw new Error("Topic and description can only be set for channels and private groups.");
      const changed = [];
      const fields = [
        ["topic", "setTopic", topic],
        ["description", "setDescription", description],
        ["announcement", "setAnnouncement", announcement],
      ];
      for (const [key, method, value] of fields) {
        if (value === undefined) continue;
        await api.post(`/${prefix}.${method}`, { roomId: ref.rid, [key]: value });
        changed.push(key);
      }
      return changed;
    };

    tool(
      "rocketchat_create_room",
      {
        title: "Create room",
        description: "Creates a private group (default) or a public channel, invites members and optionally sets topic and description.",
        inputSchema: {
          name: S.string().min(1).describe("Short name of the room, e.g. 'project-wifi-2027' (allowed characters depend on the server settings)"),
          private: S.boolean().optional().describe("Private group (default true); false = public channel"),
          members: S.array(S.string()).optional().describe("Usernames of the members"),
          topic: S.string().optional(),
          description: S.string().optional(),
          read_only: S.boolean().optional().describe("Only moderators/owners may post"),
        },
        annotations: CREATE,
      },
      async (a) => {
        const isPrivate = a.private !== false;
        const members = asList(a.members).map((m) => m.replace(/^@/, ""));
        const res = await api.post(`/${isPrivate ? "groups" : "channels"}.create`, clean({ name: a.name, members, readOnly: a.read_only || undefined }));
        const created = res.group ?? res.channel;
        r.invalidate();
        const ref = { rid: created._id, t: created.t, name: created.name };
        let settings;
        try {
          settings = await roomSettings(ref, { topic: a.topic, description: a.description });
        } catch (err) {
          settings = { error: err.message };
        }
        return json(clean({ created: true, room: brief(ref), members: created.usernames, settings }));
      },
    );

    tool(
      "rocketchat_invite_users",
      {
        title: "Invite users to room",
        description: "Adds users to a channel or private group (they are notified).",
        inputSchema: {
          room: roomArg,
          users: S.array(S.string()).min(1).describe("Usernames (with or without @) or IDs"),
        },
        annotations: MARK,
      },
      async (a) => {
        const ref = await r.room(a.room);
        const prefix = PREFIX[ref.t];
        if (!prefix) throw new Error("Users can only be invited to channels and private groups.");
        const invited = [];
        const errors = [];
        for (const name of a.users) {
          try {
            const u = await r.user(name);
            await api.post(`/${prefix}.invite`, { roomId: ref.rid, userId: u._id });
            invited.push(`@${u.username}`);
          } catch (err) {
            errors.push(`${name}: ${err.message}`);
          }
        }
        return json(clean({ room: brief(ref), invited, errors }));
      },
    );

    tool(
      "rocketchat_update_room",
      {
        title: "Set topic, description, announcement",
        description: "Changes topic, description and/or announcement of a channel or private group (empty text clears the field).",
        inputSchema: {
          room: roomArg,
          topic: S.string().optional(),
          description: S.string().optional(),
          announcement: S.string().optional(),
        },
        annotations: UPDATE,
      },
      async (a) => {
        if (a.topic === undefined && a.description === undefined && a.announcement === undefined) throw new Error("Nothing to change.");
        const ref = await r.room(a.room);
        const changed = await roomSettings(ref, a);
        r.invalidate();
        return json({ room: brief(ref), changed });
      },
    );
  }
}
