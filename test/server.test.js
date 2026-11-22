// Tests against a simulated Rocket.Chat server (no real access needed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../plugin/server/server.js";
import { loadConfig } from "../plugin/server/config.js";
import { normalizeEmoji, normalizeSearch } from "../plugin/server/tools.js";
import { compactMessage, resolveDate, roomLink } from "../plugin/server/format.js";
import { rpcClient } from "./rpc-client.js";

const USER_ID = "Me0000000000000001";
const TOKEN = "test-token";
const calls = [];
const me = { _id: USER_ID, username: "anna", name: "Anna Agent", status: "online", roles: ["user"], emails: [{ address: "anna@x.de" }], utcOffset: 1 };
const u = (username, name, _id = `U-${username}`) => ({ _id, username, name });

const subs = [
  { rid: "ROOM_OPS", t: "p", name: "ops", fname: "Ops", unread: 3, userMentions: 1, groupMentions: 0, ls: "2026-11-20T10:00:00.000Z", ts: "2026-01-01T00:00:00.000Z", tunread: ["T1"], f: true, open: true },
  { rid: "ROOM_TOWN", t: "c", name: "town-square", fname: "Allgemein", unread: 0, userMentions: 0, ls: "2026-11-21T10:00:00.000Z", open: true },
  { rid: "ROOM_DM", t: "d", name: "max", fname: "Max Muster", unread: 1, userMentions: 0, ls: "2026-11-19T10:00:00.000Z", open: true },
  { rid: "ROOM_P1", t: "p", name: "projekt-a", fname: "Projekt", unread: 0, open: true },
  { rid: "ROOM_P2", t: "p", name: "projekt-b", fname: "Projekt", unread: 0, open: false },
];
const rooms = [
  { _id: "ROOM_OPS", t: "p", name: "ops", fname: "Ops", topic: "Betrieb", usersCount: 9, msgs: 800, lm: "2026-11-21T09:00:00.000Z", teamId: "TEAM1" },
  { _id: "ROOM_TOWN", t: "c", name: "town-square", fname: "Allgemein", usersCount: 38, lm: "2026-11-21T12:00:00.000Z" },
  { _id: "ROOM_DM", t: "d", usernames: ["anna", "max"], lm: "2026-11-20T08:00:00.000Z" },
  { _id: "ROOM_P1", t: "p", name: "projekt-a", fname: "Projekt", lm: "2025-01-01T00:00:00.000Z" },
  { _id: "ROOM_P2", t: "p", name: "projekt-b", fname: "Projekt", lm: "2025-01-01T00:00:00.000Z" },
];
const msg = (id, rid, text, ts, over = {}) => ({ _id: id, rid, msg: text, ts, u: u("max", "Max Muster"), _updatedAt: ts, ...over });
const opsMessages = [
  // The API returns the newest first
  msg("M3", "ROOM_OPS", "@anna bitte prüfen", "2026-11-21T09:00:00.000Z", { mentions: [{ _id: USER_ID, username: "anna" }], reactions: { ":+1:": { usernames: ["max"], names: ["Max Muster"] } } }),
  msg("M2", "ROOM_OPS", "max", "2026-11-21T08:30:00.000Z", { t: "au" }),
  msg("M1", "ROOM_OPS", "​", "2026-11-21T08:00:00.000Z", {
    u: u("monitoring", "Monitoring"),
    bot: { i: "x" },
    attachments: [{ title: "OpenProject: Up", title_link: "/file-upload/abc/log.txt", text: "200 - OK" }],
  }),
];
const own = msg("OWN1", "ROOM_OPS", "Eigener Text", "2026-11-21T07:00:00.000Z", { u: u("anna", "Anna Agent", USER_ID), tcount: 2 });

let mock;
let baseUrl;
let rateLimitOnce = true;

function send(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(data));
}
const fail = (res, status, error, errorType) => send(res, status, { success: false, error, ...(errorType ? { errorType } : {}) });
const ok = (res, data) => send(res, 200, { ...data, success: true });

before(async () => {
  mock = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://x");
    const q = Object.fromEntries(url.searchParams);
    const json = body ? JSON.parse(body) : undefined;
    calls.push({ method: req.method, path: url.pathname, query: q, body: json, headers: req.headers });
    if (url.pathname === "/api/info") return ok(res, { version: "9.0.0" });
    if (req.headers["x-user-id"] !== USER_ID || req.headers["x-auth-token"] !== TOKEN) return fail(res, 401, "You must be logged in to do this.");
    const p = url.pathname.replace("/api/v1", "");
    const G = req.method === "GET";

    if (p === "/me") return ok(res, me);
    if (p === "/subscriptions.get") return ok(res, { update: subs, remove: [] });
    if (p === "/rooms.get") return ok(res, { update: rooms, remove: [] });
    if (p === "/rooms.info") {
      const room = rooms.find((r) => r._id === q.roomId || (q.roomName && r.name === q.roomName));
      if (room) return ok(res, { room, ...(room.teamId ? { team: { _id: "TEAM1", name: "DevOps" }, parent: { name: "DevOps" } } : {}) });
      if (q.roomName === "public-news" || q.roomId === "ROOM_NEWS") return ok(res, { room: { _id: "ROOM_NEWS", t: "c", name: "public-news", fname: "News", usersCount: 100 } });
      return fail(res, 400, 'The required "roomId" or "roomName" param provided does not match any channel [error-room-not-found]', "error-room-not-found");
    }
    if (p === "/groups.history" && q.roomId === "ROOM_OPS") return ok(res, { messages: opsMessages.slice(Number(q.offset ?? 0), Number(q.offset ?? 0) + Number(q.count ?? 20)) });
    if (p === "/im.history") return ok(res, { messages: [msg("D1", "ROOM_DM", "Hallo Anna", "2026-11-20T08:00:00.000Z")] });
    if (p === "/channels.history" || p === "/groups.history") return ok(res, { messages: [] });
    if (p === "/groups.members") return ok(res, { members: [u("anna", "Anna Agent"), u("max", "Max Muster")], total: 9, count: 2, offset: 0 });
    if (p === "/chat.getMessage") {
      const m = [...opsMessages, own].find((x) => x._id === q.msgId);
      return m ? ok(res, { message: m }) : fail(res, 400, "Message not found");
    }
    if (p === "/chat.getThreadMessages") return ok(res, { messages: [msg("R2", "ROOM_OPS", "zweite", "2026-11-21T07:20:00.000Z", { tmid: q.tmid }), msg("R1", "ROOM_OPS", "erste", "2026-11-21T07:10:00.000Z", { tmid: q.tmid })], total: 2, count: 2, offset: 0 });
    if (p === "/chat.getThreadsList") {
      if (q.type === "all") return fail(res, 400, "must be equal to one of the allowed values", "error-invalid-params");
      return ok(res, { threads: [own], total: 1 });
    }
    if (p === "/chat.search") {
      // Simulates the rate limit of a non-admin: 429 from the third room on, with a reset far in the future
      const n = calls.filter((c) => c.path.endsWith("/chat.search") && c.query.searchText === q.searchText).length;
      if (q.searchText === "limit" && n > 2) return send(res, 429, { success: false, error: "Error, too many requests." }, { "x-ratelimit-reset": String(Date.now() + 3600e3) });
      return ok(res, { messages: q.roomId === "ROOM_OPS" ? [opsMessages[0]] : q.roomId === "ROOM_TOWN" ? [msg("S1", "ROOM_TOWN", "Treffer", "2026-11-21T11:00:00.000Z")] : [] });
    }
    if (p === "/chat.getMentionedMessages") {
      return ok(res, { messages: q.roomId === "ROOM_OPS" ? [opsMessages[0], msg("OLD", "ROOM_OPS", "@anna alt", "2025-01-01T00:00:00.000Z")] : [], total: 2 });
    }
    if (p === "/chat.getPinnedMessages") return ok(res, { messages: [msg("PIN", "ROOM_OPS", "Wichtig", "2026-10-01T00:00:00.000Z", { pinned: true })], total: 1 });
    if (p === "/directory") return ok(res, { result: [{ _id: "U-max", username: "max", name: "Max Muster", emails: [{ address: "max@x.de" }] }], total: 1, count: 1, offset: 0 });
    if (p === "/users.info") {
      if (q.username === "max" || q.userId === "U-max") return ok(res, { user: { ...u("max", "Max Muster"), roles: ["user"], status: "away" } });
      if (q.username === "neu") return ok(res, { user: u("neu", "Neue Person") });
      return fail(res, 400, "User not found.", "error-invalid-user");
    }
    if (p === "/teams.list") {
      if (rateLimitOnce) {
        rateLimitOnce = false;
        return send(res, 429, { success: false, error: "Error, too many requests." }, { "x-ratelimit-reset": String(Date.now() + 50) });
      }
      return ok(res, { teams: [], total: 0 });
    }

    // Write
    if (!G && p === "/chat.sendMessage") return ok(res, { message: { _id: "NEW", ts: "2026-11-21T12:00:00.000Z", u: u("anna", "Anna Agent", USER_ID), ...json.message } });
    if (!G && p === "/im.create") return ok(res, { room: { _id: "ROOM_DM_NEU", rid: "ROOM_DM_NEU", t: "d", usernames: ["anna", json.username] } });
    if (!G && ["/chat.react", "/subscriptions.read", "/chat.pinMessage", "/chat.starMessage", "/groups.setTopic", "/groups.setDescription", "/groups.invite"].includes(p)) return ok(res, {});
    if (!G && p === "/chat.update") return ok(res, { message: { ...own, msg: json.text, editedAt: "2026-11-21T12:00:00.000Z" } });
    if (!G && p === "/groups.create") return ok(res, { group: { _id: "ROOM_NEW", t: "p", name: json.name, usernames: ["anna", ...(json.members ?? [])] } });
    fail(res, 404, `not found: ${req.method} ${p}`);
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${mock.address().port}`;
});

after(() => mock.close());

async function connect(env = {}) {
  const cfg = loadConfig({ ROCKETCHAT_URL: baseUrl + "/api/v1/", ROCKETCHAT_USER_ID: USER_ID, ROCKETCHAT_AUTH_TOKEN: TOKEN, ...env });
  const client = await rpcClient(createServer(cfg));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return { error: r.isError, text, data: r.isError ? undefined : JSON.parse(text) };
  };
  return { client, call };
}
const ALL = { ROCKETCHAT_ALLOW_EDIT: "true", ROCKETCHAT_ALLOW_ROOMS: "true" };
const last = (method, pathEnd) => calls.filter((c) => c.method === method && c.path.endsWith(pathEnd)).at(-1);

test("config: placeholders, URL normalization, write groups", () => {
  const c = loadConfig({ ROCKETCHAT_URL: "https://chat.example.org/api/v1/", ROCKETCHAT_USER_ID: "x", ROCKETCHAT_AUTH_TOKEN: "y", ROCKETCHAT_DEFAULT_LIMIT: "${user_config.default_limit}" });
  assert.equal(c.baseUrl, "https://chat.example.org");
  assert.equal(c.defaultLimit, 50);
  assert.deepEqual(c.allow, { send: true, reactions: true, edit: false, rooms: false });
  const ro = loadConfig({ ROCKETCHAT_URL: "https://x", ROCKETCHAT_USER_ID: "x", ROCKETCHAT_AUTH_TOKEN: "y", ROCKETCHAT_READ_ONLY: "true", ROCKETCHAT_ALLOW_ROOMS: "true" });
  assert.deepEqual(ro.allow, { send: false, reactions: false, edit: false, rooms: false });
  assert.equal(loadConfig({ ROCKETCHAT_URL: "https://x", ROCKETCHAT_USER_ID: "x", ROCKETCHAT_AUTH_TOKEN: "y", ROCKETCHAT_ALLOW_SEND: "false" }).allow.send, false);
  assert.equal(loadConfig({}).errors.length, 3);
});

test("formatting: dates, search, emoji, messages", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  assert.equal(resolveDate("now-24h", now), "2026-11-20T12:00:00.000Z");
  assert.equal(resolveDate("now-30m", now), "2026-11-21T11:30:00.000Z");
  assert.throws(() => resolveDate("yesterday"));
  assert.equal(normalizeSearch("from:@max mention:@anna WLAN"), "from:max mention:anna WLAN");
  assert.equal(normalizeEmoji("+1"), ":+1:");
  assert.equal(normalizeEmoji(":eyes:"), ":eyes:");
  assert.equal(roomLink("https://c", { t: "p", name: "ops" }), "https://c/group/ops");
  assert.equal(roomLink("https://c", { t: "d", rid: "R" }), "https://c/direct/R");

  const room = { t: "p", name: "ops" };
  const bot = compactMessage(opsMessages[2], { baseUrl: "https://c", room });
  assert.equal(bot.text, undefined);
  assert.equal(bot.bot, true);
  assert.equal(bot.attachments[0].link, "https://c/file-upload/abc/log.txt");
  assert.equal(compactMessage(opsMessages[1], { baseUrl: "https://c" }).system, "added @max");
  const m = compactMessage(opsMessages[0], { baseUrl: "https://c", room, me: USER_ID });
  assert.equal(m.mentions_me, true);
  assert.deepEqual(m.reactions, { ":+1:": ["Max Muster"] });
  assert.equal(m.link, "https://c/group/ops?msg=M3");
});

test("tool list depends on the enabled groups", async () => {
  const names = async (env) => (await (await connect(env)).client.listTools()).tools.map((t) => t.name);
  const def = await names();
  assert.equal(def.length, 15);
  assert.ok(def.includes("rocketchat_send_message") && def.includes("rocketchat_mark_read"));
  assert.ok(!def.includes("rocketchat_update_message") && !def.includes("rocketchat_create_room"));
  assert.equal((await names({ ROCKETCHAT_READ_ONLY: "true" })).length, 11);
  assert.equal((await names(ALL)).length, 19);
  assert.equal((await names({ ...ALL, ROCKETCHAT_ALLOW_SEND: "false", ROCKETCHAT_ALLOW_REACTIONS: "false" })).length, 15);
});

test("whoami with X-User-Id/X-Auth-Token", async () => {
  const { call } = await connect();
  const r = await call("rocketchat_whoami");
  assert.equal(r.data.user.username, "anna");
  assert.equal(r.data.server.version, "9.0.0");
  assert.equal(last("GET", "/me").headers["x-auth-token"], TOKEN);
  const bad = await (await connect({ ROCKETCHAT_AUTH_TOKEN: "wrong" })).call("rocketchat_whoami");
  assert.ok(bad.error);
  assert.match(bad.text, /401.*restart Claude/s);
});

test("list and resolve rooms", async () => {
  const { call } = await connect();
  const list = await call("rocketchat_list_rooms");
  assert.equal(list.data.total, 5);
  assert.deepEqual(list.data.rooms.map((x) => x.id).slice(0, 3), ["ROOM_TOWN", "ROOM_OPS", "ROOM_DM"]);
  assert.equal(list.data.rooms[2].name, "@max");
  const unread = await call("rocketchat_list_rooms", { unread_only: true, sort_by: "unread" });
  assert.deepEqual(unread.data.rooms.map((x) => x.id), ["ROOM_OPS", "ROOM_DM"]);
  assert.equal((await call("rocketchat_list_rooms", { type: "direct" })).data.total, 1);

  const ops = await call("rocketchat_get_room", { room: "Ops" });
  assert.equal(ops.data.id, "ROOM_OPS");
  assert.deepEqual(ops.data.team, { id: "TEAM1", name: "DevOps", main_room: "DevOps" });
  assert.equal(ops.data.member_list_truncated, "2 of 9");
  assert.equal((await call("rocketchat_get_room", { room: "#ops", include_members: false })).data.member_list, undefined);
  const pub = await call("rocketchat_get_room", { room: "public-news", include_members: false });
  assert.equal(pub.data.member, false);
  assert.match((await call("rocketchat_get_room", { room: "Projekt" })).text, /ambiguous.*projekt-a.*projekt-b/);
  assert.match((await call("rocketchat_get_room", { room: "proj" })).text, /not found.*Similar rooms: projekt-a, projekt-b/);
  assert.match((await call("rocketchat_get_room", { room: "@nobody" })).text, /No direct message/);
});

test("messages: chronological, without system events, unread, thread, pinned", async () => {
  const { call } = await connect();
  const r = await call("rocketchat_get_messages", { room: "ops", limit: 3 });
  assert.deepEqual(r.data.messages.map((m) => m.id), ["M1", "M3"]);
  assert.equal(r.data.has_more, undefined);
  // System events do not count against the limit: a second page is loaded
  const two = await call("rocketchat_get_messages", { room: "ops", limit: 2 });
  assert.deepEqual(two.data.messages.map((m) => m.id), ["M1", "M3"]);
  const one = await call("rocketchat_get_messages", { room: "ops", limit: 1 });
  assert.equal(one.data.messages.length, 1);
  assert.ok(one.data.has_more);
  assert.equal((await call("rocketchat_get_messages", { room: "ops", include_system: true })).data.messages.length, 3);

  await call("rocketchat_get_messages", { room: "ops", filter: "unread", since: "2026-01-01" });
  assert.equal(last("GET", "/groups.history").query.oldest, "2026-11-20T10:00:00.000Z");
  const dm = await call("rocketchat_get_messages", { room: "@max", since: "now-30d" });
  assert.equal(dm.data.room.link, `${baseUrl}/direct/ROOM_DM`);

  const t = await call("rocketchat_get_messages", { thread_id: "OWN1" });
  assert.equal(t.data.thread.text, "Eigener Text");
  assert.deepEqual(t.data.replies.map((m) => m.id), ["R1", "R2"]);
  assert.equal(t.data.room.name, "ops");

  const pin = await call("rocketchat_get_messages", { room: "ops", filter: "pinned" });
  assert.equal(pin.data.messages[0].pinned, true);

  const th = await call("rocketchat_list_threads", { room: "ops" });
  assert.equal(th.data.total, 1);
  assert.equal(last("GET", "/chat.getThreadsList").query.type, undefined);
});

test("search across rooms with rate limiting", async () => {
  const { call } = await connect();
  const one = await call("rocketchat_search_messages", { query: "from:@max", room: "ops" });
  assert.equal(last("GET", "/chat.search").query.searchText, "from:max");
  assert.equal(one.data.count, 1);

  const all = await call("rocketchat_search_messages", { query: "Treffer" });
  assert.equal(all.data.searched_rooms, 5);
  assert.deepEqual(all.data.messages.map((m) => m.room), ["town-square", "ops"]);

  const limited = await call("rocketchat_search_messages", { query: "limit" });
  assert.ok(limited.data.searched_rooms < 5);
  assert.match(limited.data.rate_limited, /rate limit/);
  assert.ok(limited.data.rooms_skipped.length >= 1);
});

test("unread overview and mentions", async () => {
  const { call } = await connect();
  const o = await call("rocketchat_unread_overview");
  assert.deepEqual(o.data.summary, { rooms: 2, unread_messages: 4, mentions: 1, group_mentions: 0, unread_threads: 1, direct_messages: 1 });
  // Mentions before direct messages
  assert.deepEqual(o.data.rooms.map((x) => x.id), ["ROOM_OPS", "ROOM_DM"]);
  assert.deepEqual(o.data.rooms[0].unread_thread_ids, ["T1"]);
  assert.deepEqual(o.data.rooms[0].messages.map((m) => m.id), ["M1", "M3"]);
  assert.equal(o.data.rooms[1].messages[0].text, "Hallo Anna");
  assert.equal((await call("rocketchat_unread_overview", { include_messages: false })).data.rooms[0].messages, undefined);

  const men = await call("rocketchat_list_mentions", { since: "2026-11-01" });
  assert.deepEqual(men.data.mentions.map((m) => m.id), ["M3"]);
  // Only rooms with activity in the period, no direct messages
  assert.equal(men.data.searched_rooms, 2);
});

test("directory, user, raw access with retry on 429", async () => {
  const { call } = await connect();
  const d = await call("rocketchat_search_directory", { query: "max" });
  assert.equal(d.data.users[0].email, "max@x.de");
  const usr = await call("rocketchat_get_user", { user: "@max" });
  assert.equal(usr.data.direct_message_room, "ROOM_DM");
  assert.match((await call("rocketchat_get_user", { user: "niemand" })).text, /not found/);
  const raw = await call("rocketchat_api_get", { path: "/teams.list" });
  assert.equal(raw.data.total, 0);
  assert.equal(calls.filter((c) => c.path.endsWith("/teams.list")).length, 2);
  assert.ok((await call("rocketchat_api_get", { path: "/../x" })).error);
});

test("send: room, new direct message, thread", async () => {
  const { call } = await connect();
  const s = await call("rocketchat_send_message", { room: "ops", text: "Hallo" });
  assert.deepEqual(last("POST", "/chat.sendMessage").body, { message: { rid: "ROOM_OPS", msg: "Hallo" } });
  assert.equal(s.data.message.link, `${baseUrl}/group/ops?msg=NEW`);

  await call("rocketchat_send_message", { room: "@neu", text: "Hi" });
  assert.deepEqual(last("POST", "/im.create").body, { username: "neu" });
  assert.equal(last("POST", "/chat.sendMessage").body.message.rid, "ROOM_DM_NEU");

  await call("rocketchat_send_message", { thread_id: "OWN1", text: "Antwort", also_send_to_room: true });
  assert.deepEqual(last("POST", "/chat.sendMessage").body, { message: { rid: "ROOM_OPS", msg: "Antwort", tmid: "OWN1", tshow: true } });
  assert.match((await call("rocketchat_send_message", { room: "town-square", thread_id: "OWN1", text: "x" })).text, /does not belong/);
});

test("reactions, read state, pinning", async () => {
  const { call } = await connect();
  await call("rocketchat_react", { message_id: "M3", emoji: "eyes", remove: true });
  assert.deepEqual(last("POST", "/chat.react").body, { messageId: "M3", emoji: ":eyes:", shouldReact: false });
  const mr = await call("rocketchat_mark_read", { all_unread: true });
  assert.deepEqual(mr.data.marked_read.sort(), ["@max", "ops"]);
  await call("rocketchat_flag_message", { message_id: "M3", action: "star" });
  assert.deepEqual(last("POST", "/chat.starMessage").body, { messageId: "M3" });
});

test("edit only own messages; create and manage rooms", async () => {
  const { call } = await connect(ALL);
  const upd = await call("rocketchat_update_message", { message_id: "OWN1", text: "Neu" });
  assert.equal(upd.data.previous_text, "Eigener Text");
  assert.deepEqual(last("POST", "/chat.update").body, { roomId: "ROOM_OPS", msgId: "OWN1", text: "Neu" });
  const foreign = await call("rocketchat_update_message", { message_id: "M3", text: "x" });
  assert.match(foreign.text, /@max – only your own/);

  const c = await call("rocketchat_create_room", { name: "test-raum", members: ["@max"], topic: "Thema" });
  assert.deepEqual(last("POST", "/groups.create").body, { name: "test-raum", members: ["max"] });
  assert.deepEqual(c.data.settings, ["topic"]);
  const inv = await call("rocketchat_invite_users", { room: "ops", users: ["max", "niemand"] });
  assert.deepEqual(inv.data.invited, ["@max"]);
  assert.equal(inv.data.errors.length, 1);
  assert.deepEqual(last("POST", "/groups.invite").body, { roomId: "ROOM_OPS", userId: "U-max" });
  assert.match((await call("rocketchat_update_room", { room: "@max", topic: "x" })).text, /only be set for channels/);
});

test("missing configuration does not crash", async () => {
  const client = await rpcClient(createServer(loadConfig({})));
  const r = await client.callTool({ name: "rocketchat_whoami", arguments: {} });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /not configured/);
});
