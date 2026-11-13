import bundledCalendar from "../calendar.json";

const PATREON_TOKEN = "https://www.patreon.com/api/oauth2/token";
const PATREON_IDENTITY =
  "https://www.patreon.com/api/oauth2/v2/identity?include=memberships,memberships.currently_entitled_tiers&fields%5Buser%5D=full_name&fields%5Bmember%5D=patron_status,currently_entitled_amount_cents&fields%5Btier%5D=title";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(env, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/oauth/exchange") {
        return json(await exchange(request, env), 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/me") {
        return json(await me(request, env), 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/calendar") {
        return json(await calendar(request, env), 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/races") {
        return json(await addRace(request, env), 200, cors);
      }
      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      const status = err.status || 500;
      const error = err.code || "server_error";
      return json({ error }, status, cors);
    }
  },
};

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function fail(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  throw err;
}

function csvSet(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function allowedRedirect(env, redirectUri) {
  const origins = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  return origins.some((origin) => {
    const exact = `${origin.replace(/\/$/, "")}/auth/patreon/callback`;
    return redirectUri === exact || redirectUri === `${exact}/`;
  });
}

async function exchange(request, env) {
  if (!env.PATREON_CLIENT_ID || !env.PATREON_CLIENT_SECRET || !env.SESSION_SECRET) {
    fail(500, "missing_config");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    fail(400, "invalid_json");
  }

  const code = String(body.code || "").trim();
  const redirectUri = String(body.redirect_uri || "").trim();
  if (!code || !redirectUri) fail(400, "missing_code");
  if (!allowedRedirect(env, redirectUri)) fail(400, "bad_redirect");

  const tokenRes = await fetch(PATREON_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.PATREON_CLIENT_ID,
      client_secret: env.PATREON_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  const access = tokenJson.access_token;
  if (!tokenRes.ok || !access) fail(401, "exchange_failed");

  const identRes = await fetch(PATREON_IDENTITY, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const ident = await identRes.json().catch(() => ({}));
  if (!identRes.ok || !ident.data) fail(401, "identity_failed");

  const gate = evaluateMembership(ident, env);
  if (!gate.ok) fail(403, gate.reason);

  const token = await signJwt(
    {
      sub: ident.data.id,
      name: ident.data.attributes?.full_name || "",
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
    },
    env.SESSION_SECRET
  );

  return { token, name: ident.data.attributes?.full_name || "" };
}

function evaluateMembership(ident, env) {
  const userId = ident.data?.id;
  const allowUsers = csvSet(env.PATREON_ALLOW_USER_IDS);
  if (userId && allowUsers.has(userId)) return { ok: true };

  const allowedTiers = csvSet(env.PATREON_TIER_IDS);
  const included = Array.isArray(ident.included) ? ident.included : [];
  const members = included.filter((row) => row.type === "member");
  const entitledIds = new Set();
  let active = false;
  let paying = false;

  for (const member of members) {
    const status = member.attributes?.patron_status;
    const cents = Number(member.attributes?.currently_entitled_amount_cents || 0);
    if (status === "active_patron") {
      active = true;
      if (cents > 0) paying = true;
    }
    const tiers = member.relationships?.currently_entitled_tiers?.data || [];
    for (const t of tiers) {
      if (t.id) entitledIds.add(String(t.id));
    }
  }

  if (paying) return { ok: true };
  for (const id of entitledIds) {
    if (allowedTiers.has(id)) return { ok: true };
  }
  if (!active) return { ok: false, reason: "not_member" };
  return { ok: false, reason: "wrong_tier" };
}

async function sessionPayload(request, env) {
  const token = bearer(request);
  if (!token) fail(401, "unauthorized");
  const payload = await verifyJwt(token, env.SESSION_SECRET);
  if (!payload) fail(401, "unauthorized");
  return payload;
}

async function me(request, env) {
  const payload = await sessionPayload(request, env);
  return { name: payload.name || "" };
}

async function calendar(request, env) {
  const payload = await sessionPayload(request, env);
  const data = await loadCalendar(env);
  return publicCalendar(data, payload);
}

async function addRace(request, env) {
  const payload = await sessionPayload(request, env);
  if (!env.CALENDAR) fail(500, "missing_config");

  let body;
  try {
    body = await request.json();
  } catch {
    fail(400, "invalid_json");
  }

  const race = normalizeRace(body);
  const data = await loadCalendar(env);
  const members = cloneMembers(data.members);
  const member = resolveMember(members, payload, body.claim_name);
  if (!member.races) member.races = [];
  member.races.push(race);
  member.races.sort(compareRaces);

  const next = {
    members,
    imported_at: data.imported_at || "",
    updated_at: new Date().toISOString(),
  };
  await env.CALENDAR.put("data", JSON.stringify(next));
  return publicCalendar(next, payload);
}

function cloneMembers(members) {
  return (members || []).map((m) => ({
    ...m,
    races: Array.isArray(m.races) ? m.races.map((r) => ({ ...r })) : [],
  }));
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveMember(members, payload, claimName) {
  const sub = String(payload.sub || "");
  let member = members.find((m) => m.patreon_id && m.patreon_id === sub);
  if (member) return member;

  const claim = String(claimName || "").trim();
  if (claim) {
    member = members.find((m) => !m.patreon_id && normName(m.name) === normName(claim));
    if (member) {
      member.patreon_id = sub;
      return member;
    }
  }

  member = members.find((m) => !m.patreon_id && normName(m.name) === normName(payload.name));
  if (member) {
    member.patreon_id = sub;
    return member;
  }

  member = {
    name: String(payload.name || "").trim() || "Uten navn",
    patreon_id: sub,
    races: [],
  };
  members.unshift(member);
  return member;
}

function normalizeRace(body) {
  const name = String(body.name || "").trim();
  if (name.length < 2 || name.length > 160) fail(400, "invalid_race");

  const dateIso = String(body.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) fail(400, "invalid_date");
  const dt = new Date(dateIso + "T12:00:00Z");
  if (Number.isNaN(dt.getTime())) fail(400, "invalid_date");
  const year = dt.getUTCFullYear();
  if (year < 2000 || year > 2100) fail(400, "invalid_date");

  const race = {
    name,
    date: formatDateNb(dateIso),
    date_iso: dateIso,
  };

  const distance = clip(body.distance, 80);
  const elevation = clip(body.elevation, 40);
  const comment = clip(body.comment, 500);
  const url = String(body.url || "").trim();
  if (distance) race.distance = distance;
  if (elevation) race.elevation = elevation;
  if (comment) race.comment = comment;
  if (url) {
    if (!/^https?:\/\//i.test(url) || url.length > 500) fail(400, "invalid_url");
    race.url = url;
  }
  return race;
}

function clip(value, max) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s.slice(0, max);
}

function formatDateNb(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function compareRaces(a, b) {
  return String(a.date_iso || "9999").localeCompare(String(b.date_iso || "9999"));
}

function publicCalendar(data, payload) {
  const members = (data.members || []).map((m) => {
    const copy = { ...m };
    delete copy.patreon_id;
    return copy;
  });
  const mine = (data.members || []).find((m) => m.patreon_id && m.patreon_id === payload.sub);
  const suggested = (data.members || []).find(
    (m) => !m.patreon_id && normName(m.name) === normName(payload.name)
  );
  return {
    name: payload.name || "",
    members,
    self: {
      name: mine?.name || payload.name || "",
      claimed: Boolean(mine),
    },
    unclaimed: (data.members || []).filter((m) => !m.patreon_id).map((m) => m.name),
    suggested: suggested ? suggested.name : "",
  };
}

function fromObject(parsed) {
  if (!parsed) return null;
  if (Array.isArray(parsed)) return { members: [], races: parsed };
  if (Array.isArray(parsed.members)) {
    return { members: parsed.members, imported_at: parsed.imported_at || "" };
  }
  return null;
}

async function loadCalendar(env) {
  if (env.CALENDAR) {
    const fromKv = await env.CALENDAR.get("data", "json");
    const parsed = fromObject(fromKv);
    if (parsed) return parsed;
  }
  const seeded = fromObject(bundledCalendar) || { members: [] };
  if (env.CALENDAR) {
    await env.CALENDAR.put("data", JSON.stringify(seeded));
  }
  return seeded;
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

function b64url(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signJwt(payload, secret) {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson(payload);
  const data = `${header}.${body}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

async function verifyJwt(token, secret) {
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const key = await hmacKey(secret);
  const sig = b64urlDecode(parts[2]);
  const ok = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
