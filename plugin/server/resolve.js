// Resolves room and user references (ID, name, display name, #channel, @user) and caches the subscriptions.

const lc = (s) => String(s ?? "").trim().toLowerCase();
const looksLikeId = (s) => /^[A-Za-z0-9]{17,}$/.test(s);

export class Resolver {
  /**
   * @param {import("./rocketchat-client.js").RocketChatClient} api
   */
  constructor(api, { ttlMs = 60000 } = {}) {
    this.api = api;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  async cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  invalidate() {
    this.cache.clear();
  }

  /** All subscriptions (rooms the user is a member of) including unread counters. */
  subscriptions() {
    return this.cached("subs", async () => (await this.api.get("/subscriptions.get")).update ?? []);
  }

  /** Room objects of the user's rooms (topic, last activity, member count) by room ID. */
  roomsById() {
    return this.cached("rooms", async () => new Map(((await this.api.get("/rooms.get")).update ?? []).map((r) => [r._id, r])));
  }

  /**
   * @param {string} input Room ID, name, display name, "#name" or "@user" (direct message)
   * @param {{createDm?: boolean}} [opts] For "@user" without an existing direct message, create it
   * @returns {Promise<{rid: string, t: string, name?: string, fname?: string, sub?: object, room?: object}>}
   */
  async room(input, { createDm = false } = {}) {
    const raw = String(input ?? "").trim();
    if (!raw) throw new Error("Room is missing.");
    const subs = await this.subscriptions();
    const fromSub = (sub) => ({ rid: sub.rid, t: sub.t, name: sub.name, fname: sub.fname, sub });

    if (raw.startsWith("@")) {
      const username = raw.slice(1);
      const sub = subs.find((s) => s.t === "d" && lc(s.name) === lc(username));
      if (sub) return fromSub(sub);
      if (!createDm) throw new Error(`No direct message with @${username} exists.`);
      const res = await this.api.post("/im.create", { username });
      this.invalidate();
      const room = res.room ?? {};
      return { rid: room.rid ?? room._id, t: "d", name: username, room };
    }

    const s = raw.replace(/^#/, "");
    const byId = subs.find((x) => x.rid === s);
    if (byId) return fromSub(byId);
    // Channels/groups before direct messages (whose "name" is the other user's username)
    const rank = (x) => (x.t === "d" ? 1 : 0);
    const byName = subs.filter((x) => lc(x.name) === lc(s)).sort((a, b) => rank(a) - rank(b));
    if (byName.length) return fromSub(byName[0]);
    const byFname = subs.filter((x) => lc(x.fname) === lc(s));
    if (byFname.length === 1) return fromSub(byFname[0]);
    if (byFname.length > 1) {
      throw new Error(`Room name "${s}" is ambiguous: ${byFname.map((x) => `${x.name} (${x.rid})`).join(", ")}. Please give the ID or short name.`);
    }

    // Not subscribed: public channel or a room visible to admins
    let room;
    try {
      room = (await this.api.get("/rooms.info", looksLikeId(s) ? { roomId: s } : { roomName: s })).room;
    } catch (err) {
      if (err.errorType !== "error-room-not-found" && err.status !== 404 && err.status !== 400) throw err;
    }
    if (!room) {
      const partial = subs.filter((x) => lc(x.fname).includes(lc(s)) || lc(x.name).includes(lc(s))).slice(0, 8);
      const hint = partial.length ? ` Similar rooms: ${partial.map((x) => (x.t === "d" ? `@${x.name}` : x.name)).join(", ")}.` : "";
      throw new Error(`Room "${s}" not found.${hint}`);
    }
    return { rid: room._id, t: room.t, name: room.name, fname: room.fname, room };
  }

  /** Room object (rooms.info) – from the rooms.get cache, otherwise loaded individually. */
  async roomInfo(rid) {
    const cached = (await this.roomsById()).get(rid);
    if (cached) return cached;
    return (await this.api.get("/rooms.info", { roomId: rid })).room;
  }

  /**
   * @param {string} input "me", user ID, username or "@username"
   * @returns {Promise<{_id: string, username: string, name?: string}>}
   */
  async user(input) {
    const s = String(input ?? "").trim().replace(/^@/, "");
    if (!s) throw new Error("User is missing.");
    if (lc(s) === "me") return this.cached("me", async () => this.api.get("/me"));
    return this.cached(`user:${lc(s)}`, async () => {
      try {
        return (await this.api.get("/users.info", { username: s })).user;
      } catch (err) {
        if (!looksLikeId(s)) {
          throw new Error(`User "${s}" not found (expected a username such as @jdoe; search with rocketchat_search_directory).`);
        }
        return (await this.api.get("/users.info", { userId: s })).user;
      }
    });
  }
}
