(function () {
  const root = document.getElementById("patreon-gate");
  if (!root) return;

  const STORAGE = "fa_patreon_session";
  const STATE = "fa_patreon_oauth_state";
  const RETURN = "fa_patreon_return";
  const HOME = "/community/";
  const MESSAGES = {
    missing_config: "Innlogging er ikke ferdig satt opp ennå.",
    exchange_failed: "Patreon avviste innloggingen. Prøv igjen.",
    identity_failed: "Fikk ikke hentet medlemskapet ditt fra Patreon.",
    not_member: "Denne siden er for betalende Patreon-medlemmer.",
    wrong_tier: "Denne siden er for betalende medlemmer. Oppgrader på Patreon for å få tilgang.",
    unauthorized: "Økten er utløpt. Logg inn på nytt.",
    bad_redirect: "Tilbake-URL fra Patreon matcher ikke. Sjekk Redirect URIs i Patreon-klienten.",
    invalid_race: "Skriv inn et løpsnavn.",
    invalid_date: "Datoen er ugyldig.",
    invalid_url: "Lenken må starte med http:// eller https://",
    server_error: "Noe gikk galt. Prøv igjen om litt.",
  };

  const clientId = (root.dataset.clientId || "").trim();
  const api = (root.dataset.api || "").replace(/\/$/, "");
  const page = root.dataset.page || "hub";
  const redirectUri = window.location.origin + "/auth/patreon/callback";
  const currentYear = new Date().getFullYear();

  if (page === "callback") {
    handleCallback();
    return;
  }

  let calendar = { members: [] };
  let view = "people";
  let query = "";
  let year = readYearFromUrl();

  bind();
  init();

  function bind() {
    const login = root.querySelector("[data-login]");
    const logout = root.querySelector("[data-logout]");
    const search = root.querySelector("[data-search]");
    if (login) login.addEventListener("click", startLogin);
    if (logout) logout.addEventListener("click", function () {
      localStorage.removeItem(STORAGE);
      show("locked");
    });
    if (search) {
      search.addEventListener("input", function () {
        query = search.value || "";
        renderCalendar();
      });
    }
    root.querySelectorAll("[data-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        view = btn.dataset.view || "people";
        root.querySelectorAll("[data-view]").forEach(function (el) {
          el.setAttribute("aria-selected", el === btn ? "true" : "false");
        });
        renderCalendar();
      });
    });
    root.querySelectorAll("[data-year-delta]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const delta = parseInt(btn.dataset.yearDelta, 10) || 0;
        setYear(year + delta);
      });
    });
    const form = root.querySelector("[data-race-form]");
    if (form) form.addEventListener("submit", submitRace);
  }

  function startLogin(event) {
    event.preventDefault();
    if (!clientId || !api) {
      setStatus("locked", MESSAGES.missing_config);
      return;
    }
    const state = randomState();
    sessionStorage.setItem(STATE, state);
    sessionStorage.setItem(RETURN, location.pathname + location.search);
    const url = new URL("https://www.patreon.com/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "identity");
    url.searchParams.set("state", state);
    window.location.href = url.toString();
  }

  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    const code = params.get("code");
    const state = params.get("state");
    const expected = sessionStorage.getItem(STATE) || "";
    const next = safeReturn(sessionStorage.getItem(RETURN));
    sessionStorage.removeItem(STATE);
    sessionStorage.removeItem(RETURN);

    const statusEl = root.querySelector("[data-callback-status]");
    if (err) {
      if (statusEl) statusEl.textContent = "Innlogging avbrutt.";
      return;
    }
    if (!code || !state || state !== expected) {
      if (statusEl) statusEl.textContent = "Ugyldig innloggingssvar. Gå tilbake og prøv igjen.";
      return;
    }
    if (!api) {
      if (statusEl) statusEl.textContent = MESSAGES.missing_config;
      return;
    }

    try {
      const data = await apiPost("/oauth/exchange", { code: code, redirect_uri: redirectUri });
      localStorage.setItem(STORAGE, JSON.stringify({ token: data.token, name: data.name || "" }));
      window.location.replace(next);
    } catch (e) {
      if (statusEl) statusEl.textContent = MESSAGES[e.message] || MESSAGES.server_error;
    }
  }

  async function init() {
    const session = readSession();
    if (!session) {
      show("locked");
      if (!clientId || !api) setStatus("locked", MESSAGES.missing_config);
      return;
    }
    if (!api) {
      show("locked");
      setStatus("locked", MESSAGES.missing_config);
      return;
    }
    show("loading");
    try {
      if (page === "calendar") {
        const data = await apiGet("/calendar", session.token);
        calendar = data;
        greet(data.name || session.name);
        fillClaimSelect();
        setDefaultFormDate();
        renderCalendar();
      } else {
        let data;
        try {
          data = await apiGet("/me", session.token);
        } catch (err) {
          if (err.message !== "not_found") throw err;
          data = await apiGet("/calendar", session.token);
        }
        greet(data.name || session.name);
      }
      show("open");
    } catch (e) {
      localStorage.removeItem(STORAGE);
      show("locked");
      setStatus("locked", MESSAGES[e.message] || MESSAGES.unauthorized);
    }
  }

  function greet(name) {
    const hello = root.querySelector("[data-hello]");
    if (hello) hello.textContent = name ? "Hei, " + name + "." : "Du er innlogget.";
  }

  function members() {
    return Array.isArray(calendar.members) ? calendar.members : [];
  }

  function raceYear(race) {
    if (race && race.date_iso && /^\d{4}/.test(race.date_iso)) {
      return parseInt(race.date_iso.slice(0, 4), 10);
    }
    const m = String((race && race.date) || "").match(/(20\d{2})/);
    return m ? parseInt(m[1], 10) : null;
  }

  function raceInYear(race, y) {
    const ry = raceYear(race);
    if (ry === y) return true;
    if (ry === null && y === currentYear) return true;
    return false;
  }

  function memberForYear(member, y) {
    const all = member.races || [];
    const races = all.filter(function (race) {
      return raceInYear(race, y);
    });
    if (races.length) return Object.assign({}, member, { races: races });
    if (!all.length && y === currentYear) return Object.assign({}, member, { races: [] });
    return null;
  }

  function haystack(member) {
    const bits = [member.name];
    (member.races || []).forEach(function (race) {
      bits.push(race.name, race.distance, race.elevation, race.date, race.comment);
    });
    return bits.filter(Boolean).join(" ").toLowerCase();
  }

  function filteredMembers() {
    const forYear = members()
      .map(function (member) {
        return memberForYear(member, year);
      })
      .filter(Boolean);
    const q = query.trim().toLowerCase();
    if (!q) return forYear;
    return forYear.filter(function (member) {
      return haystack(member).indexOf(q) !== -1;
    });
  }

  function renderCalendar() {
    const label = root.querySelector("[data-year-label]");
    if (label) {
      label.textContent = year === currentYear ? year + " (i år)" : String(year);
    }
    const list = filteredMembers();
    const peopleEl = root.querySelector("[data-people]");
    const timelineEl = root.querySelector("[data-timeline]");
    const empty = root.querySelector("[data-empty]");
    const stats = root.querySelector("[data-stats]");
    const raceCount = list.reduce(function (n, m) {
      return n + (m.races || []).length;
    }, 0);
    if (stats) {
      stats.textContent =
        list.length +
        " " +
        (list.length === 1 ? "person" : "personer") +
        " · " +
        raceCount +
        " " +
        (raceCount === 1 ? "løp" : "løp");
    }

    const noHits = list.length === 0;
    if (empty) {
      empty.hidden = !noHits;
      empty.textContent = query.trim()
        ? "Ingen treff."
        : "Ingen løp registrert for " + year + " ennå.";
    }
    if (peopleEl) peopleEl.hidden = view !== "people" || noHits;
    if (timelineEl) timelineEl.hidden = view !== "timeline" || noHits;
    if (noHits) return;

    if (view === "timeline") {
      renderTimeline(timelineEl, list);
    } else {
      renderPeople(peopleEl, list);
    }
  }

  function renderPeople(el, list) {
    el.innerHTML = "";
    list.forEach(function (member) {
      el.appendChild(personCard(member));
    });
  }

  function personCard(member) {
    const art = document.createElement("article");
    art.className = "race-person";
    if (calendar.self && calendar.self.name === member.name) {
      art.classList.add("race-person--mine");
    }
    const head = document.createElement("header");
    head.className = "race-person__head";
    const h = document.createElement("h2");
    h.className = "race-person__name";
    h.textContent = member.name;
    head.appendChild(h);
    const social = document.createElement("p");
    social.className = "race-person__social";
    addLink(social, member.strava, "Strava");
    addLink(social, member.instagram, "Instagram");
    if (social.childNodes.length) head.appendChild(social);
    art.appendChild(head);

    const races = member.races || [];
    if (!races.length) {
      const none = document.createElement("p");
      none.className = "race-person__none";
      none.textContent = "Ingen løp registrert ennå.";
      art.appendChild(none);
      return art;
    }
    const ul = document.createElement("ul");
    ul.className = "race-person__races";
    races.forEach(function (race) {
      ul.appendChild(raceRow(race));
    });
    art.appendChild(ul);
    return art;
  }

  function raceRow(race, runnerName) {
    const li = document.createElement("li");
    li.className = "race-cal__item";
    const date = document.createElement("time");
    date.className = "race-cal__date";
    if (race.date_iso) date.dateTime = race.date_iso;
    date.textContent = formatDate(race) || "Uten dato";
    const body = document.createElement("div");
    body.className = "race-cal__body";
    const title = document.createElement(race.url ? "a" : "span");
    title.className = "race-cal__name";
    title.textContent = race.name || "Løp";
    if (race.url) {
      title.href = race.url;
      title.rel = "noopener noreferrer";
    }
    body.appendChild(title);
    if (runnerName) {
      const who = document.createElement("p");
      who.className = "race-cal__runner";
      who.textContent = runnerName;
      body.appendChild(who);
    }
    const metaBits = [race.distance, elevationLabel(race.elevation)].filter(Boolean);
    if (metaBits.length) {
      const meta = document.createElement("p");
      meta.className = "race-cal__meta";
      meta.textContent = metaBits.join(" · ");
      body.appendChild(meta);
    }
    if (race.comment) {
      const note = document.createElement("p");
      note.className = "race-cal__comment";
      note.textContent = race.comment;
      body.appendChild(note);
    }
    li.appendChild(date);
    li.appendChild(body);
    return li;
  }

  function renderTimeline(el, list) {
    const rows = [];
    list.forEach(function (member) {
      (member.races || []).forEach(function (race) {
        rows.push({ member: member, race: race, sort: race.date_iso || "9999-99-99" });
      });
    });
    rows.sort(function (a, b) {
      if (a.sort === b.sort) return (a.member.name || "").localeCompare(b.member.name || "", "nb");
      return a.sort < b.sort ? -1 : 1;
    });
    el.innerHTML = "";
    rows.forEach(function (row) {
      el.appendChild(raceRow(row.race, row.member.name));
    });
  }

  function addLink(parent, href, label) {
    if (!href) return;
    if (parent.childNodes.length) {
      parent.appendChild(document.createTextNode(" · "));
    }
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener noreferrer";
    a.textContent = label;
    parent.appendChild(a);
  }

  function elevationLabel(value) {
    if (!value) return "";
    if (/[a-zæøå]/i.test(value)) return value;
    return value + " hm";
  }

  function formatDate(race) {
    if (race && race.date_iso) {
      const d = new Date(race.date_iso + "T12:00:00");
      if (!Number.isNaN(d.getTime())) {
        return new Intl.DateTimeFormat("nb-NO", {
          day: "numeric",
          month: "short",
        }).format(d);
      }
    }
    return (race && race.date) || "";
  }

  function fillClaimSelect() {
    const wrap = root.querySelector("[data-claim-wrap]");
    const select = root.querySelector("[data-claim-name]");
    if (!wrap || !select) return;
    const claimed = calendar.self && calendar.self.claimed;
    if (claimed) {
      wrap.hidden = true;
      select.innerHTML = "";
      return;
    }
    wrap.hidden = false;
    const myName = (calendar.self && calendar.self.name) || "";
    const names = Array.isArray(calendar.unclaimed) ? calendar.unclaimed.slice() : [];
    select.innerHTML = "";
    const fresh = document.createElement("option");
    fresh.value = "";
    fresh.textContent = myName ? "Ny profil: " + myName : "Ny profil";
    select.appendChild(fresh);
    names.forEach(function (name) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (calendar.suggested && calendar.suggested === name) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function setDefaultFormDate() {
    const input = root.querySelector('[data-race-form] input[name="date"]');
    if (!input || input.value) return;
    if (year === currentYear) {
      const now = new Date();
      input.value = now.toISOString().slice(0, 10);
    } else {
      input.value = year + "-06-01";
    }
  }

  async function submitRace(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = root.querySelector("[data-form-status]");
    const session = readSession();
    if (!session) {
      show("locked");
      return;
    }
    const body = {
      name: valueOf(form, "name"),
      date: valueOf(form, "date"),
      distance: valueOf(form, "distance"),
      elevation: valueOf(form, "elevation"),
      comment: valueOf(form, "comment"),
      url: valueOf(form, "url"),
    };
    const claimWrap = root.querySelector("[data-claim-wrap]");
    const claim = root.querySelector("[data-claim-name]");
    if (claimWrap && !claimWrap.hidden && claim && claim.value) body.claim_name = claim.value;
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    if (status) status.textContent = "";
    try {
      const data = await apiPost("/races", body, session.token);
      calendar = data;
      greet(data.name || session.name);
      fillClaimSelect();
      const raceYear = parseInt((body.date || "").slice(0, 4), 10);
      if (raceYear >= 2000 && raceYear <= 2100 && raceYear !== year) setYear(raceYear);
      else renderCalendar();
      form.reset();
      setDefaultFormDate();
      if (status) status.textContent = "Løpet er lagret.";
    } catch (e) {
      if (status) status.textContent = MESSAGES[e.message] || MESSAGES.server_error;
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function valueOf(form, name) {
    const el = form.elements[name];
    return el ? String(el.value || "").trim() : "";
  }

  function readYearFromUrl() {
    const raw = new URLSearchParams(location.search).get("year");
    const n = parseInt(raw, 10);
    if (n >= 2000 && n <= 2100) return n;
    return currentYear;
  }

  function setYear(next) {
    if (next < 2000 || next > 2100) return;
    year = next;
    const url = new URL(location.href);
    if (year === currentYear) url.searchParams.delete("year");
    else url.searchParams.set("year", String(year));
    history.replaceState({}, "", url.pathname + url.search);
    setDefaultFormDate();
    renderCalendar();
  }

  function safeReturn(path) {
    if (!path || path.charAt(0) !== "/" || path.indexOf("//") !== -1) return HOME;
    const bare = path.split("?")[0];
    if (bare === "/community" || bare === "/community/" || bare.indexOf("/community/") === 0) {
      return path;
    }
    return HOME;
  }

  function show(which) {
    root.querySelectorAll("[data-panel]").forEach(function (el) {
      el.hidden = el.dataset.panel !== which;
    });
  }

  function setStatus(panel, text) {
    const el = root.querySelector('[data-panel="' + panel + '"] [data-status]');
    if (el) el.textContent = text || "";
  }

  function readSession() {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.token ? parsed : null;
    } catch {
      return null;
    }
  }

  function randomState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  async function apiGet(path, token) {
    const res = await fetch(api + path, {
      headers: { Authorization: "Bearer " + token },
    });
    return parseApi(res);
  }

  async function apiPost(path, body, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(api + path, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });
    return parseApi(res);
  }

  async function parseApi(res) {
    const data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      const err = new Error(data.error || "server_error");
      throw err;
    }
    return data;
  }
})();
