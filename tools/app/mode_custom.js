// Custom mode: paint 10 × 10 km LV95 cells sized to the device's tile cap,
// then queue a hosted build (emailed) or export selection.json for a local
// PowerShell build.
(function () {
  "use strict";
  const { $, T, map } = App;

  // Switzerland LV95 extent (canonical).
  const CH = { eMin: 2485000, nMin: 1075000, eMax: 2834000, nMax: 1296000 };
  const CELL_KM = 10;
  const CELL_M = CELL_KM * 1000;
  // At 2.5 m/px LK25-native one 1024 px tile ≈ 2.56 km: ~15.3 raw tiles per
  // cell; the blank-tile mask typically drops ~30% (lakes, border).
  const TILES_PER_CELL_KEPT = Math.round(Math.ceil((CELL_KM / 2.56) ** 2) * 0.7);
  const DEFAULT_CAP = 500;
  const COLORS = ["#e74c3c", "#27ae60", "#8e44ad", "#e67e22", "#16a085", "#2980b9"];

  const group = L.layerGroup();
  const cells = [];
  let eSteps = [], nSteps = [];
  let built = false;
  let buildInFlight = false;
  const towns = [];          // {id, label, e, n, color, circle, cellIndices:Set}
  let colorIdx = 0;

  // Per-zone overview tiers (T2 pk100 cell-aligned, T3/T4 scale with the
  // union bbox) bundle into one `<pack>_overview.kmz`.
  function estimateOverviewTiles(count, bb) {
    if (!count || !bb) return 0;
    const w = (bb[2] - bb[0]) / 1000, h = (bb[3] - bb[1]) / 1000;
    return count + Math.ceil(w / 51.2) * Math.ceil(h / 51.2) + Math.ceil(w / 153.6) * Math.ceil(h / 153.6);
  }

  function cap() {
    const d = App.state.device;
    return d ? d.tile_cap : DEFAULT_CAP;
  }

  // LV95 is rotated ~1° against lat/lon, so cells are drawn as 4-corner
  // polygons over a shared, once-projected vertex grid: neighbours share
  // corners exactly (no gaps or overlaps when zoomed in).
  function buildGrid() {
    if (built) return;
    built = true;
    for (let e = CH.eMin; e <= CH.eMax; e += CELL_M) eSteps.push(Math.min(e, CH.eMax));
    if (eSteps[eSteps.length - 1] !== CH.eMax) eSteps.push(CH.eMax);
    for (let n = CH.nMin; n <= CH.nMax; n += CELL_M) nSteps.push(Math.min(n, CH.nMax));
    if (nSteps[nSteps.length - 1] !== CH.nMax) nSteps.push(CH.nMax);
    const verts = eSteps.map((e) => nSteps.map((n) => App.lv95ToLatLng(e, n)));
    for (let i = 0; i < eSteps.length - 1; i++) {
      for (let j = 0; j < nSteps.length - 1; j++) {
        const pts = [verts[i][j], verts[i + 1][j], verts[i + 1][j + 1], verts[i][j + 1]];
        const rect = L.polygon(pts, { color: "#555", weight: 0.4, fillColor: "#3498db", fillOpacity: 0 });
        const cell = { lv95: [eSteps[i], nSteps[j], eSteps[i + 1], nSteps[j + 1]], selected: false, rect };
        rect.on("click", (ev) => {
          const oe = ev.originalEvent;
          if (oe && (oe.shiftKey || oe.ctrlKey)) return; // hover-paint handles these
          setSelected(cell, !cell.selected);
          updateStatus();
        });
        // Hover-paint: Ctrl selects, Shift un-selects, read from the live
        // event so the modifier can change without lifting the mouse.
        rect.on("mouseover", (ev) => {
          const oe = ev.originalEvent;
          if (!oe) return;
          if (oe.shiftKey && setSelected(cell, false)) updateStatus();
          else if (oe.ctrlKey && !oe.shiftKey && setSelected(cell, true)) updateStatus();
        });
        group.addLayer(rect);
        cells.push(cell);
      }
    }
  }

  function setSelected(c, sel) {
    if (c.selected === sel) return false;
    c.selected = sel;
    c.rect.setStyle({ fillOpacity: sel ? 0.45 : 0, color: sel ? "#2980b9" : "#555", weight: sel ? 1.8 : 0.4 });
    return true;
  }
  function applyCellSet(idx, sel) {
    let changed = false;
    for (const i of idx) if (setSelected(cells[i], sel)) changed = true;
    if (changed) updateStatus();
  }
  const selectedCells = () => cells.filter((c) => c.selected);

  // ── places: select cells whose centre lies within the radius ──
  function cellsWithinRadius(cE, cN, km) {
    const r = km * 1000, r2 = r * r, hits = new Set();
    const iMin = Math.max(0, Math.floor((cE - r - CH.eMin) / CELL_M));
    const iMax = Math.min(eSteps.length - 2, Math.floor((cE + r - CH.eMin) / CELL_M));
    const jMin = Math.max(0, Math.floor((cN - r - CH.nMin) / CELL_M));
    const jMax = Math.min(nSteps.length - 2, Math.floor((cN + r - CH.nMin) / CELL_M));
    for (let i = iMin; i <= iMax; i++) {
      const ec = (eSteps[i] + eSteps[i + 1]) / 2;
      for (let j = jMin; j <= jMax; j++) {
        const nc = (nSteps[j] + nSteps[j + 1]) / 2;
        if ((ec - cE) ** 2 + (nc - cN) ** 2 <= r2) hits.add(i * (nSteps.length - 1) + j);
      }
    }
    return hits;
  }
  const radius = () => parseFloat($("#townRadius").value) || 15;

  function onPlace(p) {
    buildGrid();
    const color = COLORS[colorIdx++ % COLORS.length];
    const circle = L.circle([p.lat, p.lon], { radius: radius() * 1000, color, weight: 2, fillOpacity: 0.08 });
    group.addLayer(circle);
    const t = { id: `t${Date.now()}_${Math.floor(Math.random() * 1e4)}`, label: p.label, e: p.e, n: p.n,
                color, circle, cellIndices: cellsWithinRadius(p.e, p.n, radius()) };
    towns.push(t);
    applyCellSet(t.cellIndices, true);
    renderTowns();
    if (!map.getBounds().contains([p.lat, p.lon])) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 9));
  }
  function removeTown(id) {
    const i = towns.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = towns[i];
    group.removeLayer(t.circle);
    const keep = new Set();
    for (const o of towns) if (o.id !== id) for (const c of o.cellIndices) keep.add(c);
    towns.splice(i, 1);
    applyCellSet([...t.cellIndices].filter((c) => !keep.has(c)), false);
    renderTowns();
  }
  function recomputeTowns() {
    const km = radius();
    $("#townRadiusLbl").textContent = km;
    if (!towns.length) return;
    const fresh = towns.map((t) => cellsWithinRadius(t.e, t.n, km));
    const oldU = new Set(), newU = new Set();
    for (const t of towns) for (const c of t.cellIndices) oldU.add(c);
    for (const s of fresh) for (const c of s) newU.add(c);
    applyCellSet([...oldU].filter((c) => !newU.has(c)), false);
    applyCellSet(newU, true);
    towns.forEach((t, k) => { t.cellIndices = fresh[k]; t.circle.setRadius(km * 1000); });
    renderTowns();
  }
  function renderTowns() {
    $("#townChips").innerHTML = towns.map((t) =>
      `<span class="chip"><span class="swatch" style="background:${t.color}"></span>${App.esc(t.label)}
         <small>(${t.cellIndices.size} ${T("status.cells")})</small>
         <span class="x" data-id="${t.id}" title="${T("town.remove")}">×</span></span>`).join(" ");
  }
  $("#townChips").addEventListener("click", (e) => { const x = e.target.closest(".x"); if (x) removeTown(x.dataset.id); });
  $("#townRadius").addEventListener("input", recomputeTowns);

  // ── modifier keys: cursor, controls highlight, suspend map drag ──
  const mods = { ctrl: false, shift: false };
  function syncMods() {
    const active = App.state.mode === "custom";
    const ctrl = active && mods.ctrl, shift = active && mods.shift;
    document.body.classList.toggle("painting-add", ctrl && !shift);
    document.body.classList.toggle("painting-remove", shift);
    if (ctrl || shift) map.dragging.disable(); else map.dragging.enable();
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Control" && !mods.ctrl) { mods.ctrl = true; syncMods(); }
    if (e.key === "Shift" && !mods.shift) { mods.shift = true; syncMods(); }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control" && mods.ctrl) { mods.ctrl = false; syncMods(); }
    if (e.key === "Shift" && mods.shift) { mods.shift = false; syncMods(); }
  });
  window.addEventListener("blur", () => { mods.ctrl = mods.shift = false; syncMods(); });

  // ── status ──
  function updateStatus() {
    const sel = selectedCells();
    let est = 0, bb = null;
    if (sel.length) {
      bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const c of sel) {
        bb[0] = Math.min(bb[0], c.lv95[0]); bb[1] = Math.min(bb[1], c.lv95[1]);
        bb[2] = Math.max(bb[2], c.lv95[2]); bb[3] = Math.max(bb[3], c.lv95[3]);
      }
      est = sel.length * TILES_PER_CELL_KEPT;
    }
    const estOv = estimateOverviewTiles(sel.length, bb);
    // The tile cap is a render-cache limit; the watch loads one tier at a
    // time (detail OR overview), so the load is the max, not the sum.
    const peak = Math.max(est, estOv);
    const c = cap();
    $("#cellCount").textContent = sel.length;
    $("#tileEst").textContent = peak;
    $("#tileEstDetail").textContent = est;
    $("#tileEstOv").textContent = estOv;
    $("#tileCapLbl").textContent = c || "–";
    $("#tileMeter").style.width = c ? Math.min(100, (peak / c) * 100) + "%" : "0";
    $("#cellStatus").className = "stat-box" + (!sel.length ? "" : c && peak > c ? " warn" : " ok");
    $("#exportBtn").disabled = !sel.length;
    const d = App.state.device;
    const btn = $("#buildBtn");
    btn.disabled = buildInFlight || !sel.length || !d || d.tile_cap === 0;
    btn.title = !d ? T("build.need_device") : "";
    return { bb, est, estOv, peak, count: sel.length };
  }

  $("#clearBtn").addEventListener("click", () => {
    for (const c of cells) setSelected(c, false);
    while (towns.length) group.removeLayer(towns.pop().circle);
    renderTowns();
    updateStatus();
    $("#jobProgress").innerHTML = "";
    $("#exportOut").innerHTML = "";
  });

  // ── hosted build ──
  // POSTs the cells to the Cloudflare Worker, which dispatches the GH
  // Actions custom build and emails the result (~10–15 min). The Worker URL
  // is injected at deploy time (pages.yml) as window.GSST_BUILD_API.
  const BUILD_API = (window.GSST_BUILD_API || "").replace(/\/$/, "");
  async function buildHosted(lv95Cells) {
    const prog = $("#jobProgress");
    const box = (cls, html) => (prog.innerHTML = `<div class="callout ${cls}">${html}</div>`);
    if (!BUILD_API) return box("warn", T("build.not_configured"));
    const email = $("#buildEmail").value.trim();
    if (!email && !confirm(T("build.no_email_confirm"))) return;
    const d = App.state.device;
    const payload = {
      cells: lv95Cells,
      name: "custom_" + Date.now().toString(36),
      email,
      device: d.key,
      tile_cap: d.tile_cap,
      max_files: d.max_files,
      max_kmz_mb: d.max_kmz_mb,
      base_map: App.state.season,
      routes_type: $("#optRoutesType").value,
      include_slope: $("#optSlope").checked,
      include_routes: $("#optRoutes").checked,
    };
    box("info", T("build.queuing"));
    let resp;
    try {
      resp = await fetch(`${BUILD_API}/build`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
    } catch (e) {
      return box("bad", T("build.unreachable") + ` <small>${App.esc(e.message)}</small>`);
    }
    if (!resp.ok) {
      let body = {};
      try { body = await resp.json(); } catch (_) { /* non-JSON error */ }
      const extra = body.error ? ` <small>${App.esc(body.error)}</small>` : "";
      if (resp.status === 429) return box("bad", T("build.limit", { n: body.limit || 5 }) + extra);
      if (resp.status === 502 && body.github_status === 404) {
        return box("bad", "⚠ The build dispatch token cannot reach the build repo (HTTP 502, GitHub 404). " +
          "The maintainer's PAT in the Cloudflare Worker (<code>GITHUB_TOKEN</code>) is likely expired or lacks access. " +
          "Fix: rotate it and run <code>wrangler secret put GITHUB_TOKEN</code>.");
      }
      if (resp.status >= 500) return box("bad", T("build.unavailable", { code: resp.status }) + extra);
      return box("bad", T("build.refused", { code: resp.status }) + extra);
    }
    const job = await resp.json();
    const left = typeof job.remaining === "number" ? ` <small>${T("build.remaining", { n: job.remaining, of: job.limit })}</small>` : "";
    box("good", `${job.duplicate ? T("build.duplicate") : T("build.queued")} <code>${App.esc(job.job_id)}</code>.${left}
      ${job.message ? `<p>${App.esc(job.message)}</p>` : ""}
      ${job.release_url ? `<p>${T("build.release", { url: job.release_url })} ${email ? T("build.email_too") : ""}</p>` : ""}`);
  }
  $("#buildBtn").addEventListener("click", async () => {
    if (buildInFlight) return;
    const s = updateStatus();
    if (!s.count) return;
    const c = cap();
    if (s.peak > c && !confirm(T("build.over_cap_confirm", { tiles: s.peak, cap: c }))) return;
    buildInFlight = true;
    updateStatus();
    try { await buildHosted(selectedCells().map((x) => x.lv95)); }
    finally { buildInFlight = false; updateStatus(); }
  });

  // ── developer export (local PowerShell build) ──
  $("#exportBtn").addEventListener("click", () => {
    const s = updateStatus();
    if (!s.bb) return;
    const c = cap();
    const budget = c - 30; // static overview reserve, see build_kmz_packs.ps1
    const selection = {
      cells_lv95: selectedCells().map((x) => x.lv95),
      union_bbox_lv95: s.bb,
      cell_count: s.count,
      estimated_tiles_kept: s.est,
      estimated_overview_tiles: s.estOv,
      tile_cap_total: c,
      tile_cap_alongside_overview: budget,
      generated: new Date().toISOString(),
    };
    const bbox = s.bb.join(",");
    $("#exportOut").innerHTML = `
      <div class="callout ${s.peak > c ? "bad" : "good"}">~${s.est} detail + ~${s.estOv} overview tiles, cap ${c}.</div>
      <p class="note"><strong>1.</strong> <button class="btn" type="button" id="dlSelection">Download selection.json</button></p>
      <p class="note"><strong>2.</strong> Build (cell-precise, detail + overview tiers):</p>
      <pre>.\\build_kmz_packs.ps1 -CustomCellsJson selection.json -CustomName "my_pack"</pre>
      <p class="note"><strong>3.</strong> Activate:</p>
      <pre>.\\activate_pack.ps1 -SyncLibrary
.\\activate_pack.ps1 -Zone my_pack${s.est > budget ? " -SkipOverviewTiers" : ""}</pre>
      <details><summary class="note">Legacy single-bbox build</summary>
        <pre>.\\build_kmz_packs.ps1 -CustomBbox "${bbox}" -CustomName "my_pack"</pre></details>`;
    $("#dlSelection").addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(selection, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = "selection.json"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  });

  ["optSlope", "optRoutes", "optRoutesType"].forEach((id) =>
    $("#" + id).addEventListener("change", () => App.applyLayers()));

  App.modes.custom = {
    activate() {
      buildGrid();
      group.addTo(map);
      $("#placeHint").textContent = T("custom.hint");
      updateStatus();
      syncMods();
    },
    deactivate() { map.removeLayer(group); syncMods(); },
    onPlace,
    onSeason() {
      // Routes overlay follows the season unless the user mixes on purpose.
      $("#optRoutesType").value = App.state.season === "winter" ? "ski" : "wanderwege";
    },
    onDevice() { updateStatus(); },
    render() { $("#placeHint").textContent = T("custom.hint"); renderTowns(); updateStatus(); },
    installHtml: () => App.kmzInstallHtml(),
  };
})();
