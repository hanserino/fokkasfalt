const PATREON_TOKEN = "https://www.patreon.com/api/oauth2/token";
const PATREON_IDENTITY =
  "https://www.patreon.com/api/oauth2/v2/identity?include=memberships,memberships.campaign,memberships.currently_entitled_tiers&fields%5Buser%5D=full_name,image_url,thumb_url&fields%5Bmember%5D=patron_status,currently_entitled_amount_cents&fields%5Btier%5D=title";

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
      if (request.method === "POST" && url.pathname === "/races/join") {
        return json(await joinRace(request, env), 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/races/update") {
        return json(await updateRace(request, env), 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/races/delete") {
        return json(await deleteRace(request, env), 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/profile") {
        return json(await updateProfile(request, env), 200, cors);
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

  const name = ident.data.attributes?.full_name || "";
  const image = safeImage(ident.data.attributes?.image_url || ident.data.attributes?.thumb_url);
  const perks = { slack: Boolean(gate.slack) };
  const payload = {
    sub: ident.data.id,
    name,
    image,
    perks,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
  };
  const token = await signJwt(payload, env.SESSION_SECRET);
  await persistMemberProfile(env, payload);
  return { token, name, image, perks };
}

function evaluateMembership(ident, env) {
  const userId = ident.data?.id;
  const allowUsers = csvSet(env.PATREON_ALLOW_USER_IDS);
  if (userId && allowUsers.has(userId)) return { ok: true, slack: true };

  const campaignId = String(env.PATREON_CAMPAIGN_ID || "").trim();
  const slackIds = csvSet(env.SLACK_TIER_IDS || "7252533");
  const included = Array.isArray(ident.included) ? ident.included : [];
  const entitled = new Set();
  let active = false;

  for (const member of included) {
    if (member.type !== "member") continue;
    const camp = member.relationships?.campaign?.data?.id;
    if (campaignId && camp && String(camp) !== campaignId) continue;
    if (member.attributes?.patron_status !== "active_patron") continue;
    active = true;
    const tiers = member.relationships?.currently_entitled_tiers?.data || [];
    for (const t of tiers) {
      if (t.id) entitled.add(String(t.id));
    }
  }

  if (!active) return { ok: false, reason: "not_member", slack: false };

  let slack = false;
  for (const id of entitled) {
    if (slackIds.has(id)) slack = true;
  }
  for (const row of included) {
    if (row.type !== "tier" || !entitled.has(String(row.id))) continue;
    if (normName(row.attributes?.title) === "fokk asfalt") slack = true;
  }
  return { ok: true, slack };
}

function sessionPerks(payload) {
  if (payload?.perks && typeof payload.perks.slack === "boolean") {
    return { slack: payload.perks.slack };
  }
  return { slack: true };
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
  const data = await loadCalendar(env);
  const mine = (data.members || []).find((m) => m.patreon_id && m.patreon_id === payload.sub);
  return {
    name: payload.name || "",
    alias: mine?.alias || "",
    display_name: displayName(mine) || payload.name || "",
    instagram: normalizeInstagram(mine?.instagram) || "",
    strava: normalizeStrava(mine?.strava) || "",
    image: safeImage(mine?.avatar || payload.image),
    perks: sessionPerks(payload),
  };
}

function displayName(member) {
  const alias = String(member?.alias || "").trim();
  if (alias) return alias;
  return String(member?.name || "").trim();
}

async function updateProfile(request, env) {
  const payload = await sessionPayload(request, env);
  if (!env.CALENDAR) fail(500, "missing_config");

  let body;
  try {
    body = await request.json();
  } catch {
    fail(400, "invalid_json");
  }

  const data = await loadCalendar(env);
  const members = cloneMembers(data.members);
  const member = resolveMember(members, payload, body.claim_name);
  applyAlias(members, member, body, payload);
  applyLinks(member, body);

  const next = {
    members,
    imported_at: data.imported_at || "",
    updated_at: new Date().toISOString(),
  };
  await env.CALENDAR.put("data", JSON.stringify(next));
  return publicCalendar(next, payload);
}

async function calendar(request, env) {
  const payload = await sessionPayload(request, env);
  const data = await persistMemberProfile(env, payload);
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

  const data = await loadCalendar(env);
  const race = normalizeRace(body);
  canonicalizeRace(race, data.members);
  return saveMemberRace(env, payload, body, race);
}

async function joinRace(request, env) {
  const payload = await sessionPayload(request, env);
  if (!env.CALENDAR) fail(500, "missing_config");

  let body;
  try {
    body = await request.json();
  } catch {
    fail(400, "invalid_json");
  }

  const data = await loadCalendar(env);
  const source = findExistingRace(data.members, body.name, body.date_iso || body.date);
  if (!source) fail(404, "race_not_found");
  const race = {
    name: source.name,
    date: source.date,
    date_iso: source.date_iso,
  };
  if (source.distance) race.distance = source.distance;
  if (source.timed) race.timed = true;
  if (source.elevation) race.elevation = source.elevation;
  if (source.url) race.url = source.url;
  return saveMemberRace(env, payload, body, race);
}

async function updateRace(request, env) {
  const payload = await sessionPayload(request, env);
  if (!env.CALENDAR) fail(500, "missing_config");

  let body;
  try {
    body = await request.json();
  } catch {
    fail(400, "invalid_json");
  }

  const originalName = String(body.original_name || "").trim();
  const originalDate = String(body.original_date || body.original_date_iso || "").trim();
  if (!originalName || !/^\d{4}-\d{2}-\d{2}$/.test(originalDate)) fail(400, "race_not_found");

  const race = normalizeRace(body);
  const data = await loadCalendar(env);
  const members = cloneMembers(data.members);
  canonicalizeRace(race, members);
  const member = resolveMember(members, payload, body.claim_name);
  applyAlias(members, member, body, payload);
  if (!member.races) member.races = [];

  const fromKey = raceKey({ name: originalName, date_iso: originalDate });
  const index = member.races.findIndex((row) => raceKey(row) === fromKey);
  if (index < 0) fail(404, "race_not_found");

  const nextKey = raceKey(race);
  const clash = member.races.some((row, i) => i !== index && raceKey(row) === nextKey);
  if (clash) fail(409, "already_added");

  member.races[index] = race;
  member.races.sort(compareRaces);

  const next = {
    members,
    imported_at: data.imported_at || "",
    updated_at: new Date().toISOString(),
  };
  await env.CALENDAR.put("data", JSON.stringify(next));
  return publicCalendar(next, payload);
}

async function deleteRace(request, env) {
  const payload = await sessionPayload(request, env);
  if (!env.CALENDAR) fail(500, "missing_config");

  let body;
  try {
    body = await request.json();
  } catch {
    fail(400, "invalid_json");
  }

  const name = String(body.name || "").trim();
  const dateIso = String(body.date_iso || body.date || "").trim();
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) fail(400, "race_not_found");

  const data = await loadCalendar(env);
  const members = cloneMembers(data.members);
  const sub = String(payload.sub || "");
  const member = members.find((m) => m.patreon_id && m.patreon_id === sub);
  if (!member || !member.races) fail(404, "race_not_found");

  const fromKey = raceKey({ name, date_iso: dateIso });
  const nextRaces = member.races.filter((row) => raceKey(row) !== fromKey);
  if (nextRaces.length === member.races.length) fail(404, "race_not_found");
  member.races = nextRaces;

  const next = {
    members,
    imported_at: data.imported_at || "",
    updated_at: new Date().toISOString(),
  };
  await env.CALENDAR.put("data", JSON.stringify(next));
  return publicCalendar(next, payload);
}

async function saveMemberRace(env, payload, body, race) {
  const data = await loadCalendar(env);
  const members = cloneMembers(data.members);
  const member = resolveMember(members, payload, body.claim_name);
  applyAlias(members, member, body, payload);
  if (!member.races) member.races = [];
  const existing = member.races.find((row) => raceKey(row) === raceKey(race));
  if (!existing) {
    member.races.push(race);
    member.races.sort(compareRaces);
  } else {
    mergeRaceFields(existing, race);
  }

  const next = {
    members,
    imported_at: data.imported_at || "",
    updated_at: new Date().toISOString(),
  };
  await env.CALENDAR.put("data", JSON.stringify(next));
  const out = publicCalendar(next, payload);
  out.added = !existing;
  return out;
}

function mergeRaceFields(target, source) {
  ["distance", "elevation", "comment", "url", "time", "place"].forEach((key) => {
    if (source[key]) target[key] = source[key];
  });
  if (source.timed) target.timed = true;
}

function raceKey(race) {
  return `${normName(race.name)}|${race.date_iso || ""}`;
}

function findExistingRace(members, name, dateIso) {
  const key = raceKey({ name, date_iso: dateIso });
  for (const member of members || []) {
    for (const race of member.races || []) {
      if (raceKey(race) === key) return race;
    }
  }
  return null;
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

function coreName(s) {
  return normName(s)
    .replace(/\s*\/\s*[a-z0-9]{2,8}$/i, "")
    .replace(/\bby utmb\b/g, " ")
    .replace(/\b(\d+[.,]?\d*)\s*(km|k|miles|mile|mi|yards|yard|yd|timer|hours|hour|hr|h|t)\b/g, " ")
    .replace(/\b(\d+)\s*k\b/g, " ")
    .replace(/[-–—]/g, " ")
    .replace(/[^a-z0-9øæå ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function preferRaceName(a, b) {
  const aAlias = /\/\s*[A-Za-z0-9ÆØÅæøå]{2,8}\s*$/.test(a);
  const bAlias = /\/\s*[A-Za-z0-9ÆØÅæøå]{2,8}\s*$/.test(b);
  if (aAlias !== bAlias) return aAlias ? b : a;
  return a.length <= b.length ? a : b;
}

function splitNameAndDistance(raw, knownCores) {
  const s = String(raw || "").trim();
  const m = s.match(
    /^(.*?)[\s\-–—]*(\d+[.,]?\d*)\s*(km|k|miles|mile|mi|yards|yard|yd|timer|hours|hour|hr|h|t)?\s*$/i
  );
  if (!m || m[1].trim().length < 4) return { name: s, distance: "" };
  const amount = m[2];
  if (/^20\d{2}$/.test(amount)) return { name: s, distance: "" };
  const name = m[1].trim().replace(/[\s\-–—]+$/g, "");
  if (name.length < 4) return { name: s, distance: "" };
  const unit = distanceUnit(m[3]);
  let dist = "";
  if (unit) dist = `${amount} ${unit}`;
  else {
    const n = parseFloat(String(amount).replace(",", "."));
    const restCore = coreName(name);
    const known =
      !knownCores ||
      knownCores.has(restCore) ||
      [...knownCores].some((core) => core === restCore);
    if (known && n >= 20 && n <= 500) dist = `${amount} km`;
  }
  if (!dist) return { name: s, distance: "" };
  return { name, distance: dist };
}

function knownNamesByCore(members) {
  const byCore = new Map();
  for (const member of members || []) {
    for (const race of member.races || []) {
      if (!race?.name) continue;
      const core = coreName(race.name);
      if (!core) continue;
      const prev = byCore.get(core);
      if (!prev || preferRaceName(race.name, prev) === race.name) byCore.set(core, race.name);
    }
  }
  return byCore;
}

function canonicalizeRace(race, members) {
  if (!race?.name) return;
  const byCore = knownNamesByCore(members);
  const split = splitNameAndDistance(race.name, byCore);
  const qCore = coreName(split.name);
  if (!qCore) return;
  const existing = byCore.get(qCore);
  if (split.distance) {
    race.name = existing || split.name;
    if (!race.distance) race.distance = split.distance;
    return;
  }
  if (existing) race.name = existing;
}

function applyLinks(member, body) {
  if (!body) return;
  if (Object.prototype.hasOwnProperty.call(body, "instagram")) {
    const url = normalizeInstagram(body.instagram);
    if (String(body.instagram || "").trim() && !url) fail(400, "invalid_instagram");
    if (url) member.instagram = url;
    else delete member.instagram;
  }
  if (Object.prototype.hasOwnProperty.call(body, "strava")) {
    const url = normalizeStrava(body.strava);
    if (String(body.strava || "").trim() && !url) fail(400, "invalid_strava");
    if (url) member.strava = url;
    else delete member.strava;
  }
}

function normalizeInstagram(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let handle = "";
  if (/^https?:\/\//i.test(s) || /instagram\.com/i.test(s)) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s.replace(/^\/\//, ""));
    } catch {
      return "";
    }
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return "";
    handle = url.pathname.split("/").filter(Boolean)[0] || "";
    if (["p", "reel", "reels", "stories", "explore", "accounts"].includes(handle.toLowerCase())) return "";
  } else {
    handle = s.replace(/^@/, "");
  }
  if (!/^[A-Za-z0-9._]{2,30}$/.test(handle)) return "";
  return "https://www.instagram.com/" + handle + "/";
}

function normalizeStrava(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^\d{3,15}$/.test(s)) return "https://www.strava.com/athletes/" + s;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s.replace(/^\/\//, ""));
  } catch {
    return "";
  }
  if (!/(^|\.)strava\.com$/i.test(url.hostname)) return "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "athletes" && parts[1] && /^[A-Za-z0-9._-]{2,40}$/.test(parts[1])) {
    return "https://www.strava.com/athletes/" + parts[1];
  }
  return "";
}

function applyAlias(members, member, body, payload) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "alias")) return;
  let alias = clip(body.alias, 40);
  if (alias && (alias.length < 2 || /^https?:\/\//i.test(alias))) fail(400, "invalid_alias");
  const patreon = String(payload?.name || "").trim();
  if (
    alias &&
    (normName(alias) === normName(member.name) || (patreon && normName(alias) === normName(patreon)))
  ) {
    alias = "";
  }
  if (alias) {
    const taken = members.some(
      (row) => row !== member && normName(displayName(row)) === normName(alias)
    );
    if (taken) fail(409, "alias_taken");
    member.alias = alias;
  } else {
    delete member.alias;
  }
}

function applyProfile(member, payload) {
  const sub = String(payload.sub || "");
  if (sub) member.patreon_id = sub;
  const image = safeImage(payload.image);
  if (image) member.avatar = image;
  return member;
}

function resolveMember(members, payload, claimName) {
  const sub = String(payload.sub || "");
  let member = members.find((m) => m.patreon_id && m.patreon_id === sub);
  if (member) return applyProfile(member, payload);

  const claim = String(claimName || "").trim();
  if (claim) {
    member = members.find((m) => !m.patreon_id && normName(m.name) === normName(claim));
    if (member) return applyProfile(member, payload);
  }

  member = members.find((m) => !m.patreon_id && normName(m.name) === normName(payload.name));
  if (member) return applyProfile(member, payload);

  member = applyProfile(
    {
      name: String(payload.name || "").trim() || "Uten navn",
      races: [],
    },
    payload
  );
  members.unshift(member);
  return member;
}

async function persistMemberProfile(env, payload, data) {
  const current = data || (await loadCalendar(env));
  if (!env.CALENDAR) return current;
  const members = cloneMembers(current.members);
  const sub = String(payload.sub || "");
  const image = safeImage(payload.image);
  let member = members.find((m) => m.patreon_id && m.patreon_id === sub);
  if (!member) {
    member = members.find((m) => !m.patreon_id && normName(m.name) === normName(payload.name));
  }
  if (!member) return current;
  const nextImage = image || member.avatar || "";
  const already =
    member.patreon_id === sub && (!nextImage || member.avatar === nextImage);
  if (already) return current;
  applyProfile(member, { ...payload, image: nextImage });
  const next = {
    members,
    imported_at: current.imported_at || "",
    updated_at: new Date().toISOString(),
  };
  await env.CALENDAR.put("data", JSON.stringify(next));
  return next;
}

function safeImage(url) {
  const s = String(url || "").trim();
  if (!s || s.length > 1000) return "";
  if (!/^https:\/\//i.test(s)) return "";
  return s;
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

  const distance = formatDistance(body);
  const elevation = clip(body.elevation, 40);
  const finished = dateIso <= new Date().toISOString().slice(0, 10);
  const time = finished ? clip(body.time, 40) : "";
  const place = finished ? clip(body.place, 40) : "";
  const comment = clip(body.comment, 500);
  const url = String(body.url || "").trim();
  if (distance) race.distance = distance;
  if (body.timed === true || body.timed === "true") race.timed = true;
  if (elevation) race.elevation = elevation;
  if (time) race.time = time;
  if (place) race.place = place;
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

function distanceUnit(token) {
  const u = String(token || "").trim().toLowerCase();
  if (u === "miles" || u === "mile" || u === "mi") return "miles";
  if (u === "yards" || u === "yard" || u === "yd") return "yards";
  if (u === "timer" || u === "hours" || u === "hour" || u === "hr" || u === "h" || u === "t") {
    return "timer";
  }
  if (u === "km" || u === "k") return "km";
  return "";
}

function formatDistance(body) {
  const raw = clip(body.distance, 80);
  const fromBody = distanceUnit(body.distance_unit) || "km";
  if (!raw) return "";
  const m = raw.match(/^([\d.,]+)\s*(km|k|miles|mile|mi|yards|yard|yd|timer|hours|hour|hr|h|t)?$/i);
  if (!m) return raw;
  const amount = m[1];
  const unit = distanceUnit(m[2]) || fromBody;
  return clip(amount + " " + unit, 80);
}

function formatDateNb(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function compareRaces(a, b) {
  return String(a.date_iso || "9999").localeCompare(String(b.date_iso || "9999"));
}

function publicCalendar(data, payload) {
  const members = (data.members || [])
    .filter((m) => Array.isArray(m.races) && m.races.length)
    .map((m) => {
    const copy = { ...m };
    copy.name = displayName(m) || copy.name;
    delete copy.patreon_id;
    delete copy.alias;
    const instagram = normalizeInstagram(copy.instagram);
    const strava = normalizeStrava(copy.strava);
    if (instagram) copy.instagram = instagram;
    else delete copy.instagram;
    if (strava) copy.strava = strava;
    else delete copy.strava;
    if (copy.avatar) copy.avatar = safeImage(copy.avatar);
    else delete copy.avatar;
    return copy;
  });
  const mine = (data.members || []).find((m) => m.patreon_id && m.patreon_id === payload.sub);
  const suggested = (data.members || []).find(
    (m) => !m.patreon_id && normName(m.name) === normName(payload.name)
  );
  const image = safeImage(mine?.avatar || payload.image);
  const shown = displayName(mine) || payload.name || "";
  return {
    name: shown,
    image,
    members,
    self: {
      name: shown,
      alias: mine?.alias || "",
      patreon_name: payload.name || mine?.name || "",
      claimed: Boolean(mine),
      avatar: image,
      instagram: normalizeInstagram(mine?.instagram) || "",
      strava: normalizeStrava(mine?.strava) || "",
    },
    perks: sessionPerks(payload),
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
  return { members: [] };
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
