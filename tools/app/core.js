// Shared core for app.html: i18n, projection helpers, the single Leaflet
// map with its swisstopo layers, place search, manifest + device state.
// Mode modules (mode_*.js) register themselves on App.modes and are driven
// by main.js.
(function () {
  "use strict";
  const App = (window.App = {});
  App.modes = {};
  App.state = {
    lang: "en",
    device: null,          // watches.json device object (+ .routable key) or null
    mode: null,            // "region" | "custom" | "routable"
    season: "winter",      // raster season, shared by region + custom
    manifest: null,
    zones: [],
  };
  const $ = (App.$ = (s) => document.querySelector(s));

  // ───────────── i18n ─────────────
  const LANGS = (App.LANGS = ["en", "de", "fr", "it"]);
  App.T = function T(key, vars) {
    const d = window.I18N[App.state.lang] || window.I18N.en;
    let s = d[key] != null ? d[key] : window.I18N.en[key] != null ? window.I18N.en[key] : key;
    if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  };
  App.detectLang = function () {
    let stored = null;
    try { stored = localStorage.getItem("lang"); } catch (e) { /* storage blocked */ }
    if (stored && LANGS.includes(stored)) return stored;
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
    const code = String(nav).toLowerCase().slice(0, 2);
    return LANGS.includes(code) ? code : "en";
  };
  App.applyStaticI18n = function () {
    document.documentElement.lang = App.state.lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = App.T(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", App.T(el.getAttribute("data-i18n-placeholder")));
    });
    document.querySelectorAll(".langs button").forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.lang === App.state.lang ? "true" : "false"));
  };
  App.esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  App.fmtMb = (mb) => (mb < 10 ? mb.toFixed(1) : Math.round(mb).toLocaleString("en").replace(/,/g, " "));
  App.zoneLabel = (z) => `#${String(z.n).padStart(2, "0")} ${z.name}`;

  // ───────────── projection ─────────────
  proj4.defs("EPSG:2056",
    "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 " +
    "+k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel " +
    "+towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs");
  App.lv95ToLatLng = (e, n) => { const [lon, lat] = proj4("EPSG:2056", "EPSG:4326", [e, n]); return [lat, lon]; };
  App.latLngToLv95 = (lat, lon) => proj4("EPSG:4326", "EPSG:2056", [lon, lat]);
  App.lv95BboxToBounds = function (b) {
    const [emin, nmin, emax, nmax] = b;
    let s = 90, n = -90, w = 180, e = -180;
    for (const [x, y] of [[emin, nmin], [emax, nmin], [emax, nmax], [emin, nmax]]) {
      const [lat, lon] = App.lv95ToLatLng(x, y);
      s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
    }
    return [[s, w], [n, e]];
  };
  App.inLv95Bbox = (e, n, b) => e >= b[0] && e <= b[2] && n >= b[1] && n <= b[3];

  // ───────────── map + layers ─────────────
  const map = (App.map = L.map("map", { preferCanvas: true, zoomSnap: 0.5 })
    .fitBounds([[45.82, 5.96], [47.81, 10.49]]));
  const WMTS_URL = "https://wmts{s}.geo.admin.ch/1.0.0/{layer}/default/current/3857/{z}/{x}/{y}.{ext}";
  const ATTR = '© <a href="https://www.swisstopo.admin.ch">swisstopo</a>';
  function wmts(layer, ext, opacity) {
    return L.tileLayer(WMTS_URL, {
      attribution: ATTR, subdomains: ["10", "11", "12", "13", "14"],
      maxZoom: 18, minZoom: 6, layer, ext, opacity: opacity == null ? 1 : opacity,
    });
  }
  // SAC ski-tour routes coloured like the KMZ burn: blue L/WS/WS+, red
  // ZS/ZS+, black S/S+; properties.d == 1 marks foot-only segments (dashed,
  // butt caps so the dashes stay visible).
  const SKI_TIER_STYLE = {
    0: { color: "#1E5AA0", weight: 2.4, opacity: 0.9 },
    1: { color: "#C80000", weight: 2.6, opacity: 0.9 },
    2: { color: "#202020", weight: 2.8, opacity: 0.9 },
  };
  const skiRoutes = L.geoJSON([], {
    style: (f) => {
      const p = f.properties || {};
      const base = SKI_TIER_STYLE[p.t] || SKI_TIER_STYLE[0];
      return p.d ? Object.assign({}, base, { dashArray: "4,10", lineCap: "butt" }) : base;
    },
    onEachFeature: (f, layer) => { const n = f.properties && f.properties.n; if (n) layer.bindTooltip(n, { sticky: true }); },
  });
  fetch("ski_routes_graded.geojson").then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d) skiRoutes.addData(d); })
    .catch((err) => console.warn("ski routes load failed:", err));

  const LAYERS = {
    winter: wmts("ch.swisstopo.pixelkarte-farbe-winter", "jpeg"),
    summer: wmts("ch.swisstopo.pixelkarte-farbe", "jpeg"),
    grey: wmts("ch.swisstopo.pixelkarte-grau", "jpeg"),
    slope: wmts("ch.swisstopo.hangneigung-ueber_30", "png", 0.55),
    ski: skiRoutes,
    wanderwege: wmts("ch.swisstopo.swisstlm3d-wanderwege", "png", 0.9),
  };

  // Which layers show depends on the mode: raster modes preview what gets
  // baked into the KMZ; the routable mode uses a neutral grey background.
  App.layerState = function () {
    const m = App.state.mode, season = App.state.season;
    if (m === "routable") return { base: "grey", slope: false, routes: null };
    if (m === "custom") {
      return {
        base: season,
        slope: $("#optSlope").checked,
        routes: $("#optRoutes").checked ? $("#optRoutesType").value : null,
      };
    }
    return { base: season, slope: true, routes: season === "winter" ? "ski" : "wanderwege" };
  };
  App.applyLayers = function () {
    const want = App.layerState();
    const on = new Set([want.base]);
    if (want.slope) on.add("slope");
    if (want.routes) on.add(want.routes);
    // Remove first, then add in z-order so overlays stay above the base.
    for (const [k, l] of Object.entries(LAYERS)) if (!on.has(k) && map.hasLayer(l)) map.removeLayer(l);
    for (const k of ["winter", "summer", "grey", "slope", "ski", "wanderwege"]) {
      if (on.has(k) && !map.hasLayer(LAYERS[k])) LAYERS[k].addTo(map);
    }
    LAYERS.slope.setOpacity(App.state.season === "summer" ? 0.45 : 0.55);
    renderLegend(want);
  };

  const legendCtl = L.control({ position: "bottomright" });
  let legendDiv = null;
  legendCtl.onAdd = () => (legendDiv = L.DomUtil.create("div", "legend"));
  legendCtl.addTo(map);
  function renderLegend(want) {
    if (!legendDiv) return;
    const T = App.T;
    let h = "";
    if (want.slope) {
      h += `<div><strong>${T("legend.slope")}</strong></div>
        <div class="row"><span class="sw" style="background:#FFFF00"></span>30°</div>
        <div class="row"><span class="sw" style="background:#FFA500"></span>35°</div>
        <div class="row"><span class="sw" style="background:#FF0000"></span>40°</div>
        <div class="row"><span class="sw" style="background:#A020F0"></span>45°+</div>`;
    }
    if (want.routes === "ski") {
      h += `<div style="margin-top:0.3rem"><strong>${T("legend.skitouren")}</strong></div>
        <div class="row"><span class="sw" style="background:#1E5AA0"></span>${T("legend.skitour_blue")}</div>
        <div class="row"><span class="sw" style="background:#C80000"></span>${T("legend.skitour_red")}</div>
        <div class="row"><span class="sw" style="background:#202020"></span>${T("legend.skitour_black")}</div>`;
    } else if (want.routes === "wanderwege") {
      h += `<div style="margin-top:0.3rem"><strong>${T("legend.wanderwege")}</strong></div>
        <div class="row"><span class="sw" style="background:#FFCC00"></span>${T("legend.ww_yellow")}</div>
        <div class="row"><span class="sw" style="background:#C80000"></span>${T("legend.ww_red")}</div>
        <div class="row"><span class="sw" style="background:#1E5AA0"></span>${T("legend.ww_blue")}</div>`;
    }
    legendDiv.innerHTML = h;
  }

  // ───────────── manifest (regional KMZ packs) ─────────────
  App.manifestReady = fetch("manifest.json")
    .then((r) => { if (!r.ok) throw new Error(`manifest ${r.status}`); return r.json(); })
    .then((m) => { App.state.manifest = m; App.state.zones = m.zones; return m; });

  App.fileUrl = (name) => App.state.manifest.asset_url_template.replace("{name}", encodeURIComponent(name));
  App.filesForSeason = (z, season) =>
    season === "summer" ? z.summer_files || [] : z.winter_files || z.files || [];
  App.overviewFor = (z, season) => (season === "summer" ? z.summer_overview : z.winter_overview) || null;
  App.zipFor = (z, season) => (season === "summer" ? z.summer_zip : z.winter_zip) || null;
  App.zonesForSeason = (season) => App.state.zones.filter((z) => App.filesForSeason(z, season).length > 0);
  // All files of one zone for a season, overview first.
  App.zoneDownloads = function (z, season) {
    const out = [];
    const ov = App.overviewFor(z, season);
    if (ov) out.push({ ...ov, url: App.fileUrl(ov.name) });
    for (const f of App.filesForSeason(z, season)) out.push({ ...f, url: App.fileUrl(f.name) });
    return out;
  };
  App.dlRowsHtml = (files) => files.map((f) =>
    `<a class="dl-row" href="${f.url}" download>
       <span class="dl-name">${App.esc(f.name)}</span>
       <span class="dl-meta">${f.size_mb} MB</span><span class="dl-arrow">↓</span></a>`).join("");

  // Chrome prompts once ("Allow site to download multiple files") and drops
  // triggers that come too fast, so stagger generously and use one hidden
  // iframe per file (anchor.click() gets deduped by some browsers).
  App.downloadStaggered = function (files, btn) {
    const T = App.T;
    btn.disabled = true;
    btn.textContent = `${T("dl.progress")} (0/${files.length})`;
    files.forEach((f, i) => {
      setTimeout(() => {
        const ifr = document.createElement("iframe");
        ifr.style.display = "none";
        ifr.src = f.url;
        document.body.appendChild(ifr);
        setTimeout(() => ifr.remove(), 10000);
        btn.textContent = `${T("dl.progress")} (${i + 1}/${files.length})`;
        if (i === files.length - 1) {
          setTimeout(() => { btn.textContent = T("dl.done"); btn.disabled = false; }, 1500);
        }
      }, i * 1400);
    });
  };

  // ───────────── shared place search (swisstopo SearchServer) ─────────────
  const SEARCH = "https://api3.geo.admin.ch/rest/services/api/SearchServer";
  App.placeSearch = function (q) {
    const url = `${SEARCH}?type=locations&sr=2056&searchText=${encodeURIComponent(q)}`;
    return fetch(url).then((r) => r.json()).then((j) => (j.results || []).slice(0, 8).map((r) => ({
      label: (r.attrs.label || "").replace(/<\/?b>/g, ""),
      // SearchServer swaps axes: y = east (~2.6M), x = north (~1.2M).
      e: r.attrs.y, n: r.attrs.x, lat: r.attrs.lat, lon: r.attrs.lon,
    })));
  };
  (function wireSearch() {
    const input = $("#placeInput"), box = $("#placeSuggest");
    let items = [], active = -1, timer = null;
    const hide = () => { box.classList.add("hidden"); active = -1; };
    const pick = (p) => {
      hide();
      input.value = "";
      const m = App.modes[App.state.mode];
      if (m && m.onPlace) m.onPlace(p);
    };
    const show = (list) => {
      items = list; active = -1;
      if (!list.length) return hide();
      box.innerHTML = list.map((r, i) => `<div role="option" data-i="${i}">${App.esc(r.label)}</div>`).join("");
      box.classList.remove("hidden");
    };
    box.addEventListener("mousedown", (e) => {
      const row = e.target.closest("[data-i]");
      if (row) { e.preventDefault(); pick(items[+row.dataset.i]); }
    });
    input.addEventListener("input", () => {
      const q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) return hide();
      timer = setTimeout(() => App.placeSearch(q).then(show).catch((err) => { console.warn("search failed:", err); hide(); }), 220);
    });
    input.addEventListener("keydown", (e) => {
      const rows = box.querySelectorAll("[data-i]");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!rows.length) return;
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
        rows.forEach((r, i) => r.classList.toggle("active", i === active));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (active >= 0 && items[active]) return pick(items[active]);
        const q = input.value.trim();
        if (q.length >= 2) App.placeSearch(q).then((list) => { if (list.length) pick(list[0]); });
      } else if (e.key === "Escape") hide();
    });
    input.addEventListener("blur", () => setTimeout(hide, 150));
  })();

  // KMZ install steps, shared by region + custom mode.
  App.kmzInstallHtml = function () {
    const T = App.T;
    return `<ol class="steps">
        <li>${T("install.step1")}</li>
        <li>${T("install.step2")}</li>
        <li>${T("install.step3")}</li>
        <li>${T("install.step4")}</li>
        <li>${T("install.step5")}</li>
      </ol>
      <p class="note">${T("install.full_link")} <a href="install.html">${T("install.full_link_text")}</a>.</p>`;
  };
})();
