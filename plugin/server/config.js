// Reads the configuration from environment variables.
// The plugin (.mcp.json) and the desktop extension (manifest.json) fill them from the user settings.

// Plugin option keys (CLAUDE_PLUGIN_OPTION_<KEY>, as passed by .mcp.json) for each ROCKETCHAT_* variable.
const PLUGIN_OPTION = {
  ROCKETCHAT_URL: "ROCKETCHAT_URL",
  ROCKETCHAT_USER_ID: "USER_ID",
  ROCKETCHAT_AUTH_TOKEN: "AUTH_TOKEN",
  ROCKETCHAT_READ_ONLY: "READ_ONLY",
  ROCKETCHAT_ALLOW_SEND: "ALLOW_SEND",
  ROCKETCHAT_ALLOW_REACTIONS: "ALLOW_REACTIONS",
  ROCKETCHAT_ALLOW_EDIT: "ALLOW_EDIT",
  ROCKETCHAT_ALLOW_ROOMS: "ALLOW_ROOMS",
  ROCKETCHAT_DEFAULT_LIMIT: "DEFAULT_LIMIT",
  ROCKETCHAT_MAX_BODY_CHARS: "MAX_BODY_CHARS",
  ROCKETCHAT_TIMEOUT_MS: "TIMEOUT_MS",
};

/** Returns the value, or undefined if empty or an unsubstituted ${user_config.*} placeholder. */
function value(env, name) {
  const v = env[name];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (s === "" || /^\$\{.*\}$/.test(s)) return undefined;
  return s;
}

/** ROCKETCHAT_<NAME>, falling back to the plugin's CLAUDE_PLUGIN_OPTION_<KEY>. */
function raw(env, name) {
  return value(env, name) ?? (PLUGIN_OPTION[name] ? value(env, `CLAUDE_PLUGIN_OPTION_${PLUGIN_OPTION[name]}`) : undefined);
}

function bool(env, name, fallback) {
  const v = raw(env, name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(env, name, fallback, min, max) {
  const v = raw(env, name);
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadConfig(env = process.env) {
  const url = raw(env, "ROCKETCHAT_URL");
  const userId = raw(env, "ROCKETCHAT_USER_ID");
  const token = raw(env, "ROCKETCHAT_AUTH_TOKEN");
  const errors = [];
  if (!url) errors.push("The Rocket.Chat URL (ROCKETCHAT_URL) is not set.");
  if (!userId) errors.push("The user ID (ROCKETCHAT_USER_ID) is not set.");
  if (!token) errors.push("The access token (ROCKETCHAT_AUTH_TOKEN) is not set.");

  let baseUrl = url;
  if (url) {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) errors.push("ROCKETCHAT_URL must start with http:// or https://.");
      // Path without trailing slash and without an /api/v1 suffix
      baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "").replace(/\/api(\/v1)?$/, "");
    } catch {
      errors.push(`ROCKETCHAT_URL is not a valid URL: ${url}`);
    }
  }

  const readOnly = bool(env, "ROCKETCHAT_READ_ONLY", false);
  // Write tool groups, each can be switched off; "read only" disables all of them.
  const allow = {
    send: !readOnly && bool(env, "ROCKETCHAT_ALLOW_SEND", true),
    reactions: !readOnly && bool(env, "ROCKETCHAT_ALLOW_REACTIONS", true),
    edit: !readOnly && bool(env, "ROCKETCHAT_ALLOW_EDIT", false),
    rooms: !readOnly && bool(env, "ROCKETCHAT_ALLOW_ROOMS", false),
  };

  return {
    baseUrl,
    userId,
    token,
    readOnly,
    allow,
    defaultLimit: int(env, "ROCKETCHAT_DEFAULT_LIMIT", 50, 1, 500),
    maxBodyChars: int(env, "ROCKETCHAT_MAX_BODY_CHARS", 4000, 200, 100000),
    timeoutMs: int(env, "ROCKETCHAT_TIMEOUT_MS", 30000, 1000, 300000),
    errors,
  };
}
