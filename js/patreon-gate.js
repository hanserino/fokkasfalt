(function () {
  const root = document.getElementById("patreon-gate");
  if (!root) return;

  const STORAGE = "fa_patreon_session";
  const STATE = "fa_patreon_oauth_state";
  const MESSAGES = {
    missing_config: "Innlogging er ikke ferdig satt opp ennå.",
    exchange_failed: "Patreon avviste innloggingen. Prøv igjen.",
    identity_failed: "Fikk ikke hentet medlemskapet ditt fra Patreon.",
    not_member: "Denne siden er for betalende Patreon-medlemmer.",
    wrong_tier: "Denne siden er for betalende medlemmer. Oppgrader på Patreon for å få tilgang.",
    unauthorized: "Økten er utløpt. Logg inn på nytt.",
    bad_redirect: "Tilbake-URL fra Patreon matcher ikke. Sjekk Redirect URIs i Patreon-klienten.",
    server_error: "Noe gikk galt. Prøv igjen om litt.",
  };

  const clientId = (root.dataset.clientId || "").trim();
  const api = (root.dataset.api || "").replace(/\/$/, "");
  const page = root.dataset.page || "calendar";
  const redirectUri = window.location.origin + "/auth/patreon/callback";

  if (page === "callback") {
    handleCallback();
    return;
  }

  bind();
  initCalendar();

  function bind() {
    const login = root.querySelector("[data-login]");
    const logout = root.querySelector("[data-logout]");
    if (login) login.addEventListener("click", startLogin);
    if (logout) logout.addEventListener("click", function () {
      localStorage.removeItem(STORAGE);
      show("locked");
    });
  }

  function startLogin(event) {
    event.preventDefault();
    if (!clientId || !api) {
      setStatus("locked", MESSAGES.missing_config);
      return;
    }
    const state = randomState();
    sessionStorage.setItem(STATE, state);
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
    sessionStorage.removeItem(STATE);

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
      window.location.replace("/race-kalender-2027/");
    } catch (e) {
      if (statusEl) statusEl.textContent = MESSAGES[e.message] || MESSAGES.server_error;
    }
  }

  async function initCalendar() {
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
      const data = await apiGet("/calendar", session.token);
      renderRaces(data.races || [], data.name || session.name || "");
      show("open");
    } catch (e) {
      localStorage.removeItem(STORAGE);
      show("locked");
      setStatus("locked", MESSAGES[e.message] || MESSAGES.unauthorized);
    }
  }

  function renderRaces(races, name) {
    const hello = root.querySelector("[data-hello]");
    const list = root.querySelector("[data-races]");
    const empty = root.querySelector("[data-empty]");
    if (hello) {
      hello.textContent = name ? "Hei, " + name + "." : "Du er innlogget.";
    }
    if (!list) return;
    list.innerHTML = "";
    if (!races.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    races.forEach(function (race) {
      const li = document.createElement("li");
      li.className = "race-cal__item";
      const date = document.createElement("time");
      date.className = "race-cal__date";
      if (race.date) {
        date.dateTime = race.date;
        date.textContent = formatDate(race.date);
      } else {
        date.textContent = "Uten dato";
      }
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
      const metaBits = [race.place, race.distance].filter(Boolean);
      if (metaBits.length) {
        const meta = document.createElement("p");
        meta.className = "race-cal__meta";
        meta.textContent = metaBits.join(" · ");
        body.appendChild(meta);
      }
      li.appendChild(date);
      li.appendChild(body);
      list.appendChild(li);
    });
  }

  function formatDate(iso) {
    const d = new Date(iso + "T12:00:00");
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("nb-NO", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
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

  async function apiPost(path, body) {
    const res = await fetch(api + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
