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
    already_added: "Du er allerede på dette løpet.",
    race_not_found: "Fant ikke løpet.",
    server_error: "Noe gikk galt. Prøv igjen om litt.",
  };

  const clientId = (root.dataset.clientId || "").trim();
  const api = (root.dataset.api || "").replace(/\/$/, "");
  const page = root.dataset.page || "hub";
  const redirectUri = window.location.origin + "/auth/patreon/callback";
  const currentYear = new Date().getFullYear();
  const DEFAULT_YEAR = Math.max(2027, currentYear);
  const RACE_CATALOG = readRaceCatalog();

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
    const search = root.querySelector("[data-search]");
    if (login) login.addEventListener("click", startLogin);
    document.querySelectorAll("[data-logout]").forEach(function (logout) {
      logout.addEventListener("click", logoutAccount);
    });
    const accountToggle = document.querySelector("[data-account-toggle]");
    const accountDrop = document.querySelector("[data-account-drop]");
    if (accountToggle) {
      accountToggle.addEventListener("click", function (event) {
        event.stopPropagation();
        toggleAccountMenu();
      });
    }
    if (accountDrop) {
      accountDrop.addEventListener("click", function (event) {
        event.stopPropagation();
      });
    }
    document.addEventListener("click", function () {
      closeAccountMenu();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeAccountMenu();
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
    const openForm = root.querySelector("[data-open-form]");
    const closeForm = root.querySelector("[data-close-form]");
    if (form) form.addEventListener("submit", submitRace);
    if (openForm) openForm.addEventListener("click", showRaceForm);
    if (closeForm) closeForm.addEventListener("click", hideRaceForm);
    bindRaceCombo();
    document.addEventListener("click", function (event) {
      const combo = root.querySelector(".race-combo");
      if (combo && !combo.contains(event.target)) closeRaceCombo();
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
      localStorage.setItem(
        STORAGE,
        JSON.stringify({ token: data.token, name: data.name || "", image: data.image || "" })
      );
      window.location.replace(next);
    } catch (e) {
      if (statusEl) statusEl.textContent = MESSAGES[e.message] || MESSAGES.server_error;
    }
  }

  async function init() {
    const session = readSession();
    if (!session) {
      show("locked");
      renderAccount(null);
      if (!clientId || !api) setStatus("locked", MESSAGES.missing_config);
      return;
    }
    renderAccount(session);
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
        rememberProfile(session, data);
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
        rememberProfile(session, data);
        greet(data.name || session.name);
      }
      show("open");
      renderAccount(readSession() || session);
    } catch (e) {
      localStorage.removeItem(STORAGE);
      show("locked");
      renderAccount(null);
      setStatus("locked", MESSAGES[e.message] || MESSAGES.unauthorized);
    }
  }

  function greet(name) {
    const hello = root.querySelector("[data-hello]");
    if (hello) hello.textContent = name ? "Hei, " + name + "." : "Du er innlogget.";
  }

  function rememberProfile(session, data) {
    if (!session || !data) return;
    const image = data.image || (data.self && data.self.avatar) || session.image || "";
    const name = data.name || session.name || "";
    if (image === session.image && name === session.name) return;
    session.image = image;
    session.name = name;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(session));
    } catch {
      /* ignore */
    }
  }

  function logoutAccount() {
    localStorage.removeItem(STORAGE);
    closeAccountMenu();
    renderAccount(null);
    window.location.replace(HOME);
  }

  function accountEls() {
    return {
      wrap: document.querySelector("[data-account]"),
      toggle: document.querySelector("[data-account-toggle]"),
      drop: document.querySelector("[data-account-drop]"),
      img: document.querySelector("[data-account-img]"),
      fallback: document.querySelector("[data-account-fallback]"),
    };
  }

  function toggleAccountMenu() {
    const els = accountEls();
    if (!els.wrap || !els.drop || !els.toggle || els.wrap.hidden) return;
    const open = els.drop.hidden;
    els.drop.hidden = !open;
    els.toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeAccountMenu() {
    const els = accountEls();
    if (!els.drop || !els.toggle) return;
    els.drop.hidden = true;
    els.toggle.setAttribute("aria-expanded", "false");
  }

  function renderAccount(session) {
    const els = accountEls();
    if (!els.wrap) return;
    if (!session) {
      closeAccountMenu();
      els.wrap.hidden = true;
      return;
    }
    els.wrap.hidden = false;
    const url = safeClientImage(session.image || (calendar.self && calendar.self.avatar));
    if (els.toggle) {
      els.toggle.setAttribute("aria-label", session.name ? "Konto, " + session.name : "Konto");
    }
    if (els.img && url) {
      els.img.src = url;
      els.img.alt = session.name || "";
      els.img.hidden = false;
      els.img.onerror = function () {
        els.img.hidden = true;
        if (els.fallback) {
          els.fallback.hidden = false;
          els.fallback.textContent = initials(session.name || "");
        }
      };
      if (els.fallback) els.fallback.hidden = true;
    } else {
      if (els.img) {
        els.img.removeAttribute("src");
        els.img.hidden = true;
      }
      if (els.fallback) {
        els.fallback.hidden = false;
        els.fallback.textContent = initials(session.name || "");
      }
    }
  }

  function initials(name) {
    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function safeClientImage(url) {
    const s = String(url || "").trim();
    if (!s || s.length > 1000) return "";
    if (!/^https:\/\//i.test(s)) return "";
    return s;
  }

  function avatarEl(member, extraClass) {
    const wrap = document.createElement("span");
    wrap.className = extraClass ? "avatar " + extraClass : "avatar";
    const url = safeClientImage(member && member.avatar);
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", function () {
        wrap.textContent = initials(member && member.name);
      });
      wrap.appendChild(img);
    } else {
      wrap.textContent = initials(member && member.name);
    }
    return wrap;
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
    if (ry === null && y === DEFAULT_YEAR) return true;
    return false;
  }

  function memberForYear(member, y) {
    const all = member.races || [];
    const races = all.filter(function (race) {
      return raceInYear(race, y);
    });
    if (races.length) return Object.assign({}, member, { races: races });
    if (!all.length && y === DEFAULT_YEAR) return Object.assign({}, member, { races: [] });
    return null;
  }

  function haystack(member) {
    const bits = [member.name];
    (member.races || []).forEach(function (race) {
      bits.push(race.name, race.distance, race.elevation, race.date, race.time, race.place, race.comment);
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
    const identity = document.createElement("div");
    identity.className = "race-person__identity";
    identity.appendChild(avatarEl(member));
    const h = document.createElement("h2");
    h.className = "race-person__name";
    h.textContent = member.name;
    identity.appendChild(h);
    head.appendChild(identity);
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
      ul.appendChild(raceRow(race, member, false));
    });
    art.appendChild(ul);
    return art;
  }

  function raceRow(race, member, showOwner) {
    const ownerName = member && member.name;
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
    const heading = document.createElement("div");
    heading.className = "race-cal__heading";
    heading.appendChild(title);
    if (canJoinRace(race, ownerName)) heading.appendChild(joinButton(race));
    body.appendChild(heading);
    if (showOwner && ownerName) {
      const who = document.createElement("p");
      who.className = "race-cal__runner";
      who.appendChild(avatarEl(member, "avatar--sm"));
      who.appendChild(document.createTextNode(ownerName));
      body.appendChild(who);
    }
    const metaBits = [race.distance, elevationLabel(race.elevation)].filter(Boolean);
    if (metaBits.length) {
      const meta = document.createElement("p");
      meta.className = "race-cal__meta";
      meta.textContent = metaBits.join(" · ");
      body.appendChild(meta);
    }
    const resultBits = [placeLabel(race.place), race.time].filter(Boolean);
    if (resultBits.length) {
      const result = document.createElement("p");
      result.className = "race-cal__result";
      result.textContent = resultBits.join(" · ");
      body.appendChild(result);
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
      el.appendChild(raceRow(row.race, row.member, true));
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

  function placeLabel(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    if (/[a-zæøå./]/i.test(s)) return s;
    return s + ". plass";
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

  function normName(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function raceKey(race) {
    return normName(race.name) + "|" + (race.date_iso || "");
  }

  function myRaces() {
    const mine = calendar.self && calendar.self.name;
    const member = members().find(function (m) {
      return m.name === mine;
    });
    return member && member.races ? member.races : [];
  }

  function alreadyHave(race) {
    const key = raceKey(race);
    return myRaces().some(function (row) {
      return raceKey(row) === key;
    });
  }

  function joinButton(race) {
    const join = document.createElement("button");
    join.type = "button";
    join.className = "race-cal__join";
    const label = "Jeg skal også løpe dette løpet";
    join.title = label;
    join.setAttribute("aria-label", label);
    join.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    join.addEventListener("click", function () {
      joinRace(race, join);
    });
    return join;
  }

  function canJoinRace(race, ownerName) {
    if (!race || !race.name || !race.date_iso) return false;
    if (calendar.self && ownerName && ownerName === calendar.self.name) return false;
    return !alreadyHave(race);
  }

  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  function catalogRaces() {
    return RACE_CATALOG.map(function (row) {
      const y = String(year);
      let date_iso = (row.dates && row.dates[y]) || year + "-" + (row.month_day || "06-01");
      if (date_iso.slice(5) === "02-29" && !isLeapYear(year)) date_iso = year + "-02-28";
      return {
        name: row.name,
        date_iso: date_iso,
        url: row.url || "",
        count: 0,
      };
    });
  }

  function uniqueRaces() {
    const map = {};
    catalogRaces().forEach(function (race) {
      if (!race.name) return;
      map[raceKey(race)] = race;
    });
    members().forEach(function (member) {
      (member.races || []).forEach(function (race) {
        if (!race.name) return;
        const key = raceKey(race);
        if (!map[key]) {
          map[key] = {
            name: race.name,
            date: race.date || "",
            date_iso: race.date_iso || "",
            distance: race.distance || "",
            elevation: race.elevation || "",
            url: race.url || "",
            count: 1,
          };
        } else {
          map[key].count += 1;
          if (!map[key].distance && race.distance) map[key].distance = race.distance;
          if (!map[key].elevation && race.elevation) map[key].elevation = race.elevation;
          if (!map[key].url && race.url) map[key].url = race.url;
        }
      });
    });
    return Object.keys(map)
      .map(function (k) {
        return map[k];
      })
      .sort(function (a, b) {
        const ay = a.date_iso || "9999";
        const by = b.date_iso || "9999";
        if (ay === by) return a.name.localeCompare(b.name, "nb");
        return ay < by ? -1 : 1;
      });
  }

  function bindRaceCombo() {
    const input = root.querySelector("[data-race-combo]");
    if (!input || input.dataset.bound) return;
    input.dataset.bound = "1";
    input.addEventListener("input", function () {
      renderRaceCombo(input.value);
    });
    input.addEventListener("focus", function () {
      renderRaceCombo(input.value);
    });
    const list = root.querySelector("[data-race-list]");
    if (list) {
      list.addEventListener("mousedown", function (event) {
        event.preventDefault();
      });
    }
    input.addEventListener("keydown", function (event) {
      const list = root.querySelector("[data-race-list]");
      const items = list ? list.querySelectorAll("[data-combo-opt]") : [];
      const current = list ? list.querySelector("[data-combo-opt][aria-selected='true']") : null;
      let idx = Array.prototype.indexOf.call(items, current);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!items.length) renderRaceCombo(input.value);
        idx = Math.min(idx + 1, items.length - 1);
        highlightCombo(items, idx);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        idx = Math.max(idx - 1, 0);
        highlightCombo(items, idx);
      } else if (event.key === "Enter") {
        if (current) {
          event.preventDefault();
          current.click();
        }
      } else if (event.key === "Escape") {
        closeRaceCombo();
      }
    });
  }

  function highlightCombo(items, idx) {
    items.forEach(function (el, i) {
      el.setAttribute("aria-selected", i === idx ? "true" : "false");
    });
    if (items[idx]) items[idx].scrollIntoView({ block: "nearest" });
  }

  function renderRaceCombo(raw) {
    const list = root.querySelector("[data-race-list]");
    const input = root.querySelector("[data-race-combo]");
    if (!list || !input) return;
    const q = String(raw || "").trim();
    const qn = normName(q);
    let races = uniqueRaces();
    if (qn) {
      races = races.filter(function (race) {
        return (
          normName(race.name).indexOf(qn) !== -1 ||
          String(race.date || "").toLowerCase().indexOf(q.toLowerCase()) !== -1
        );
      });
    }
    const inYear = [];
    const other = [];
    races.forEach(function (race) {
      const y = race.date_iso ? parseInt(race.date_iso.slice(0, 4), 10) : null;
      if (y === year || (!y && year === DEFAULT_YEAR)) inYear.push(race);
      else other.push(race);
    });
    const shown = (qn ? inYear.concat(other) : inYear).slice(0, 60);
    list.innerHTML = "";
    shown.forEach(function (race, i) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "race-combo__opt";
      btn.setAttribute("data-combo-opt", "1");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", i === 0 ? "true" : "false");
      const label = race.date_iso || race.date ? race.name + " · " + (formatDate(race) || race.date) : race.name;
      btn.textContent = race.count > 0 ? label + " (" + race.count + ")" : label;
      btn.addEventListener("click", function () {
        applyExistingRace(race);
        closeRaceCombo();
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
    if (q.length >= 2) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "race-combo__opt race-combo__opt--create";
      btn.setAttribute("data-combo-opt", "1");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", shown.length === 0 ? "true" : "false");
      btn.textContent = "Opprett «" + q + "»";
      btn.addEventListener("click", function () {
        input.value = q;
        closeRaceCombo();
        const date = root.querySelector('[data-race-form] input[name="date"]');
        if (date && !date.value) setDefaultFormDate();
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    const has = list.childNodes.length > 0;
    list.hidden = !has;
    input.setAttribute("aria-expanded", has ? "true" : "false");
  }

  function applyExistingRace(race) {
    const form = root.querySelector("[data-race-form]");
    if (!form) return;
    form.elements.name.value = race.name || "";
    if (race.date_iso) form.elements.date.value = race.date_iso;
    else setDefaultFormDate();
    form.elements.distance.value = race.distance || "";
    form.elements.elevation.value = race.elevation || "";
    form.elements.url.value = race.url || "";
    const mine = myRaces().find(function (row) {
      return raceKey(row) === raceKey(race);
    });
    form.elements.time.value = (mine && mine.time) || "";
    form.elements.place.value = (mine && mine.place) || "";
    form.elements.comment.value = (mine && mine.comment) || "";
  }

  function closeRaceCombo() {
    const list = root.querySelector("[data-race-list]");
    const input = root.querySelector("[data-race-combo]");
    if (list) list.hidden = true;
    if (input) input.setAttribute("aria-expanded", "false");
  }

  async function joinRace(race, button) {
    const session = readSession();
    if (!session) {
      show("locked");
      return;
    }
    if (button) button.disabled = true;
    const body = { name: race.name, date: race.date_iso || "", date_iso: race.date_iso || "" };
    const claimWrap = root.querySelector("[data-claim-wrap]");
    const claim = root.querySelector("[data-claim-name]");
    if (claimWrap && !claimWrap.hidden && claim && claim.value) body.claim_name = claim.value;
    else if (calendar.suggested) body.claim_name = calendar.suggested;
    try {
      const data = await apiPost("/races/join", body, session.token);
      calendar = data;
      rememberProfile(session, data);
      renderAccount(readSession() || session);
      greet(data.name || session.name);
      fillClaimSelect();
      const raceYear = race.date_iso ? parseInt(race.date_iso.slice(0, 4), 10) : year;
      if (raceYear >= 2000 && raceYear <= 2100 && raceYear !== year) setYear(raceYear);
      else renderCalendar();
    } catch (e) {
      if (button) {
        const msg = MESSAGES[e.message] || MESSAGES.server_error;
        button.title = msg;
        button.setAttribute("aria-label", msg);
        button.disabled = false;
      }
    }
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

  function showRaceForm() {
    const form = root.querySelector("[data-race-form]");
    const addRow = root.querySelector(".race-cal__add-row");
    if (!form) return;
    form.hidden = false;
    if (addRow) addRow.hidden = true;
    form.reset();
    const status = root.querySelector("[data-form-status]");
    if (status) status.textContent = "";
    setDefaultFormDate();
    const name = form.querySelector("[data-race-combo]");
    if (name) name.focus();
    renderRaceCombo("");
  }

  function hideRaceForm() {
    const form = root.querySelector("[data-race-form]");
    const addRow = root.querySelector(".race-cal__add-row");
    if (form) {
      form.hidden = true;
      form.reset();
    }
    closeRaceCombo();
    if (addRow) addRow.hidden = false;
    const status = root.querySelector("[data-form-status]");
    if (status) status.textContent = "";
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
      time: valueOf(form, "time"),
      place: valueOf(form, "place"),
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
      rememberProfile(session, data);
      renderAccount(readSession() || session);
      greet(data.name || session.name);
      fillClaimSelect();
      const raceYear = parseInt((body.date || "").slice(0, 4), 10);
      if (raceYear >= 2000 && raceYear <= 2100 && raceYear !== year) setYear(raceYear);
      else renderCalendar();
      form.reset();
      hideRaceForm();
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
    return DEFAULT_YEAR;
  }

  function setYear(next) {
    if (next < 2000 || next > 2100) return;
    year = next;
    const url = new URL(location.href);
    if (year === DEFAULT_YEAR) url.searchParams.delete("year");
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

  function readRaceCatalog() {
    const el = document.getElementById("race-catalog");
    if (!el) return [];
    try {
      const parsed = JSON.parse(el.textContent || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
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
