// Helpers that render Rocket.Chat objects compactly and LLM-friendly.

export function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated, ${s.length - max} more characters]`;
}

function isEmpty(v) {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
  );
}

/** Removes empty values. */
export function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!isEmpty(v)) out[k] = v;
  return out;
}

/** Rocket.Chat date fields: ISO string or {$date: ms}. */
export function isoDate(v) {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return new Date(v).toISOString();
  if (v.$date) return new Date(v.$date).toISOString();
  return undefined;
}

/**
 * Converts a date expression into an ISO timestamp (UTC).
 * Accepts an ISO date/timestamp or relative values such as "now", "now-24h", "now-7d", "now-30m", "now+2w".
 */
export function resolveDate(value, now = new Date()) {
  const s = String(value).trim();
  const rel = /^now(?:([+-])(\d+)([mhdw]))?$/.exec(s);
  let d;
  if (rel) {
    const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[3] ?? "h"] * Number(rel[2] ?? 0) * (rel[1] === "-" ? -1 : 1);
    d = new Date(now.getTime() + ms);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Plain date: local midnight
    const [y, m, day] = s.split("-").map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value} (expected e.g. 2026-11-01 or now-7d)`);
  return d.toISOString();
}

export const ROOM_TYPES = { c: "channel", p: "private", d: "direct", l: "livechat", v: "voip" };

/** Web link to a room or a message. */
export function roomLink(baseUrl, room) {
  if (!room) return undefined;
  const t = room.t;
  if (t === "d") return `${baseUrl}/direct/${room.rid ?? room._id}`;
  if (!room.name) return undefined;
  const seg = t === "c" ? "channel" : t === "p" ? "group" : undefined;
  return seg ? `${baseUrl}/${seg}/${encodeURIComponent(room.name)}` : undefined;
}

export const messageLink = (baseUrl, room, msgId) => {
  const l = roomLink(baseUrl, room);
  return l ? `${l}?msg=${msgId}` : undefined;
};

const userLabel = (u) => (u ? (u.name && u.name !== u.username ? `${u.name} (@${u.username})` : u.username ? `@${u.username}` : u._id) : undefined);

const SYSTEM = {
  uj: "joined the room",
  ujt: "joined the team",
  ul: "left the room",
  ult: "left the team",
  au: (m) => `added @${m.msg}`,
  ru: (m) => `removed @${m.msg}`,
  "added-user-to-team": (m) => `added @${m.msg} to the team`,
  "removed-user-from-team": (m) => `removed @${m.msg} from the team`,
  r: (m) => `renamed the room to ${m.msg}`,
  room_changed_topic: (m) => `changed the topic: ${m.msg}`,
  room_changed_description: (m) => `changed the description: ${m.msg}`,
  room_changed_announcement: (m) => `changed the announcement: ${m.msg}`,
  room_changed_privacy: (m) => `changed the room type: ${m.msg}`,
  "subscription-role-added": (m) => `gave @${m.msg} the role ${m.role}`,
  "subscription-role-removed": (m) => `removed the role ${m.role} from @${m.msg}`,
  message_pinned: "pinned a message",
  "discussion-created": (m) => `started the discussion "${m.msg}"`,
  "user-muted": (m) => `muted @${m.msg}`,
  "user-unmuted": (m) => `unmuted @${m.msg}`,
};

/** System message (join, topic change …) as text. */
export function systemText(m) {
  const s = SYSTEM[m.t];
  if (typeof s === "function") return s(m);
  return s ?? `system event ${m.t}${m.msg ? `: ${m.msg}` : ""}`;
}

/** Make relative links (e.g. /file-upload/…) absolute to the instance. */
const absolute = (baseUrl, href) => (href && href.startsWith("/") ? baseUrl + href : href);

function compactAttachment(a, { baseUrl, maxBodyChars }) {
  return clean({
    title: a.title,
    link: absolute(baseUrl, a.title_link),
    author: a.author_name,
    text: truncate(a.text ?? a.description, maxBodyChars),
    // Quoted/forwarded message
    quoted_message: a.message_link,
    image: absolute(baseUrl, a.image_url),
    type: a.type === "file" ? a.image_type ?? a.audio_type ?? a.video_type ?? "file" : undefined,
    fields: (a.fields ?? []).map((f) => `${f.title}: ${f.value}`).filter(Boolean),
    attachments: (a.attachments ?? []).map((x) => compactAttachment(x, { baseUrl, maxBodyChars })),
  });
}

/**
 * @param {object} m Message
 * @param {{baseUrl: string, maxBodyChars?: number, room?: object, me?: string}} opts
 */
export function compactMessage(m, { baseUrl, maxBodyChars = 4000, room, me } = {}) {
  // Integrations use "​" (zero width space) as empty text next to attachments
  const text = typeof m.msg === "string" && m.msg.replace(/​/g, "").trim() ? m.msg : undefined;
  const reactions = {};
  for (const [emoji, r] of Object.entries(m.reactions ?? {})) reactions[emoji] = r.names?.length ? r.names : r.usernames;
  const files = (m.files ?? (m.file ? [m.file] : [])).map((f) => clean({ name: f.name, type: f.type }));
  return clean({
    id: m._id,
    at: isoDate(m.ts),
    by: userLabel(m.u),
    alias: m.alias || undefined,
    bot: m.bot ? true : undefined,
    system: m.t ? systemText(m) : undefined,
    text: m.t ? undefined : truncate(text, maxBodyChars),
    thread_id: m.tmid,
    thread_replies: m.tcount,
    thread_last_reply: isoDate(m.tlm),
    discussion_room_id: m.drid,
    edited: m.editedAt ? isoDate(m.editedAt) : undefined,
    pinned: m.pinned || undefined,
    starred: me && (m.starred ?? []).some((s) => s._id === me) ? true : undefined,
    mentions_me: me && (m.mentions ?? []).some((x) => x._id === me || x._id === "all" || x._id === "here") ? true : undefined,
    reactions,
    attachments: (m.attachments ?? []).map((a) => compactAttachment(a, { baseUrl, maxBodyChars })).filter((a) => Object.keys(a).length),
    files,
    link: room ? messageLink(baseUrl, room, m._id) : undefined,
  });
}

/**
 * Room from a subscription and/or a room object.
 * @param {{sub?: object, room?: object, baseUrl: string, maxBodyChars?: number}} p
 */
export function compactRoom({ sub, room, baseUrl, maxBodyChars = 4000 }) {
  const t = sub?.t ?? room?.t;
  const id = sub?.rid ?? room?._id;
  const name = sub?.name ?? room?.name;
  const out = {
    id,
    name: t === "d" ? `@${name}` : name,
    display_name: (sub?.fname ?? room?.fname) !== name ? (sub?.fname ?? room?.fname) : undefined,
    type: ROOM_TYPES[t] ?? t,
    team: room?.teamMain ? "team main room" : undefined,
    team_id: room?.teamId,
    topic: truncate(room?.topic, maxBodyChars),
    description: truncate(room?.description, maxBodyChars),
    announcement: truncate(room?.announcement, maxBodyChars),
    read_only: room?.ro || undefined,
    archived: room?.archived || undefined,
    members: room?.usersCount,
    message_count: room?.msgs,
    last_activity: isoDate(room?.lm ?? room?.lastMessage?.ts),
    favorite: sub?.f || undefined,
    unread: sub?.unread || undefined,
    mentions: sub?.userMentions || undefined,
    group_mentions: sub?.groupMentions || undefined,
    unread_threads: sub?.tunread?.length || undefined,
    last_seen: isoDate(sub?.ls),
    hidden: sub && sub.open === false ? true : undefined,
    link: roomLink(baseUrl, { t, name, rid: id }),
  };
  return clean(out);
}

export function compactUser(u) {
  return clean({
    id: u._id,
    username: u.username,
    name: u.name,
    nickname: u.nickname,
    status: u.status,
    status_text: u.statusText,
    email: u.emails?.[0]?.address ?? u.email,
    roles: u.roles,
    active: u.active === false ? false : undefined,
    type: u.type && u.type !== "user" ? u.type : undefined,
    last_login: isoDate(u.lastLogin),
    utc_offset: u.utcOffset,
  });
}

export function json(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(err) {
  const text = err?.message ?? String(err);
  return { isError: true, content: [{ type: "text", text }] };
}
