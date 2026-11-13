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
    not_member: "Denne siden er for Patreon-medlemmer. Bli medlem og prøv igjen.",
    wrong_tier: "Denne siden er for Patreon-medlemmer. Bli medlem og prøv igjen.",
    unauthorized: "Økten er utløpt. Logg inn på nytt.",
    bad_redirect: "Tilbake-URL fra Patreon matcher ikke. Sjekk Redirect URIs i Patreon-klienten.",
    invalid_race: "Skriv inn et løpsnavn.",
    invalid_date: "Datoen er ugyldig.",
    invalid_url: "Lenken må starte med http:// eller https://",
    already_added: "Du er allerede på dette løpet.",
    race_not_found: "Fant ikke løpet.",
    invalid_alias: "Velg et visningsnavn på minst to tegn.",
    alias_taken: "Det visningsnavnet er allerede i bruk.",
    invalid_instagram: "Instagram-lenken er ugyldig. Bruk @brukernavn eller en instagram.com-lenke.",
    invalid_strava: "Strava-lenken er ugyldig. Bruk en strava.com/athletes-lenke.",
    server_error: "Noe gikk galt. Prøv igjen om litt.",
  };
  const IN_APP_HINT =
    "Åpne community i Safari eller Chrome (ikke Slack, Instagram eller Messenger) og logg inn der.";

  const clientId = (root.dataset.clientId || "").trim();
  const api = (root.dataset.api || "").replace(/\/$/, "");
  const page = root.dataset.page || "hub";
  const redirectUri = oauthRedirectUri();
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
  let editingRace = null;
  let modalRace = null;
  let modalMember = null;

  bind();
  init();

  function bind() {
    const login = root.querySelector("[data-login]");
    const search = root.querySelector("[data-search]");
    if (login) login.addEventListener("click", startLogin);
    document.querySelectorAll("[data-logout]").forEach(function (logout) {
      logout.addEventListener("click", logoutAccount);
    });
    const settingsBtn = document.querySelector("[data-settings]");
    const settingsClose = document.querySelector("[data-settings-close]");
    const settingsForm = document.querySelector("[data-settings-form]");
    const settingsPanel = document.querySelector("[data-settings-panel]");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        closeAccountMenu();
        openSettings();
      });
    }
    if (settingsClose) settingsClose.addEventListener("click", closeSettings);
    if (settingsForm) settingsForm.addEventListener("submit", submitSettings);
    if (settingsPanel) {
      settingsPanel.addEventListener("click", function (event) {
        if (event.target === settingsPanel) closeSettings();
      });
    }
    const settingsAlias = document.querySelector("[data-settings-form] input[name='alias']");
    const claimAlias = root.querySelector("[data-claim-name]");
    if (settingsAlias) {
      settingsAlias.addEventListener("input", function () {
        syncAliasInputs(settingsAlias);
      });
    }
    if (claimAlias) {
      claimAlias.addEventListener("input", function () {
        syncAliasInputs(claimAlias);
      });
      claimAlias.addEventListener("change", function () {
        saveAliasFromClaim();
      });
    }
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
      closeRaceMenus();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        const raceModal = document.querySelector("[data-race-modal]");
        if (raceModal && !raceModal.hidden) {
          closeRaceModal();
          return;
        }
        const memberModal = document.querySelector("[data-member-modal]");
        if (memberModal && !memberModal.hidden) {
          closeMemberModal();
          return;
        }
        closeSettings();
        closeAccountMenu();
        closeRaceMenus();
        const list = root.querySelector("[data-race-list]");
        if (list && !list.hidden) {
          closeRaceCombo();
          return;
        }
        const form = root.querySelector("[data-race-form]");
        if (form && !form.hidden) hideRaceForm();
      }
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
    const dateInput = root.querySelector('[data-race-form] input[name="date"]');
    if (dateInput) dateInput.addEventListener("input", syncResultFields);
    if (dateInput) dateInput.addEventListener("change", syncResultFields);
    const timed = root.querySelector("[data-timed]");
    if (timed) timed.addEventListener("change", syncTimedFields);
    const raceModal = document.querySelector("[data-race-modal]");
    const raceModalClose = document.querySelector("[data-race-modal-close]");
    const raceModalJoin = document.querySelector("[data-race-modal-join]");
    if (raceModal) {
      raceModal.addEventListener("click", function (event) {
        if (event.target === raceModal) closeRaceModal();
      });
    }
    if (raceModalClose) raceModalClose.addEventListener("click", closeRaceModal);
    if (raceModalJoin) {
      raceModalJoin.addEventListener("click", function () {
        if (modalRace) openJoinForm(modalRace);
      });
    }
    const memberModal = document.querySelector("[data-member-modal]");
    const memberModalClose = document.querySelector("[data-member-modal-close]");
    if (memberModal) {
      memberModal.addEventListener("click", function (event) {
        if (event.target === memberModal) closeMemberModal();
      });
    }
    if (memberModalClose) memberModalClose.addEventListener("click", closeMemberModal);
    window.addEventListener("popstate", syncMemberModalFromUrl);
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
    writeOauthState(state);
    writeOauthReturn(location.pathname + location.search);
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
    const expected = readOauthState();
    const next = safeReturn(readOauthReturn());
    clearOauthState();

    const statusEl = root.querySelector("[data-callback-status]");
    if (err) {
      if (statusEl) statusEl.textContent = "Innlogging avbrutt.";
      return;
    }
    if (!code || !state || state !== expected) {
      if (statusEl) {
        statusEl.textContent = inAppBrowser()
          ? IN_APP_HINT
          : "Innlogginga gikk ut. Gå tilbake til community og prøv igjen i Safari eller Chrome.";
      }
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
        JSON.stringify({
          token: data.token,
          name: data.name || "",
          image: data.image || "",
          perks: data.perks || {},
        })
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
      else if (inAppBrowser()) setStatus("locked", IN_APP_HINT);
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
        fillAliasFields();
        applyPerks(data);
        setDefaultFormDate();
        renderCalendar();
        syncMemberModalFromUrl();
      } else {
        let data;
        try {
          data = await apiGet("/me", session.token);
        } catch (err) {
          if (err.message !== "not_found") throw err;
          data = await apiGet("/calendar", session.token);
        }
        rememberProfile(session, data);
        applyMeToCalendar(data);
        greet(data.display_name || data.name || session.name);
        fillAliasFields();
        applyPerks(data);
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
    const perks = data.perks || (data.self && data.self.perks) || session.perks || {};
    if (image === session.image && name === session.name && session.perks && session.perks.slack === perks.slack) {
      return;
    }
    session.image = image;
    session.name = name;
    session.perks = perks;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(session));
    } catch {
      /* ignore */
    }
  }

  function logoutAccount() {
    localStorage.removeItem(STORAGE);
    closeSettings();
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
    closeRaceMenus();
    els.drop.hidden = !open;
    els.toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeAccountMenu() {
    const els = accountEls();
    if (!els.drop || !els.toggle) return;
    els.drop.hidden = true;
    els.toggle.setAttribute("aria-expanded", "false");
  }

  function applyMeToCalendar(data) {
    if (!data) return;
    calendar.self = calendar.self || {};
    calendar.self.name = data.display_name || data.name || calendar.self.name || "";
    calendar.self.alias = data.alias || "";
    calendar.self.patreon_name = data.name || "";
    calendar.self.avatar = data.image || calendar.self.avatar || "";
    calendar.self.instagram = data.instagram || "";
    calendar.self.strava = data.strava || "";
    calendar.perks = data.perks || calendar.perks || {};
  }

  function applyPerks(data) {
    if (data && data.perks) calendar.perks = data.perks;
    const slack = root.querySelector("[data-perk-slack]");
    if (slack) slack.hidden = !canUseSlack();
  }

  function canUseSlack() {
    const perks = (calendar && calendar.perks) || {};
    return perks.slack === true;
  }

  function currentAlias() {
    return (calendar.self && calendar.self.alias) || "";
  }

  function currentDisplayName() {
    return (calendar.self && calendar.self.name) || "";
  }

  function fillAliasFields() {
    fillSettings();
    fillClaimSelect();
  }

  function fillSettings() {
    const form = document.querySelector("[data-settings-form]");
    if (!form) return;
    const self = calendar.self || {};
    fillInputIfIdle(form.elements.alias, currentAlias());
    fillInputIfIdle(form.elements.instagram, self.instagram || "");
    fillInputIfIdle(form.elements.strava, self.strava || "");
    const status = document.querySelector("[data-settings-status]");
    if (status) status.textContent = "";
  }

  function fillInputIfIdle(input, value) {
    if (!input || document.activeElement === input) return;
    input.value = value || "";
  }

  function syncAliasInputs(source) {
    const value = source ? String(source.value || "") : "";
    const settingsInput = document.querySelector("[data-settings-form] input[name='alias']");
    const claimInput = root.querySelector("[data-claim-name]");
    if (settingsInput && source !== settingsInput) settingsInput.value = value;
    if (claimInput && source !== claimInput) claimInput.value = value;
  }

  function identityPayload(preferred) {
    const claim = root.querySelector("[data-claim-name]");
    const settings = document.querySelector("[data-settings-form] input[name='alias']");
    const typed = String(
      preferred != null
        ? preferred
        : (claim && claim.value) || (settings && settings.value) || currentAlias()
    ).trim();
    const patreon = (calendar.self && calendar.self.patreon_name) || "";
    const body = {
      alias: typed && normClient(typed) !== normClient(patreon) ? typed : "",
    };
    if (calendar.self && calendar.self.claimed) return body;
    const names = Array.isArray(calendar.unclaimed) ? calendar.unclaimed : [];
    const match = names.find(function (name) {
      return normClient(name) === normClient(typed);
    });
    if (match) body.claim_name = match;
    else if (calendar.suggested) body.claim_name = calendar.suggested;
    return body;
  }

  function identityUnchanged(value) {
    const typed = String(value || "").trim();
    const alias = currentAlias();
    const shown = alias || currentDisplayName();
    const patreon = (calendar.self && calendar.self.patreon_name) || "";
    if (normClient(typed) === normClient(shown)) return true;
    if (!typed && !alias) return true;
    if (!alias && normClient(typed) === normClient(patreon)) return true;
    return false;
  }

  function applyProfileData(session, data) {
    calendar = data;
    rememberProfile(session, data);
    greet(data.name || (session && session.name) || "");
    fillAliasFields();
    applyPerks(data);
    renderAccount(readSession() || session);
    if (page === "calendar") {
      renderCalendar();
      if (modalMember) {
        const next = findMemberBySlug(memberSlug(modalMember.name)) || findMemberByName(modalMember.name);
        if (next) fillMemberModal(next);
        else closeMemberModal({ silent: true });
      }
    }
  }

  async function saveAliasFromClaim() {
    const input = root.querySelector("[data-claim-name]");
    if (!input || identityUnchanged(input.value)) return;
    const session = readSession();
    if (!session) return;
    const status = root.querySelector("[data-form-status]");
    try {
      const data = await apiPost("/profile", identityPayload(input.value), session.token);
      applyProfileData(session, data);
    } catch (e) {
      if (status) status.textContent = MESSAGES[e.message] || MESSAGES.server_error;
    }
  }

  function openSettings() {
    const panel = document.querySelector("[data-settings-panel]");
    if (!panel) return;
    fillSettings();
    panel.hidden = false;
    const input = panel.querySelector('input[name="alias"]');
    if (input) input.focus();
  }

  function closeSettings() {
    const panel = document.querySelector("[data-settings-panel]");
    if (panel) panel.hidden = true;
  }

  async function submitSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.querySelector("[data-settings-status]");
    const session = readSession();
    if (!session) {
      show("locked");
      return;
    }
    const body = identityPayload(valueOf(form, "alias"));
    body.instagram = valueOf(form, "instagram");
    body.strava = valueOf(form, "strava");
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    if (status) status.textContent = "";
    try {
      const data = await apiPost("/profile", body, session.token);
      applyProfileData(session, data);
      if (status) status.textContent = "Lagret.";
    } catch (e) {
      if (status) status.textContent = MESSAGES[e.message] || MESSAGES.server_error;
    } finally {
      if (submit) submit.disabled = false;
    }
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

  function memberSlug(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/æ/g, "ae")
      .replace(/ø/g, "o")
      .replace(/å/g, "a")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "bruker";
  }

  function findMemberByName(name) {
    const key = normName(name);
    if (!key) return null;
    return (
      members().find(function (m) {
        return normName(m.name) === key;
      }) || null
    );
  }

  function findMemberBySlug(slug) {
    const want = String(slug || "").trim().toLowerCase();
    if (!want) return null;
    return (
      members().find(function (m) {
        return memberSlug(m.name) === want;
      }) || null
    );
  }

  function memberParamFromUrl() {
    return (new URLSearchParams(location.search).get("member") || "").trim();
  }

  function writeMemberUrl(member) {
    const url = new URL(location.href);
    if (member && member.name) url.searchParams.set("member", memberSlug(member.name));
    else url.searchParams.delete("member");
    history.replaceState({}, "", url.pathname + url.search);
  }

  function memberTrigger(member, className, avatarClass) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.appendChild(avatarEl(member, avatarClass));
    const label = document.createElement("span");
    label.className = className === "race-person__identity" ? "race-person__name" : "";
    label.textContent = (member && member.name) || "";
    btn.appendChild(label);
    btn.setAttribute("aria-label", (member && member.name) || "Profil");
    btn.addEventListener("click", function (event) {
      event.stopPropagation();
      openMemberModal(findMemberByName(member && member.name) || member);
    });
    return btn;
  }

  function fillMemberModal(member) {
    const panel = document.querySelector("[data-member-modal]");
    if (!panel || !member) return;
    modalMember = member;
    const avatarWrap = panel.querySelector("[data-member-modal-avatar]");
    const nameEl = panel.querySelector("[data-member-modal-name]");
    const social = panel.querySelector("[data-member-modal-social]");
    const list = panel.querySelector("[data-member-modal-races]");
    const none = panel.querySelector("[data-member-modal-none]");
    if (avatarWrap) {
      avatarWrap.innerHTML = "";
      avatarWrap.appendChild(avatarEl(member));
    }
    if (nameEl) nameEl.textContent = member.name || "";
    if (social) {
      social.innerHTML = "";
      addLink(social, member.strava, "Strava");
      addLink(social, member.instagram, "Instagram");
      social.hidden = !social.childNodes.length;
    }
    const races = (member.races || []).slice().sort(function (a, b) {
      return String(a.date_iso || "9999").localeCompare(String(b.date_iso || "9999"));
    });
    if (list) {
      list.innerHTML = "";
      races.forEach(function (race) {
        list.appendChild(raceRow(race, member));
      });
      list.hidden = races.length === 0;
    }
    if (none) none.hidden = races.length > 0;
  }

  function openMemberModal(member) {
    if (!member) return;
    const full = findMemberByName(member.name) || member;
    fillMemberModal(full);
    const panel = document.querySelector("[data-member-modal]");
    if (panel) panel.hidden = false;
    writeMemberUrl(full);
  }

  function closeMemberModal(opts) {
    const panel = document.querySelector("[data-member-modal]");
    if (panel) panel.hidden = true;
    modalMember = null;
    if (opts && opts.silent) return;
    if (memberParamFromUrl()) writeMemberUrl(null);
  }

  function syncMemberModalFromUrl() {
    const slug = memberParamFromUrl();
    if (!slug) {
      closeMemberModal({ silent: true });
      return;
    }
    const member = findMemberBySlug(slug);
    if (member) openMemberModal(member);
    else closeMemberModal({ silent: true });
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
    return null;
  }

  function haystack(member) {
    const bits = [member.name, member.instagram, member.strava];
    (member.races || []).forEach(function (race) {
      bits.push(race.name, race.distance, race.elevation, race.date, race.time, race.place, race.comment);
      if (race.timed) bits.push("tidsbasert", "mål");
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
    if (timelineEl) timelineEl.hidden = (view !== "timeline" && view !== "alpha") || noHits;
    if (noHits) return;

    if (view === "timeline") {
      renderTimeline(timelineEl, list);
    } else if (view === "alpha") {
      renderAlpha(timelineEl, list);
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
    head.appendChild(memberTrigger(member, "race-person__identity"));
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

  function raceRow(race, member) {
    const ownerName = member && member.name;
    const li = document.createElement("li");
    li.className = "race-cal__item";
    li.appendChild(raceDateEl(race));
    const body = document.createElement("div");
    body.className = "race-cal__body";
    const heading = document.createElement("div");
    heading.className = "race-cal__heading";
    heading.appendChild(raceNameEl(race));
    if (isOwnRace(ownerName)) heading.appendChild(raceMenu(race));
    body.appendChild(heading);
    appendRaceMeta(body, race);
    li.appendChild(body);
    return li;
  }

  function raceDateEl(race) {
    const date = document.createElement("time");
    date.className = "race-cal__date";
    if (race.date_iso) date.dateTime = race.date_iso;
    date.textContent = formatDate(race) || "Uten dato";
    return date;
  }

  function raceNameEl(race) {
    const title = document.createElement("button");
    title.type = "button";
    title.className = "race-cal__name";
    title.textContent = race.name || "Løp";
    title.addEventListener("click", function (event) {
      event.stopPropagation();
      openRaceModal(race);
    });
    return title;
  }

  function appendRaceMeta(parent, race) {
    const metaBits = [distanceLabel(race), elevationLabel(race.elevation)].filter(Boolean);
    if (metaBits.length) {
      const meta = document.createElement("p");
      meta.className = "race-cal__meta";
      meta.textContent = metaBits.join(" · ");
      parent.appendChild(meta);
    }
    const resultBits = raceFinished(race.date_iso)
      ? [placeLabel(race.place), race.time].filter(Boolean)
      : [];
    if (resultBits.length) {
      const result = document.createElement("p");
      result.className = "race-cal__result";
      result.textContent = resultBits.join(" · ");
      parent.appendChild(result);
    }
    if (race.comment) {
      const note = document.createElement("p");
      note.className = "race-cal__comment";
      note.textContent = race.comment;
      parent.appendChild(note);
    }
  }

  function collectRaceGroups(list, keyFn) {
    const groups = [];
    const indexByKey = {};
    list.forEach(function (member) {
      (member.races || []).forEach(function (race) {
        const key = keyFn(race);
        let group = indexByKey[key];
        if (!group) {
          group = {
            race: race,
            entries: [],
            sort: race.date_iso || "9999-99-99",
          };
          indexByKey[key] = group;
          groups.push(group);
        } else if (!group.race.url && race.url) {
          group.race = race;
        }
        group.entries.push({ member: member, race: race });
      });
    });
    return groups;
  }

  function renderTimeline(el, list) {
    const groups = collectRaceGroups(list, raceKey);
    groups.sort(function (a, b) {
      if (a.sort === b.sort) {
        return (a.race.name || "").localeCompare(b.race.name || "", "nb");
      }
      return a.sort < b.sort ? -1 : 1;
    });
    el.innerHTML = "";
    groups.forEach(function (group) {
      el.appendChild(timelineEvent(group));
    });
  }

  function renderAlpha(el, list) {
    const groups = collectRaceGroups(list, function (race) {
      return normName(race.name);
    });
    groups.sort(function (a, b) {
      return (a.race.name || "").localeCompare(b.race.name || "", "nb");
    });
    el.innerHTML = "";
    groups.forEach(function (group) {
      el.appendChild(alphaEvent(group));
    });
  }

  function uniqueDates(entries) {
    const seen = {};
    const dates = [];
    entries.forEach(function (entry) {
      const iso = (entry.race && entry.race.date_iso) || "";
      if (seen[iso]) return;
      seen[iso] = true;
      dates.push(iso);
    });
    dates.sort();
    return dates;
  }

  function alphaEvent(group) {
    const dates = uniqueDates(group.entries);
    const li = document.createElement("li");
    li.className = "race-cal__item race-cal__item--alpha";
    const heading = document.createElement("div");
    heading.className = "race-cal__heading";
    heading.appendChild(raceNameEl(group.race));
    li.appendChild(heading);
    dates.forEach(function (iso) {
      const edition = document.createElement("div");
      edition.className = "race-cal__edition";
      const subDate = document.createElement("time");
      subDate.className = "race-cal__edition-date";
      if (iso) subDate.dateTime = iso;
      subDate.textContent = iso ? formatDate({ date_iso: iso }) : "Uten dato";
      edition.appendChild(subDate);
      const runners = document.createElement("ul");
      runners.className = "race-cal__runners";
      group.entries
        .filter(function (entry) {
          return (entry.race.date_iso || "") === iso;
        })
        .sort(function (a, b) {
          const aMine = isOwnRace(a.member && a.member.name) ? 0 : 1;
          const bMine = isOwnRace(b.member && b.member.name) ? 0 : 1;
          if (aMine !== bMine) return aMine - bMine;
          return (a.member.name || "").localeCompare(b.member.name || "", "nb");
        })
        .forEach(function (entry) {
          runners.appendChild(timelineRunner(entry.member, entry.race));
        });
      edition.appendChild(runners);
      li.appendChild(edition);
    });
    return li;
  }

  function timelineEvent(group) {
    const race = group.race;
    const li = document.createElement("li");
    li.className = "race-cal__item";
    li.appendChild(raceDateEl(race));
    const body = document.createElement("div");
    body.className = "race-cal__body";
    const heading = document.createElement("div");
    heading.className = "race-cal__heading";
    heading.appendChild(raceNameEl(race));
    body.appendChild(heading);
    const runners = document.createElement("ul");
    runners.className = "race-cal__runners";
    group.entries
      .slice()
      .sort(function (a, b) {
        const aMine = isOwnRace(a.member && a.member.name) ? 0 : 1;
        const bMine = isOwnRace(b.member && b.member.name) ? 0 : 1;
        if (aMine !== bMine) return aMine - bMine;
        return (a.member.name || "").localeCompare(b.member.name || "", "nb");
      })
      .forEach(function (entry) {
        runners.appendChild(timelineRunner(entry.member, entry.race));
      });
    body.appendChild(runners);
    li.appendChild(body);
    return li;
  }

  function timelineRunner(member, race) {
    const item = document.createElement("li");
    item.className = "race-cal__entrant";
    const mine = isOwnRace(member && member.name);
    if (mine) item.classList.add("race-cal__entrant--mine");
    const head = document.createElement("div");
    head.className = "race-cal__entrant-head";
    head.appendChild(memberTrigger(member, "race-cal__runner", "avatar--sm"));
    if (mine) head.appendChild(raceMenu(race));
    item.appendChild(head);
    appendRaceMeta(item, race);
    return item;
  }

  function addLink(parent, href, label) {
    if (!href) return;
    if (parent.childNodes.length) {
      parent.appendChild(document.createTextNode(" · "));
    }
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    a.textContent = label;
    parent.appendChild(a);
  }

  function withDistanceUnit(dist) {
    const s = String(dist || "").trim();
    if (!s) return "";
    if (/^[\d.,]+$/.test(s)) return s + " km";
    return s;
  }

  function distanceLabel(race) {
    const dist = withDistanceUnit(race && race.distance);
    if (!dist) return "";
    if (race.timed && !raceFinished(race.date_iso)) return "mål " + dist;
    return dist;
  }

  function parseDistance(raw) {
    const s = String(raw || "").trim();
    const m = s.match(
      /^([\d.,]+)\s*(km|k|miles|mile|mi|yards|yard|yd|timer|hours|hour|hr|h|t)?\b/i
    );
    if (!m) return { amount: "", unit: "km" };
    const unitRaw = String(m[2] || "km").toLowerCase();
    let unit = "km";
    if (unitRaw === "miles" || unitRaw === "mile" || unitRaw === "mi") unit = "miles";
    else if (unitRaw === "yards" || unitRaw === "yard" || unitRaw === "yd") unit = "yards";
    else if (
      unitRaw === "timer" ||
      unitRaw === "hours" ||
      unitRaw === "hour" ||
      unitRaw === "hr" ||
      unitRaw === "h" ||
      unitRaw === "t"
    ) {
      unit = "timer";
    }
    return { amount: m[1], unit: unit };
  }

  function fillDistance(form, raw) {
    const parsed = parseDistance(raw);
    const amount = formControl(form, "distance");
    const unit = formControl(form, "distance_unit");
    if (amount) amount.value = parsed.amount;
    if (unit) unit.value = parsed.unit;
  }

  function composeDistance(form) {
    const amount = String(controlValue(form, "distance") || "")
      .replace(/[^\d.,]/g, "")
      .trim();
    if (!amount) return "";
    return amount + " " + distanceUnitOf(form);
  }

  function distanceUnitOf(form) {
    const unit = controlValue(form, "distance_unit").toLowerCase();
    if (unit === "miles" || unit === "yards" || unit === "timer") return unit;
    return "km";
  }

  function formControl(form, name) {
    if (!form) return null;
    const named = form.elements.namedItem ? form.elements.namedItem(name) : form.elements[name];
    if (named && named.nodeName) return named;
    return form.querySelector('[name="' + name + '"]');
  }

  function controlValue(form, name) {
    const el = formControl(form, name);
    return el ? String(el.value || "").trim() : "";
  }

  function syncTimedFields() {
    const form = root.querySelector("[data-race-form]");
    const timed = form && form.elements.timed && form.elements.timed.checked;
    const label = root.querySelector("[data-distance-label]");
    const input = form && form.elements.distance;
    if (label) label.textContent = timed ? "Hvor langt vil du løpe" : "Distanse";
    if (input) {
      input.placeholder = timed ? "200" : "50";
      input.setAttribute("aria-label", timed ? "Hvor langt vil du løpe" : "Distanse");
    }
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

  function isOwnRace(ownerName) {
    return Boolean(calendar.self && ownerName && ownerName === calendar.self.name);
  }

  function raceMenu(race) {
    const wrap = document.createElement("div");
    wrap.className = "race-cal__menu";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "race-cal__menu-btn";
    toggle.setAttribute("aria-label", "Handlinger for " + (race.name || "løp"));
    toggle.setAttribute("aria-haspopup", "true");
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';
    const drop = document.createElement("div");
    drop.className = "race-cal__menu-drop";
    drop.hidden = true;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "race-cal__menu-item";
    edit.textContent = "Rediger";
    edit.addEventListener("click", function (event) {
      event.stopPropagation();
      closeRaceMenus();
      openEditRace(race);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "race-cal__menu-item";
    remove.textContent = "Fjern";
    remove.addEventListener("click", function (event) {
      event.stopPropagation();
      closeRaceMenus();
      removeOwnRace(race);
    });
    drop.appendChild(edit);
    drop.appendChild(remove);
    wrap.appendChild(toggle);
    wrap.appendChild(drop);
    toggle.addEventListener("click", function (event) {
      event.stopPropagation();
      const open = drop.hidden;
      closeAccountMenu();
      closeRaceMenus();
      if (open) {
        drop.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
      }
    });
    drop.addEventListener("click", function (event) {
      event.stopPropagation();
    });
    return wrap;
  }

  function closeRaceMenus() {
    root.querySelectorAll(".race-cal__menu-drop").forEach(function (el) {
      el.hidden = true;
    });
    root.querySelectorAll(".race-cal__menu-btn").forEach(function (el) {
      el.setAttribute("aria-expanded", "false");
    });
  }

  async function removeOwnRace(race) {
    const label = race && race.name ? race.name : "løpet";
    if (!window.confirm("Fjerne «" + label + "» fra listen din?")) return;
    const session = readSession();
    if (!session) {
      show("locked");
      return;
    }
    if (editingRace && raceKey(editingRace) === raceKey(race)) hideRaceForm();
    try {
      const data = await apiPost(
        "/races/delete",
        { name: race.name, date: race.date_iso, date_iso: race.date_iso },
        session.token
      );
      applyProfileData(session, data);
    } catch (e) {
      window.alert(MESSAGES[e.message] || MESSAGES.server_error);
    }
  }

  function raceSiteUrl(race) {
    const direct = String((race && race.url) || "").trim();
    if (direct) return direct;
    const name = race && race.name;
    if (!name) return "";
    const match = uniqueRaces().find(function (row) {
      return row.url && normName(row.name) === normName(name);
    });
    return (match && match.url) || "";
  }

  function openRaceModal(race) {
    const panel = document.querySelector("[data-race-modal]");
    if (!panel || !race) return;
    modalRace = race;
    const title = panel.querySelector("[data-race-modal-title]");
    const date = panel.querySelector("[data-race-modal-date]");
    const link = panel.querySelector("[data-race-modal-link]");
    const join = panel.querySelector("[data-race-modal-join]");
    const status = panel.querySelector("[data-race-modal-status]");
    if (title) title.textContent = race.name || "Løp";
    if (date) date.textContent = formatDate(race) || "";
    const url = raceSiteUrl(race);
    if (link) {
      if (url) {
        link.href = url;
        link.hidden = false;
      } else {
        link.removeAttribute("href");
        link.hidden = true;
      }
    }
    const canJoin = canJoinRace(race);
    if (join) join.hidden = !canJoin;
    if (status) status.hidden = canJoin || !alreadyHave(race);
    panel.hidden = false;
  }

  function closeRaceModal() {
    const panel = document.querySelector("[data-race-modal]");
    if (panel) panel.hidden = true;
    modalRace = null;
  }

  function openJoinForm(race) {
    closeRaceModal();
    showRaceForm();
    const form = root.querySelector("[data-race-form]");
    if (!form || !race) return;
    if (form.elements.name) form.elements.name.value = race.name || "";
    if (form.elements.date) form.elements.date.value = race.date_iso || "";
    fillDistance(form, race.distance || "");
    if (form.elements.timed) form.elements.timed.checked = Boolean(race.timed);
    if (form.elements.elevation) form.elements.elevation.value = race.elevation || "";
    if (form.elements.url) form.elements.url.value = raceSiteUrl(race);
    if (form.elements.time) form.elements.time.value = "";
    if (form.elements.place) form.elements.place.value = "";
    if (form.elements.comment) form.elements.comment.value = "";
    syncTimedFields();
    syncResultFields();
    closeRaceCombo();
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

  function uniqueRaces() {
    const map = {};
    RACE_CATALOG.forEach(function (row) {
      if (!row.name) return;
      const key = normName(row.name);
      if (!map[key]) {
        map[key] = { name: row.name, url: row.url || "" };
      } else if (!map[key].url && row.url) {
        map[key].url = row.url;
      }
    });
    members().forEach(function (member) {
      (member.races || []).forEach(function (race) {
        if (!race.name) return;
        const key = normName(race.name);
        if (!map[key]) {
          map[key] = { name: race.name, url: race.url || "" };
        } else if (!map[key].url && race.url) {
          map[key].url = race.url;
        }
      });
    });
    return Object.keys(map)
      .map(function (k) {
        return map[k];
      })
      .sort(function (a, b) {
        return a.name.localeCompare(b.name, "nb");
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
        return normName(race.name).indexOf(qn) !== -1;
      });
    }
    const shown = races.slice(0, 60);
    list.innerHTML = "";
    shown.forEach(function (race, i) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "race-combo__opt";
      btn.setAttribute("data-combo-opt", "1");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", i === 0 ? "true" : "false");
      btn.textContent = race.name;
      btn.addEventListener("click", function () {
        applyExistingRace(race);
        closeRaceCombo();
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
    const exact = shown.some(function (race) {
      return normName(race.name) === qn && qn;
    });
    if (q.length >= 2 && !exact) {
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
    if (race.url && !form.elements.url.value) form.elements.url.value = race.url;
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
    const body = Object.assign(
      { name: race.name, date: race.date_iso || "", date_iso: race.date_iso || "" },
      identityPayload()
    );
    try {
      const data = await apiPost("/races/join", body, session.token);
      applyProfileData(session, data);
      const raceYear = race.date_iso ? parseInt(race.date_iso.slice(0, 4), 10) : year;
      if (raceYear >= 2000 && raceYear <= 2100 && raceYear !== year) setYear(raceYear);
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
    const input = root.querySelector("[data-claim-name]");
    const list = root.querySelector("[data-claim-list]");
    if (!wrap || !input) return;
    wrap.hidden = false;
    const claimed = calendar.self && calendar.self.claimed;
    const alias = currentAlias();
    const shown = alias || currentDisplayName();
    if (document.activeElement !== input) input.value = shown;
    if (!list) return;
    list.innerHTML = "";
    if (claimed) return;
    const patreon = (calendar.self && calendar.self.patreon_name) || currentDisplayName();
    if (patreon) {
      const fresh = document.createElement("option");
      fresh.value = patreon;
      fresh.label = "Ny profil: " + patreon;
      list.appendChild(fresh);
    }
    const names = Array.isArray(calendar.unclaimed) ? calendar.unclaimed.slice() : [];
    names.forEach(function (name) {
      const opt = document.createElement("option");
      opt.value = name;
      list.appendChild(opt);
    });
    if (!alias && calendar.suggested && document.activeElement !== input) {
      input.value = calendar.suggested;
    }
  }

  function setFormMode(mode) {
    const title = root.querySelector("[data-form-title]");
    const submit = root.querySelector("[data-form-submit]");
    const editing = mode === "edit";
    if (title) title.textContent = editing ? "Rediger løp" : "Legg inn løp";
    if (submit) submit.textContent = editing ? "Lagre endringer" : "Lagre løp";
  }

  function showRaceForm() {
    const form = root.querySelector("[data-race-form]");
    const addRow = root.querySelector(".race-cal__add-row");
    if (!form) return;
    editingRace = null;
    setFormMode("add");
    form.hidden = false;
    if (addRow) addRow.hidden = true;
    form.reset();
    const status = root.querySelector("[data-form-status]");
    if (status) status.textContent = "";
    fillClaimSelect();
    setDefaultFormDate();
    fillDistance(form, "");
    syncTimedFields();
    syncResultFields();
    const name = form.querySelector("[data-race-combo]");
    if (name) name.focus();
    renderRaceCombo("");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openEditRace(race) {
    const form = root.querySelector("[data-race-form]");
    const addRow = root.querySelector(".race-cal__add-row");
    if (!form || !race) return;
    editingRace = { name: race.name || "", date_iso: race.date_iso || "" };
    setFormMode("edit");
    form.hidden = false;
    if (addRow) addRow.hidden = true;
    form.reset();
    const status = root.querySelector("[data-form-status]");
    if (status) status.textContent = "";
    fillClaimSelect();
    if (form.elements.name) form.elements.name.value = race.name || "";
    if (form.elements.date) form.elements.date.value = race.date_iso || "";
    fillDistance(form, race.distance);
    if (form.elements.timed) form.elements.timed.checked = Boolean(race.timed);
    if (form.elements.elevation) form.elements.elevation.value = race.elevation || "";
    if (form.elements.time) form.elements.time.value = race.time || "";
    if (form.elements.place) form.elements.place.value = race.place || "";
    if (form.elements.comment) form.elements.comment.value = race.comment || "";
    if (form.elements.url) form.elements.url.value = race.url || "";
    syncTimedFields();
    syncResultFields();
    const name = form.querySelector("[data-race-combo]");
    if (name) name.focus();
    closeRaceCombo();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function hideRaceForm() {
    const form = root.querySelector("[data-race-form]");
    const addRow = root.querySelector(".race-cal__add-row");
    if (form) {
      form.hidden = true;
      form.reset();
    }
    editingRace = null;
    setFormMode("add");
    closeRaceCombo();
    fillClaimSelect();
    if (addRow) addRow.hidden = false;
    const status = root.querySelector("[data-form-status]");
    if (status) status.textContent = "";
  }

  function setDefaultFormDate() {
    const input = root.querySelector('[data-race-form] input[name="date"]');
    if (!input || input.value) return;
    if (year === currentYear) {
      input.value = todayIso();
    } else {
      input.value = year + "-06-01";
    }
    syncResultFields();
  }

  function todayIso() {
    const n = new Date();
    const m = String(n.getMonth() + 1).padStart(2, "0");
    const d = String(n.getDate()).padStart(2, "0");
    return n.getFullYear() + "-" + m + "-" + d;
  }

  function raceFinished(dateIso) {
    return Boolean(dateIso) && dateIso <= todayIso();
  }

  function syncResultFields() {
    const wrap = root.querySelector("[data-result-fields]");
    const date = root.querySelector('[data-race-form] input[name="date"]');
    if (!wrap) return;
    const done = raceFinished(date && date.value);
    wrap.hidden = !done;
    if (!done) {
      const form = root.querySelector("[data-race-form]");
      if (form && form.elements.time) form.elements.time.value = "";
      if (form && form.elements.place) form.elements.place.value = "";
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
      distance: composeDistance(form),
      distance_unit: distanceUnitOf(form),
      timed: Boolean(form.elements.timed && form.elements.timed.checked),
      elevation: valueOf(form, "elevation"),
      time: raceFinished(valueOf(form, "date")) ? valueOf(form, "time") : "",
      place: raceFinished(valueOf(form, "date")) ? valueOf(form, "place") : "",
      comment: valueOf(form, "comment"),
      url: valueOf(form, "url"),
    };
    Object.assign(body, identityPayload());
    const path = editingRace ? "/races/update" : "/races";
    if (editingRace) {
      body.original_name = editingRace.name;
      body.original_date = editingRace.date_iso;
    }
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    if (status) status.textContent = "";
    try {
      const data = await apiPost(path, body, session.token);
      applyProfileData(session, data);
      const raceYear = parseInt((body.date || "").slice(0, 4), 10);
      if (raceYear >= 2000 && raceYear <= 2100 && raceYear !== year) setYear(raceYear);
      form.reset();
      hideRaceForm();
    } catch (e) {
      if (status) status.textContent = MESSAGES[e.message] || MESSAGES.server_error;
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function normClient(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
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

  function oauthRedirectUri() {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return window.location.origin + "/auth/patreon/callback";
    }
    return "https://fokkasfalt.no/auth/patreon/callback";
  }

  function inAppBrowser() {
    const ua = navigator.userAgent || "";
    return /FBAN|FBAV|Instagram|Line\/|Twitter|Slack|LinkedInApp|MicroMessenger|TikTok|Bytedance|Snapchat|WhatsApp/i.test(
      ua
    );
  }

  function writeOauthState(state) {
    writeOauthValue(STATE, state);
  }

  function readOauthState() {
    return readOauthValue(STATE);
  }

  function writeOauthReturn(path) {
    writeOauthValue(RETURN, path);
  }

  function readOauthReturn() {
    return readOauthValue(RETURN);
  }

  function clearOauthState() {
    clearOauthValue(STATE);
    clearOauthValue(RETURN);
  }

  function writeOauthValue(key, value) {
    try {
      sessionStorage.setItem(key, value);
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
    writeCookie(key, value, 600);
  }

  function readOauthValue(key) {
    try {
      const session = sessionStorage.getItem(key);
      if (session) return session;
      const local = localStorage.getItem(key);
      if (local) return local;
    } catch {
      /* ignore */
    }
    return readCookie(key);
  }

  function clearOauthValue(key) {
    try {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    writeCookie(key, "", 0);
  }

  function cookieDomain() {
    const host = window.location.hostname;
    if (host === "fokkasfalt.no" || host === "www.fokkasfalt.no") return ".fokkasfalt.no";
    return "";
  }

  function writeCookie(key, value, maxAge) {
    const parts = [key + "=" + encodeURIComponent(value || ""), "Max-Age=" + maxAge, "Path=/", "SameSite=Lax"];
    if (window.location.protocol === "https:") parts.push("Secure");
    const domain = cookieDomain();
    if (domain) parts.push("Domain=" + domain);
    document.cookie = parts.join("; ");
  }

  function readCookie(key) {
    const prefix = key + "=";
    const parts = String(document.cookie || "").split(";");
    for (let i = 0; i < parts.length; i++) {
      const row = parts[i].trim();
      if (row.indexOf(prefix) === 0) {
        try {
          return decodeURIComponent(row.slice(prefix.length));
        } catch {
          return row.slice(prefix.length);
        }
      }
    }
    return "";
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
