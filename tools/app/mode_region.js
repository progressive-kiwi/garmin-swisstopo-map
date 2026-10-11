// Region mode: the 31 prebuilt KMZ zones. Click a zone (or search a place)
// and get that zone's zip / file list for the current season.
(function () {
  "use strict";
  const { $, T, map } = App;
  const group = L.layerGroup();
  let rects = [];               // [{zone, rect}]
  let selectedN = null;         // zone.n of the picked zone
  let alternatives = [];        // other zones covering a searched place
  let placeMarker = null;

  function deviceCap() {
    const d = App.state.device;
    return d && d.tile_cap > 0 ? d.tile_cap : null;
  }

  function styleRects() {
    for (const { zone, rect } of rects) {
      const sel = zone.n === selectedN;
      const alt = alternatives.includes(zone.n);
      rect.setStyle({
        color: sel ? "#27ae60" : alt ? "#3870b6" : "#555",
        fillColor: sel ? "#27ae60" : alt ? "#3870b6" : "#555",
        weight: sel ? 3 : alt ? 2 : 1.5,
        fillOpacity: sel ? 0.18 : alt ? 0.08 : 0.04,
      });
    }
  }

  function drawZones() {
    group.clearLayers();
    rects = App.zonesForSeason(App.state.season).map((zone) => {
      const rect = L.rectangle(App.lv95BboxToBounds(zone.bbox_lv95), { weight: 1.5 });
      rect.bindTooltip(App.zoneLabel(zone), { sticky: true, direction: "auto" });
      rect.on("click", () => select(zone, []));
      rect.on("mouseover", () => rect.setStyle({ weight: 3, fillOpacity: 0.15 }));
      rect.on("mouseout", styleRects);
      group.addLayer(rect);
      return { zone, rect };
    });
    styleRects();
  }

  function select(zone, alts) {
    selectedN = zone ? zone.n : null;
    alternatives = alts || [];
    if (placeMarker && !(alts && alts.length)) { map.removeLayer(placeMarker); placeMarker = null; }
    styleRects();
    render();
    const res = $("#regionResult");
    if (zone && res.getBoundingClientRect().top > window.innerHeight) res.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Place → the zone that contains it with the most margin (the point sits
  // deepest inside), others that also cover it become alternatives.
  function onPlace(p) {
    if (placeMarker) map.removeLayer(placeMarker);
    placeMarker = L.circleMarker([p.lat, p.lon], { radius: 8, color: "#d4351c", weight: 3, fillColor: "#fff", fillOpacity: 1 }).addTo(map);
    map.setView([p.lat, p.lon], 10);
    const hits = App.zonesForSeason(App.state.season)
      .filter((z) => App.inLv95Bbox(p.e, p.n, z.bbox_lv95))
      .map((z) => {
        const b = z.bbox_lv95;
        return { z, margin: Math.min(p.e - b[0], b[2] - p.e, p.n - b[1], b[3] - p.n) };
      })
      .sort((a, b) => b.margin - a.margin);
    if (!hits.length) { selectedN = null; alternatives = []; styleRects(); renderNoMatch(p.label); return; }
    select(hits[0].z, hits.slice(1).map((h) => h.z.n));
  }

  function renderNoMatch(label) {
    $("#regionResult").innerHTML = `
      <div class="result alt">
        <span class="label">${T("region.no_match.label")}</span>
        <h3>${T("region.no_match.title")}</h3>
        <p>${T("region.no_match", { place: App.esc(label || "") })}</p>
        <button class="btn btn-primary btn-block" type="button" data-goto="custom">${T("region.to_custom")}</button>
      </div>`;
    $("#placeHint").textContent = "";
  }

  function render() {
    const el = $("#regionResult");
    if (!App.state.manifest) { el.innerHTML = `<div class="empty-state">${T("region.loading")}</div>`; return; }
    renderAll();
    const season = App.state.season;
    const zone = App.state.zones.find((z) => z.n === selectedN);
    if (!zone) { el.innerHTML = `<div class="empty-state">${T("region.empty")}</div>`; return; }
    const files = App.zoneDownloads(zone, season);
    if (!files.length) {
      el.innerHTML = `<div class="result alt"><span class="label">${T("region.no_match.label")}</span>
        <h3>${App.esc(App.zoneLabel(zone))}</h3><p>${T("region.no_season")}</p>
        <button class="btn btn-primary btn-block" type="button" data-goto="custom">${T("region.to_custom")}</button></div>`;
      return;
    }
    const totalMb = files.reduce((a, f) => a + (f.size_mb || 0), 0);
    const zip = App.zipFor(zone, season);
    const cap = deviceCap();
    const tiles = zone.total_tiles_est || 0;
    let fit = "";
    if (cap && tiles > cap) {
      fit = `<div class="callout bad">${T("region.over_cap", { tiles, cap })}
        <p><button class="btn" type="button" data-goto="custom">${T("region.to_custom")}</button></p></div>`;
    } else if (cap && tiles) {
      fit = `<div class="callout good">${T("region.fits_cap", { tiles, cap })}</div>`;
    }
    const alts = alternatives.map((n) => App.state.zones.find((z) => z.n === n)).filter(Boolean);
    el.innerHTML = `
      <div class="result">
        <span class="label">${T("region.label")}</span>
        <h3>${App.esc(App.zoneLabel(zone))}${season === "summer" ? ` <small>(${T("season.summer_lbl")})</small>` : ""}</h3>
        <p>${App.esc(zone.desc || "")}<br>${T("region.total", { n: files.length, mb: App.fmtMb(totalMb) })}</p>
        ${fit}
        ${zip
          ? `<a class="btn btn-primary btn-block" href="${App.fileUrl(zip.name)}" download>⬇ ${T("region.dl_zip", { mb: zip.size_mb })}</a>
             <p class="tip">${T("region.dl_zip_tip")}</p>
             <details><summary class="note">${T("region.dl_individual")}</summary>${App.dlRowsHtml(files)}</details>`
          : `${files.length > 1 ? `<button class="btn btn-primary btn-block" type="button" id="regionDlAll">⬇ ${T("region.dl_all", { n: files.length })}</button>` : ""}
             ${App.dlRowsHtml(files)}
             <p class="tip">${T("dl.multi_tip")}</p>`}
      </div>
      ${alts.length ? `<h3 class="sect">${T("region.alts")}</h3>
        <div class="btn-row">${alts.map((z) => `<button class="btn" type="button" data-zone="${z.n}">${App.esc(App.zoneLabel(z))}</button>`).join("")}</div>` : ""}`;
    const all = $("#regionDlAll");
    if (all) all.addEventListener("click", () => App.downloadStaggered(files, all));
    el.querySelectorAll("[data-zone]").forEach((b) => b.addEventListener("click", () => {
      const z = App.state.zones.find((x) => x.n === +b.dataset.zone);
      select(z, alternatives.filter((n) => n !== z.n).concat(selectedN));
    }));
  }

  // "Everything at once": only when the whole season set fits the tile cap
  // of the chosen device (or the manifest default). Hidden with today's data
  // (~7,400 tiles), shows up automatically if the set ever gets that small.
  function renderAll() {
    const el = $("#regionAll");
    const zones = App.zonesForSeason(App.state.season);
    const cap = deviceCap() || App.state.manifest.tile_cap;
    const tiles = zones.reduce((a, z) => a + (z.total_tiles_est || 0), 0);
    if (!zones.length || !cap || tiles > cap) { el.innerHTML = ""; return; }
    const files = zones.flatMap((z) => App.zoneDownloads(z, App.state.season));
    const mb = App.fmtMb(files.reduce((a, f) => a + (f.size_mb || 0), 0));
    el.innerHTML = `
      <div class="result" style="margin-top:1rem">
        <span class="label">${T("all.label")}</span>
        <h3>${T("all.title")}</h3>
        <p>${T("all.body", { season: T("all.season_" + App.state.season), mb, n: files.length })}</p>
        <button class="btn btn-primary btn-block" type="button" id="regionDlCh">⬇ ${T("all.btn", { n: files.length, mb })}</button>
        <p class="tip">${T("dl.multi_tip")}</p>
      </div>`;
    const btn = $("#regionDlCh");
    btn.addEventListener("click", () => App.downloadStaggered(files, btn));
  }

  App.modes.region = {
    activate() {
      group.addTo(map);
      App.manifestReady.then(() => { if (App.state.mode === "region") { drawZones(); render(); } });
      $("#placeHint").textContent = T("region.hint");
      render();
    },
    deactivate() {
      map.removeLayer(group);
      if (placeMarker) { map.removeLayer(placeMarker); placeMarker = null; }
    },
    onPlace,
    onSeason() {
      // Keep the picked zone if it exists in the new season; drawZones only
      // lists zones that have files for it.
      drawZones();
      render();
    },
    render() { $("#placeHint").textContent = T("region.hint"); render(); },
    installHtml: () => App.kmzInstallHtml(),
    selectedZone: () => App.state.zones.find((z) => z.n === selectedN) || null,
  };
})();
