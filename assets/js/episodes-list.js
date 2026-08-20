/**
 * Virtualized episode list for /episoder/
 * Keeps only a small window of rows in the DOM; filters/sort operate on data.
 */
(function () {
  var dataEl = document.getElementById("ep-list-data");
  var availEl = document.getElementById("ep-avail-data");
  var list = document.getElementById("ep-episode-list");
  var windowEl = document.getElementById("ep-virt-window");
  var stickyEl = document.getElementById("ep-sticky-period");
  var stickyInner = stickyEl && stickyEl.querySelector(".ep-list__period-inner");
  var input = document.getElementById("ep-search-input");
  var sortToggle = document.getElementById("ep-sort-toggle");
  var sortBtnDesc = document.getElementById("ep-sort-desc");
  var sortBtnAsc = document.getElementById("ep-sort-asc");
  var statusEl = document.getElementById("ep-search-status");
  var emptyEl = document.getElementById("ep-search-empty");
  var clearBtn = document.getElementById("ep-search-clear");
  var filtersPanel = document.getElementById("ep-filters-panel");
  var filtersToggle = document.getElementById("ep-filters-toggle");
  var filtersLabel = document.getElementById("ep-filters-toggle-label");
  var filtersDot = document.getElementById("ep-filters-dot");
  var yearSelect = document.getElementById("ep-filter-year");
  var ytToggle = document.getElementById("ep-youtube-toggle");
  var ytBtnAll = document.getElementById("ep-yt-all");
  var ytBtnYes = document.getElementById("ep-yt-yes");
  var ytBtnNo = document.getElementById("ep-yt-no");
  var accToggle = document.getElementById("ep-access-toggle");
  var accBtnAll = document.getElementById("ep-access-all");
  var accBtnFree = document.getElementById("ep-access-free");
  var accBtnPat = document.getElementById("ep-access-patreon");
  var cfgEl = document.getElementById("ep-list-config");

  if (
    !dataEl ||
    !list ||
    !windowEl ||
    !input ||
    !sortToggle ||
    !sortBtnDesc ||
    !sortBtnAsc ||
    !filtersPanel ||
    !filtersToggle ||
    !filtersLabel ||
    !yearSelect ||
    !ytToggle ||
    !ytBtnAll ||
    !ytBtnYes ||
    !ytBtnNo ||
    !accToggle ||
    !accBtnAll ||
    !accBtnFree ||
    !accBtnPat
  ) {
    return;
  }

  var cfg = { spotifyShow: "", appleShow: "", defaultCover: "/assets/fokkasfalt.png" };
  try {
    if (cfgEl) Object.assign(cfg, JSON.parse(cfgEl.textContent));
  } catch (e) {}

  var raw = [];
  var availBySlug = {};
  try {
    raw = JSON.parse(dataEl.textContent);
  } catch (e) {
    return;
  }
  try {
    if (availEl) availBySlug = JSON.parse(availEl.textContent) || {};
  } catch (e2) {}

  var MONTH_NAMES_NB = [
    "januar",
    "februar",
    "mars",
    "april",
    "mai",
    "juni",
    "juli",
    "august",
    "september",
    "oktober",
    "november",
    "desember",
  ];

  function dateLabelNb(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.getDate() + ". " + MONTH_NAMES_NB[d.getMonth()] + " " + d.getFullYear();
  }

  function episodeYearKey(ep) {
    if (!ep.ts) return "nodate";
    var d = new Date(ep.ts);
    return Number.isNaN(d.getTime()) ? "nodate" : String(d.getFullYear());
  }

  function episodeYMKey(ep) {
    if (!ep.ts) return "nodate";
    var d = new Date(ep.ts);
    if (Number.isNaN(d.getTime())) return "nodate";
    var m = d.getMonth() + 1;
    return d.getFullYear() + "-" + (m < 10 ? "0" + m : String(m));
  }

  function periodStickyLabel(ymKey) {
    if (ymKey === "nodate") return "Uten dato";
    var p = ymKey.split("-");
    if (p.length < 2) return ymKey;
    var mi = parseInt(p[1], 10) - 1;
    if (mi < 0 || mi > 11) return ymKey;
    var mLow = MONTH_NAMES_NB[mi];
    return mLow.charAt(0).toUpperCase() + mLow.slice(1) + " - " + p[0];
  }

  function periodStickyAria(ymKey) {
    if (ymKey === "nodate") return "Episoder uten registrert utgivelsesdato";
    var p = ymKey.split("-");
    var mi = parseInt(p[1], 10) - 1;
    if (mi < 0 || mi > 11) return "Episoder";
    return "Episoder fra " + MONTH_NAMES_NB[mi] + " " + p[0];
  }

  var items = raw.map(function (ep) {
    var slug = ep.s || "";
    var av = availBySlug[slug] || null;
    var access = "patreon";
    if (!av) access = "?";
    else if (av.a === "also_free") access = "free";
    else if (av.a === "uncertain") access = "uncertain";
    else access = "patreon";

    var yt = (ep.yt || "").trim();
    var sp = "";
    var ap = "";
    if (av && av.a === "also_free") {
      sp = (av.sp || cfg.spotifyShow || "").trim();
      ap = (av.ap || cfg.appleShow || "").trim();
    }

    var img = (ep.img || "").trim() || cfg.defaultCover;
    var dl = ep.dl || dateLabelNb(ep.d);
    var ts = 0;
    if (ep.d) {
      var t = new Date(ep.d).getTime();
      ts = Number.isNaN(t) ? 0 : t;
    }

    var hay = [ep.t, dl, ep.dur || ""].join(" ").toLowerCase();

    return {
      u: ep.u,
      t: ep.t,
      d: ep.d || "",
      dl: dl,
      dur: ep.dur || "",
      img: img,
      yt: yt,
      sp: sp,
      ap: ap,
      access: access,
      ts: ts,
      hay: hay,
      hasYt: yt ? 1 : 0,
    };
  });

  var total = items.length;
  var OVERSCAN = 8;
  var flat = [];
  var offsets = [];
  var totalH = 0;
  var rafPending = false;
  var lastRange = { start: -1, end: -1 };

  function cssPx(name, fallback) {
    var v = getComputedStyle(list).getPropertyValue(name).trim();
    if (v.endsWith("rem")) {
      var rem = parseFloat(v);
      var root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      return rem > 0 ? rem * root : fallback;
    }
    var n = parseFloat(v);
    return n > 0 ? n : fallback;
  }

  function rowH() {
    return cssPx("--ep-virt-row-h", 108);
  }

  function gapH() {
    return cssPx("--ep-virt-gap", 8);
  }

  function filtersPanelExpanded() {
    return filtersPanel.classList.contains("is-open");
  }

  var elasticThumbToggles = [sortToggle, ytToggle, accToggle];
  var resizeThumbTimer = null;

  function scheduleElasticThumbs() {
    if (!filtersPanelExpanded()) return;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        elasticThumbToggles.forEach(syncElasticThumb);
      });
    });
  }

  function syncElasticThumb(toggleEl) {
    if (!toggleEl || !toggleEl.classList.contains("ep-sort__toggle--thumb-dynamic")) return;
    if (!filtersPanelExpanded()) return;
    var thumb = toggleEl.querySelector(".ep-sort__thumb");
    if (!thumb) return;
    var active = toggleEl.querySelector(".ep-sort__btn.is-active");
    if (!active) return;
    var tr = toggleEl.getBoundingClientRect();
    var br = active.getBoundingClientRect();
    if (tr.width < 2 || br.width < 2) return;
    thumb.style.left = br.left - tr.left + "px";
    thumb.style.width = br.width + "px";
    thumb.style.transform = "none";
  }

  function currentYearFilter() {
    return yearSelect.value ? yearSelect.value : "";
  }

  function setYoutubeFilter(val) {
    var all = val !== "yes" && val !== "no";
    ytBtnAll.classList.toggle("is-active", all);
    ytBtnYes.classList.toggle("is-active", val === "yes");
    ytBtnNo.classList.toggle("is-active", val === "no");
    ytBtnAll.setAttribute("aria-pressed", all ? "true" : "false");
    ytBtnYes.setAttribute("aria-pressed", val === "yes" ? "true" : "false");
    ytBtnNo.setAttribute("aria-pressed", val === "no" ? "true" : "false");
    ytToggle.setAttribute("data-slot", all ? "0" : val === "yes" ? "1" : "2");
    scheduleElasticThumbs();
  }

  function setAccessFilter(val) {
    var all = val !== "free" && val !== "patreon";
    accBtnAll.classList.toggle("is-active", all);
    accBtnFree.classList.toggle("is-active", val === "free");
    accBtnPat.classList.toggle("is-active", val === "patreon");
    accBtnAll.setAttribute("aria-pressed", all ? "true" : "false");
    accBtnFree.setAttribute("aria-pressed", val === "free" ? "true" : "false");
    accBtnPat.setAttribute("aria-pressed", val === "patreon" ? "true" : "false");
    accToggle.setAttribute("data-slot", all ? "0" : val === "free" ? "1" : "2");
    scheduleElasticThumbs();
  }

  function currentYoutubeFilter() {
    if (ytBtnYes.classList.contains("is-active")) return "yes";
    if (ytBtnNo.classList.contains("is-active")) return "no";
    return "";
  }

  function currentAccessFilter() {
    if (accBtnFree.classList.contains("is-active")) return "free";
    if (accBtnPat.classList.contains("is-active")) return "patreon";
    return "";
  }

  function filtersAreNonDefault() {
    return (
      sortBtnAsc.classList.contains("is-active") ||
      !!currentYearFilter() ||
      !!currentYoutubeFilter() ||
      !!currentAccessFilter()
    );
  }

  function updateFiltersChrome() {
    var open = filtersPanelExpanded();
    filtersToggle.setAttribute("aria-expanded", open ? "true" : "false");
    filtersLabel.textContent = open ? "Skjul filtre" : "Filtre";
    filtersToggle.classList.toggle("ep-filters-toggle--open", open);
    if (filtersDot) {
      filtersDot.hidden = !filtersAreNonDefault() || open;
    }
    filtersToggle.classList.toggle("ep-filters-toggle--dirty", filtersAreNonDefault());
  }

  function setFiltersPanelOpen(open) {
    var on = !!open;
    filtersPanel.classList.toggle("is-open", on);
    filtersPanel.setAttribute("aria-hidden", on ? "false" : "true");
    updateFiltersChrome();
    if (on) scheduleElasticThumbs();
  }

  var urlTimer = null;
  function syncQueryToUrl() {
    var v = input.value.trim();
    var params = new URLSearchParams(window.location.search);
    if (v) params.set("q", v);
    else params.delete("q");
    if (currentSortOrder() === "asc") params.set("order", "asc");
    else params.delete("order");
    var y = currentYearFilter();
    if (y) params.set("year", y);
    else params.delete("year");
    var yt = currentYoutubeFilter();
    if (yt) params.set("yt", yt);
    else params.delete("yt");
    var ac = currentAccessFilter();
    if (ac) params.set("access", ac);
    else params.delete("access");
    var qs = params.toString();
    var next = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    var cur = window.location.pathname + window.location.search + window.location.hash;
    if (next !== cur) history.replaceState(null, "", next);
  }

  function scheduleUrlSync() {
    if (urlTimer) clearTimeout(urlTimer);
    urlTimer = setTimeout(function () {
      urlTimer = null;
      syncQueryToUrl();
    }, 200);
  }

  function currentSortOrder() {
    return sortBtnAsc.classList.contains("is-active") ? "asc" : "desc";
  }

  function setSortOrder(order) {
    var asc = order === "asc";
    sortBtnAsc.classList.toggle("is-active", asc);
    sortBtnDesc.classList.toggle("is-active", !asc);
    sortBtnAsc.setAttribute("aria-pressed", asc ? "true" : "false");
    sortBtnDesc.setAttribute("aria-pressed", !asc ? "true" : "false");
    sortToggle.setAttribute("data-order", asc ? "asc" : "desc");
    scheduleElasticThumbs();
  }

  function setYearFilterFromParams(yrRaw) {
    if (yrRaw === null || yrRaw === undefined) return;
    var yr = String(yrRaw).trim();
    if (yr !== "nodate" && yr.length > 0 && !/^\d{4}$/.test(yr)) return;
    for (var oi = 0; oi < yearSelect.options.length; oi++) {
      if (yearSelect.options[oi].value === yr) {
        yearSelect.value = yr;
        return;
      }
    }
  }

  function populateYearDropdown() {
    var seen = {};
    items.forEach(function (ep) {
      seen[episodeYearKey(ep)] = true;
    });
    while (yearSelect.firstChild) yearSelect.removeChild(yearSelect.firstChild);
    var o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = "Alle år";
    yearSelect.appendChild(o0);
    Object.keys(seen)
      .filter(function (k) {
        return k !== "nodate";
      })
      .sort(function (a, b) {
        return parseInt(b, 10) - parseInt(a, 10);
      })
      .forEach(function (y) {
        var o = document.createElement("option");
        o.value = y;
        o.textContent = y;
        yearSelect.appendChild(o);
      });
    if (seen.nodate) {
      var on = document.createElement("option");
      on.value = "nodate";
      on.textContent = "Uten dato";
      yearSelect.appendChild(on);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function badgeHtml(access) {
    if (access === "?") {
      return '<span class="avail-pill avail-pill--pat" title="Ingen tilgjengelighetsdata">?</span>';
    }
    if (access === "free") {
      return '<span class="avail-pill avail-pill--free" title="Sannsynlig åpen eller gratis å lytte på (f.eks. via Buzzsprouts feed)">Åpen / gratis</span>';
    }
    if (access === "uncertain") {
      return '<span class="avail-pill avail-pill--warn" title="Usikker match">Usikker</span>';
    }
    return '<span class="avail-pill avail-pill--pat" title="Kun Patreon i praksis">Patreon</span>';
  }

  function iconLink(cls, href, label, symbol) {
    return (
      '<a class="listen-icon ' +
      cls +
      '" href="' +
      escapeHtml(href) +
      '" target="_blank" rel="noopener noreferrer" aria-label="' +
      escapeHtml(label) +
      '">' +
      '<svg width="22" height="22" aria-hidden="true" focusable="false"><use href="#' +
      symbol +
      '" xlink:href="#' +
      symbol +
      '"></use></svg>' +
      "</a>"
    );
  }

  function listenHtml(ep) {
    var parts = [];
    if (ep.sp) {
      parts.push(
        iconLink(
          "listen-icon--spotify",
          ep.sp,
          ep.sp.indexOf("/episode") !== -1 ? "Åpne episoden på Spotify" : "Åpne podcasten på Spotify",
          "ep-icon-spotify"
        )
      );
    }
    if (ep.ap) {
      parts.push(
        iconLink(
          "listen-icon--apple",
          ep.ap,
          ep.ap.indexOf("?i=") !== -1 ? "Åpne episoden i Apple Podcasts" : "Åpne podcasten i Apple Podcasts",
          "ep-icon-apple"
        )
      );
    }
    if (ep.yt) {
      var ytHref = ep.yt.indexOf("://") !== -1 ? ep.yt : "https://www.youtube.com/watch?v=" + ep.yt;
      parts.push(iconLink("listen-icon--youtube", ytHref, "Se episoden på YouTube", "ep-icon-youtube"));
    }
    if (!parts.length) return "";
    return '<div class="ep-list__tail-listen">' + parts.join("") + "</div>";
  }

  function renderEpisodeRow(ep) {
    var sub = "";
    if (ep.dl || ep.dur) {
      sub =
        '<span class="ep-list__sub">' +
        (ep.dl
          ? '<time class="ep-list__date" datetime="' + escapeHtml(ep.d) + '">' + escapeHtml(ep.dl) + "</time>"
          : "") +
        (ep.dl && ep.dur ? '<span class="ep-list__sep" aria-hidden="true">·</span>' : "") +
        (ep.dur
          ? '<span class="ep-list__duration" aria-label="Varighet ' +
            escapeHtml(ep.dur) +
            '">' +
            escapeHtml(ep.dur) +
            "</span>"
          : "") +
        "</span>";
    }

    return (
      '<div class="ep-list__item ep-list__item--row" role="listitem">' +
      '<div class="ep-list__row">' +
      '<a class="ep-list__main" href="' +
      escapeHtml(ep.u) +
      '">' +
      '<img class="ep-list__thumb" src="' +
      escapeHtml(ep.img) +
      '" alt="" width="80" height="80" loading="lazy" decoding="async" fetchpriority="low" />' +
      '<span class="ep-list__body"><span class="ep-list__title">' +
      escapeHtml(ep.t) +
      "</span>" +
      sub +
      "</span></a>" +
      '<div class="ep-list__tail"><div class="ep-list__tail-badges">' +
      badgeHtml(ep.access) +
      "</div>" +
      listenHtml(ep) +
      "</div></div></div>"
    );
  }

  function rebuildFlat(visibleEps) {
    var rh = rowH();
    var gap = gapH();
    flat = [];
    offsets = [];
    var y = 0;
    for (var i = 0; i < visibleEps.length; i++) {
      flat.push({ kind: "ep", ep: visibleEps[i], h: rh, ym: episodeYMKey(visibleEps[i]) });
      offsets.push(y);
      y += rh + gap;
    }
    totalH = Math.max(0, y - (flat.length ? gap : 0));
    list.style.height = totalH + "px";
    lastRange = { start: -1, end: -1 };
  }

  function findStartIndex(scrollOffset) {
    var lo = 0;
    var hi = offsets.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (offsets[mid] + flat[mid].h < scrollOffset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function updateSticky(scrollOffset) {
    if (!stickyEl || !stickyInner || !flat.length) {
      if (stickyEl) stickyEl.hidden = true;
      return;
    }
    var idx = findStartIndex(scrollOffset + 1);
    if (idx >= flat.length) idx = flat.length - 1;
    var ym = flat[idx].ym || episodeYMKey(flat[idx].ep);
    if (!ym) {
      stickyEl.hidden = true;
      return;
    }
    stickyInner.textContent = periodStickyLabel(ym);
    stickyEl.setAttribute("aria-label", periodStickyAria(ym));
    stickyEl.hidden = false;
  }

  function paint() {
    rafPending = false;
    if (!flat.length) {
      windowEl.innerHTML = "";
      windowEl.style.transform = "translateY(0px)";
      list.style.height = "0px";
      if (stickyEl) stickyEl.hidden = true;
      return;
    }

    var scrollY = window.scrollY || window.pageYOffset;
    var listTop = list.getBoundingClientRect().top + scrollY;
    var viewTop = Math.max(0, scrollY - listTop);
    var viewH = window.innerHeight || document.documentElement.clientHeight;
    var start = Math.max(0, findStartIndex(viewTop) - OVERSCAN);
    var end = start;
    var bottom = viewTop + viewH;
    while (end < flat.length && offsets[end] < bottom) end++;
    end = Math.min(flat.length, end + OVERSCAN);

    if (start === lastRange.start && end === lastRange.end) {
      updateSticky(viewTop);
      return;
    }
    lastRange = { start: start, end: end };

    var topH = offsets[start] || 0;
    windowEl.style.transform = "translate3d(0," + topH + "px,0)";

    var html = "";
    for (var i = start; i < end; i++) {
      html += renderEpisodeRow(flat[i].ep);
    }
    windowEl.innerHTML = html;
    updateSticky(viewTop);
  }

  function schedulePaint() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(paint);
  }

  function applyFilterAndSort() {
    var rawQ = input.value.trim();
    var terms = rawQ ? rawQ.toLowerCase().split(/\s+/) : [];
    var yf = currentYearFilter();
    var yt = currentYoutubeFilter();
    var ac = currentAccessFilter();
    var hasNarrow = terms.length > 0 || !!yf || !!yt || !!ac;
    var desc = currentSortOrder() !== "asc";

    var visible = items.filter(function (ep) {
      var matchTerms =
        terms.length === 0 ||
        terms.every(function (t) {
          return ep.hay.indexOf(t) !== -1;
        });
      var matchYear = !yf || episodeYearKey(ep) === yf;
      var matchYt = !yt || (yt === "yes" ? ep.hasYt === 1 : yt === "no" ? ep.hasYt === 0 : true);
      var matchAccess = !ac || ep.access === ac;
      return matchTerms && matchYear && matchYt && matchAccess;
    });

    visible.sort(function (a, b) {
      return desc ? b.ts - a.ts : a.ts - b.ts;
    });

    rebuildFlat(visible);

    if (statusEl) {
      if (!hasNarrow) statusEl.textContent = "";
      else if (visible.length === 0) statusEl.textContent = "Ingen treff.";
      else statusEl.textContent = "Viser " + visible.length + " av " + total + " episoder.";
    }
    if (emptyEl) emptyEl.hidden = visible.length > 0;
    if (clearBtn) clearBtn.hidden = !input.value;
    scheduleUrlSync();
    updateFiltersChrome();
    schedulePaint();
  }

  var filterTimer = null;
  function filter() {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(function () {
      filterTimer = null;
      applyFilterAndSort();
    }, 40);
  }

  input.addEventListener("input", filter);
  yearSelect.addEventListener("change", filter);
  ytToggle.addEventListener("click", function (e) {
    var btn = e.target.closest(".ep-sort__btn");
    if (!btn || !ytToggle.contains(btn)) return;
    var v = btn.getAttribute("data-yt");
    if (v === "all") setYoutubeFilter("");
    else if (v === "yes" || v === "no") setYoutubeFilter(v);
    filter();
  });
  accToggle.addEventListener("click", function (e) {
    var btn = e.target.closest(".ep-sort__btn");
    if (!btn || !accToggle.contains(btn)) return;
    var v = btn.getAttribute("data-access");
    if (v === "all") setAccessFilter("");
    else if (v === "free" || v === "patreon") setAccessFilter(v);
    filter();
  });
  filtersToggle.addEventListener("click", function () {
    setFiltersPanelOpen(!filtersPanelExpanded());
    if (filtersPanelExpanded()) sortBtnDesc.focus();
  });
  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key !== "Escape" || !filtersPanelExpanded()) return;
      e.preventDefault();
      setFiltersPanelOpen(false);
      filtersToggle.focus();
    },
    false
  );
  sortToggle.addEventListener("click", function (e) {
    var btn = e.target.closest(".ep-sort__btn");
    if (!btn || !sortToggle.contains(btn)) return;
    var next = btn.getAttribute("data-order");
    if (!next || next === currentSortOrder()) return;
    setSortOrder(next);
    filter();
  });
  function onSortArrowKey(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setSortOrder(e.key === "ArrowLeft" ? "desc" : "asc");
    filter();
  }
  sortBtnDesc.addEventListener("keydown", onSortArrowKey);
  sortBtnAsc.addEventListener("keydown", onSortArrowKey);
  function ytSlotIndex() {
    if (ytBtnAll.classList.contains("is-active")) return 0;
    if (ytBtnYes.classList.contains("is-active")) return 1;
    return 2;
  }
  function onYtArrowKey(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    var i = ytSlotIndex();
    var ni = e.key === "ArrowLeft" ? Math.max(0, i - 1) : Math.min(2, i + 1);
    setYoutubeFilter(ni === 0 ? "" : ni === 1 ? "yes" : "no");
    filter();
  }
  function accSlotIndex() {
    if (accBtnAll.classList.contains("is-active")) return 0;
    if (accBtnFree.classList.contains("is-active")) return 1;
    return 2;
  }
  function onAccArrowKey(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    var i = accSlotIndex();
    var ni = e.key === "ArrowLeft" ? Math.max(0, i - 1) : Math.min(2, i + 1);
    setAccessFilter(ni === 0 ? "" : ni === 1 ? "free" : "patreon");
    filter();
  }
  ytBtnAll.addEventListener("keydown", onYtArrowKey);
  ytBtnYes.addEventListener("keydown", onYtArrowKey);
  ytBtnNo.addEventListener("keydown", onYtArrowKey);
  accBtnAll.addEventListener("keydown", onAccArrowKey);
  accBtnFree.addEventListener("keydown", onAccArrowKey);
  accBtnPat.addEventListener("keydown", onAccArrowKey);
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      input.value = "";
      input.focus();
      filter();
    });
  }

  window.addEventListener("scroll", schedulePaint, { passive: true });
  window.addEventListener("resize", function () {
    if (resizeThumbTimer) clearTimeout(resizeThumbTimer);
    resizeThumbTimer = setTimeout(function () {
      scheduleElasticThumbs();
      applyFilterAndSort();
    }, 100);
  });

  try {
    var paramsInit = new URLSearchParams(window.location.search);
    var orderRaw = paramsInit.get("order");
    var yrQ = paramsInit.get("year");
    var ytQ = paramsInit.get("yt");
    var accessQ = paramsInit.get("access");
    populateYearDropdown();
    if (orderRaw === "asc") setSortOrder("asc");
    setYearFilterFromParams(yrQ);
    var ytTrimInit = ytQ ? String(ytQ).trim() : "";
    if (ytTrimInit === "yes" || ytTrimInit === "no") setYoutubeFilter(ytTrimInit);
    else setYoutubeFilter("");
    var acTrimInit = accessQ ? String(accessQ).trim() : "";
    if (acTrimInit === "free" || acTrimInit === "patreon") setAccessFilter(acTrimInit);
    else setAccessFilter("");
    var q = paramsInit.get("q");
    if (q) input.value = q;

    var yrTrim = yrQ ? String(yrQ).trim() : "";
    var yrParamOpens =
      (yrTrim === "nodate" && yearSelect.value === "nodate") ||
      (/^\d{4}$/.test(yrTrim) && yearSelect.value === yrTrim);
    var ytTrim = ytQ ? String(ytQ).trim() : "";
    var ytParamOpens =
      (ytTrim === "yes" && ytBtnYes.classList.contains("is-active")) ||
      (ytTrim === "no" && ytBtnNo.classList.contains("is-active"));
    var acTrim = accessQ ? String(accessQ).trim() : "";
    var acParamOpens =
      (acTrim === "free" && accBtnFree.classList.contains("is-active")) ||
      (acTrim === "patreon" && accBtnPat.classList.contains("is-active"));
    setFiltersPanelOpen(orderRaw === "asc" || yrParamOpens || ytParamOpens || acParamOpens);
  } catch (e) {
    updateFiltersChrome();
  }

  applyFilterAndSort();
})();
