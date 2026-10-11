// Orchestration: device → map type → area. Picks the recommended mode for
// the chosen device, switches mode panels/layers, keeps the URL hash
// (#region / #custom / #routable) and language in sync.
(function () {
  "use strict";
  const { $, T, map } = App;
  const MODES = ["region", "custom", "routable"];

  // watches.json devices that can load the routable vector .img, mapped to
  // their install profile in mode_routable.js. Kept here (not in
  // watches.json) because that file is mirrored from the build repo.
  const ROUTABLE = { fenix9pro_43: "fenix9pro", fenix9pro_47: "fenix9pro", fenix9pro_51: "fenix9pro", edge1050: "edge1050" };
  // Largest prebuilt zone in tiles; manifest value once loaded.
  let maxZoneTiles = 310;

  let devices = new Map();
  let modeChosen = false;   // user picked a mode (card or URL hash) → don't auto-switch

  // ── device list ──
  function loadDevices(json) {
    const sel = $("#deviceSel");
    devices = new Map();
    let html = `<option value="">${T("dev.choose")}</option>`;
    for (const g of json.groups) {
      html += `<optgroup label="${App.esc(g.label)}">`;
      for (const d of g.devices) {
        const dev = { ...d, routable: ROUTABLE[d.key] || null };
        devices.set(d.key, dev);
        html += `<option value="${d.key}">${App.esc(d.name)}</option>`;
      }
      html += "</optgroup>";
    }
    sel.innerHTML = html;
    let saved = null;
    try { saved = localStorage.getItem("device"); } catch (e) { /* storage blocked */ }
    if (saved && devices.has(saved)) sel.value = saved;
    setDevice(sel.value || null, true);
  }
  fetch("watches.json").then((r) => r.json()).then(loadDevices).catch((err) => {
    console.warn("watches.json failed:", err);
    loadDevices({ groups: [{ label: "Fallback", devices: [
      { key: "epix2", name: "Epix 2 / Fenix 7 Pro family", tile_cap: 500, max_files: 100, max_kmz_mb: 3, disputed: true },
    ] }] });
  });
  $("#deviceSel").addEventListener("change", (e) => setDevice(e.target.value || null, false));

  function setDevice(key, initial) {
    const d = key ? devices.get(key) : null;
    App.state.device = d || null;
    try { if (!initial) localStorage.setItem("device", key || ""); } catch (e) { /* storage blocked */ }
    renderDeviceInfo();
    // Nothing below applies to a device without any third-party map support.
    const none = !!(d && d.tile_cap === 0 && !d.routable);
    $("#stepArea").classList.toggle("hidden", none);
    $("#stepInstall").classList.toggle("hidden", none);
    const av = availability();
    // A device change re-applies the recommendation (step 1 drives step 2).
    // On page load a mode from the URL hash wins, unless it can't work on
    // the remembered device.
    const cur = App.state.mode;
    if (av.recommended && (!cur || !av[cur].ok || !initial || !modeChosen)) setMode(av.recommended, false);
    else if (!cur) setMode("region", false);
    renderModeCards();
    for (const m of MODES) if (App.modes[m].onDevice) App.modes[m].onDevice();
    if (App.state.mode === "region") App.modes.region.render();
  }

  function availability() {
    const d = App.state.device;
    const out = { region: { ok: true }, custom: { ok: true }, routable: { ok: true }, recommended: null };
    if (!d) return out;
    const cap = d.tile_cap;
    if (cap === 0) {
      out.region = { ok: false, why: T("why.no_kmz") };
      out.custom = { ok: false, why: T("why.no_kmz") };
    } else if (cap < maxZoneTiles) {
      out.region = { ok: true, why: T("why.region_small", { cap }) };
      out.custom.why = T("why.custom_fit", { cap });
    }
    if (!d.routable) out.routable = { ok: false, why: T("why.no_routable") };
    out.recommended = d.routable ? "routable" : cap >= maxZoneTiles ? "region" : cap > 0 ? "custom" : null;
    return out;
  }

  function renderDeviceInfo() {
    const d = App.state.device, el = $("#deviceInfo");
    if (!d) { el.innerHTML = `<p class="note">${T("dev.prompt")}</p>`; return; }
    const chips = [
      d.tile_cap > 0
        ? `<span class="chip yes">✓ ${T("dev.kmz_yes", { cap: d.tile_cap })}${d.disputed ? " ⚠" : ""}</span>`
        : `<span class="chip no">✕ ${T("dev.kmz_no")}</span>`,
      d.routable ? `<span class="chip yes">✓ ${T("dev.rt_yes")}</span>` : `<span class="chip no">✕ ${T("dev.rt_no")}</span>`,
    ];
    // watches.json notes may point at the old routable.html page; the
    // routable option now lives in step 2, so drop that sentence.
    const note = (d.note || "").replace(/[^.]*routable\.html[^.]*\.?/g, "").trim();
    let extra = "";
    if (d.tile_cap === 0 && !d.routable) extra = `<div class="callout bad">${T("dev.unsupported")}</div>`;
    else if (d.disputed || note) {
      extra = `<details class="box" style="margin-top:0.45rem"><summary class="note">${T("dev.details")}</summary>
        ${d.tile_cap > 0 ? `<p class="note">${T("dev.caps", { cap: d.tile_cap, files: d.max_files, mb: d.max_kmz_mb })}</p>` : ""}
        ${d.disputed ? `<p class="note">⚠ ${T("dev.disputed")}</p>` : ""}
        ${note ? `<p class="note">${note}</p>` : ""}</details>`;
    }
    el.innerHTML = `<div class="caps">${chips.join("")}</div>${extra}`;
  }

  // ── mode cards ──
  function renderModeCards() {
    const av = availability();
    document.querySelectorAll("#modeCards .card").forEach((card) => {
      const m = card.dataset.mode, a = av[m];
      const input = card.querySelector("input");
      input.checked = App.state.mode === m;
      input.disabled = !a.ok;
      card.classList.toggle("disabled", !a.ok);
      card.querySelector(".why").textContent = a.why || "";
      card.querySelector(".why").style.color = a.ok ? "" : "var(--accent-dark)";
      let badge = card.querySelector(".badge");
      if (av.recommended === m) {
        if (!badge) { badge = document.createElement("span"); badge.className = "badge"; card.appendChild(badge); }
        badge.textContent = T("mode.recommended");
      } else if (badge) badge.remove();
    });
  }
  document.querySelectorAll("input[name=mode]").forEach((r) =>
    r.addEventListener("change", (e) => { modeChosen = true; setMode(e.target.value, true); }));

  function setMode(m, fromUser) {
    if (!MODES.includes(m)) return;
    const prev = App.state.mode;
    if (prev === m) { renderModeCards(); return; }
    if (prev) App.modes[prev].deactivate();
    App.state.mode = m;
    document.querySelectorAll("[data-modes]").forEach((el) =>
      el.classList.toggle("hidden", !el.dataset.modes.split(" ").includes(m)));
    $("#areaHeading").textContent = T(m === "routable" ? "area.heading_rt" : "area.heading");
    $("#footerData").textContent = T(m === "routable" ? "footer.data_rt" : "footer.data");
    App.applyLayers();
    App.modes[m].activate();
    renderModeCards();
    App.renderInstall();
    if (location.hash !== "#" + m) history.replaceState(null, "", "#" + m);
    if (fromUser) modeChosen = true;
  }
  App.setMode = setMode;

  App.renderInstall = function () {
    const m = App.modes[App.state.mode];
    $("#installBox").innerHTML = m ? m.installHtml() : "";
  };

  // Buttons rendered by modes that jump to another mode (e.g. a region
  // pack over the tile cap → custom area around that region).
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (!b) return;
    const zone = App.state.mode === "region" ? App.modes.region.selectedZone() : null;
    modeChosen = true;
    setMode(b.dataset.goto, true);
    if (zone) map.fitBounds(App.lv95BboxToBounds(zone.bbox_lv95), { padding: [20, 20] });
    document.getElementById("stepArea").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ── season (raster modes) ──
  document.querySelectorAll("input[name=season]").forEach((r) => r.addEventListener("change", (e) => {
    App.state.season = e.target.value;
    App.modes.custom.onSeason();
    App.applyLayers();
    if (App.state.mode === "region") App.modes.region.onSeason();
  }));

  // ── language ──
  function setLang(lang) {
    App.state.lang = App.LANGS.includes(lang) ? lang : "en";
    try { localStorage.setItem("lang", App.state.lang); } catch (e) { /* storage blocked */ }
    App.applyStaticI18n();
    const cur = App.state.mode;
    if (cur) {
      $("#areaHeading").textContent = T(cur === "routable" ? "area.heading_rt" : "area.heading");
      $("#footerData").textContent = T(cur === "routable" ? "footer.data_rt" : "footer.data");
    }
    const first = $("#deviceSel option[value='']");
    if (first) first.textContent = T(devices.size ? "dev.choose" : "dev.loading");
    renderDeviceInfo();
    renderModeCards();
    App.applyLayers();
    if (cur) App.modes[cur].render();
    App.renderInstall();
  }
  document.querySelectorAll(".langs button").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));

  // ── boot ──
  App.state.lang = App.detectLang();
  App.applyStaticI18n();
  renderDeviceInfo();
  const hashMode = location.hash.slice(1);
  if (MODES.includes(hashMode)) { modeChosen = true; setMode(hashMode, false); }
  else setMode("region", false);
  window.addEventListener("hashchange", () => {
    const m = location.hash.slice(1);
    if (MODES.includes(m) && m !== App.state.mode) { modeChosen = true; setMode(m, true); }
  });
  App.manifestReady.then((m) => {
    maxZoneTiles = Math.max(...m.zones.map((z) => z.total_tiles_est || 0)) || maxZoneTiles;
    renderModeCards();
  }).catch((err) => {
    $("#regionResult").innerHTML = `<div class="empty-state">⚠ manifest.json: ${App.esc(err.message)}</div>`;
  });
})();
