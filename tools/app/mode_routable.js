// Routable mode: vector Garmin .img with a routing graph, built from
// OpenStreetMap with mkgmap. Whole country = prebuilt release download;
// region / rectangle = self-contained build kit (Docker, native, GH Actions).
(function () {
  "use strict";
  const { $, T, map } = App;
  // Array-valued strings (install step lists).
  const TA = (key) => {
    const d = window.I18N[App.state.lang] || window.I18N.en;
    return d[key] || window.I18N.en[key] || [];
  };

  // ── repo / release location ──
  // On GitHub Pages: https://<owner>.github.io/<repo>/app.html
  const FALLBACK_REPO = "progressive-kiwi/garminswisstopo-public";
  const REPO = (() => {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return m && seg && !seg.endsWith(".html") ? `${m[1]}/${seg}` : FALLBACK_REPO;
  })();
  const RELEASE_TAG = "routable-latest";
  const relUrl = (name) => `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${name}`;
  const rawUrl = (path) => `https://raw.githubusercontent.com/${REPO}/main/${path}`;

  // Calibration from the full-CH build (MB of .img per km², OSM 2026-10).
  const MB_PER_KM2 = 0.0074;
  const CH_BBOX = [5.95, 45.81, 10.50, 47.81];
  const CH_KM2 = 41285;

  // Device install profiles; watches.json keys map onto these in main.js.
  const PROFILES = {
    fenix9pro: { name: "fēnix 9 Pro", folder: "Garmin", folderAlt: "Garmin/Maps", key: "fx" },
    edge1050: { name: "Edge 1050", folder: "Garmin/Maps", folderAlt: "Garmin", key: "edge" },
  };
  const profile = () => PROFILES[(App.state.device && App.state.device.routable) || "fenix9pro"];

  const group = L.layerGroup();
  const zoneGroup = L.layerGroup();
  const style = { color: "#d4351c", weight: 2, fillOpacity: 0.12 };
  let rect = null, preview = null;
  let bbox = CH_BBOX.slice();
  let zones = [];           // {n, id, label, bbox (WGS84), rect}
  let zoneIdx = 0;
  let drawing = false, corner = null;
  let userName = false, userFile = false;

  const areaKey = () => document.querySelector("input[name=rtArea]:checked").value;
  const areaKm2 = (b) => {
    const lat = ((b[1] + b[3]) / 2) * Math.PI / 180;
    return Math.abs(b[2] - b[0]) * 111.32 * Math.cos(lat) * Math.abs(b[3] - b[1]) * 110.57;
  };

  function setBbox(b, fit) {
    bbox = b.map((v) => Math.round(v * 10000) / 10000);
    const ll = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    if (rect) rect.setBounds(ll); else { rect = L.rectangle(ll, { ...style, interactive: false }); group.addLayer(rect); }
    if (fit !== false) map.fitBounds(ll, { padding: [20, 20] });
    refresh();
  }

  // ── region presets (same 31 zones as the KMZ packs) ──
  App.manifestReady.then(() => {
    zones = App.state.zones.map((z) => {
      const [[s, w], [n, e]] = App.lv95BboxToBounds(z.bbox_lv95);
      const r = L.rectangle([[s, w], [n, e]], { color: "#555", weight: 1.5, fillColor: "#555", fillOpacity: 0.04 });
      const zone = { n: z.n, id: `${String(z.n).padStart(2, "0")}_${z.name}`, label: `${App.zoneLabel(z)} · ${z.desc || ""}`, bbox: [w, s, e, n], rect: r };
      r.bindTooltip(App.zoneLabel(z), { sticky: true });
      r.on("click", () => pickZone(zones.indexOf(zone)));
      zoneGroup.addLayer(r);
      return zone;
    });
    $("#rtZoneSel").innerHTML = zones.map((z, i) => `<option value="${i}">${App.esc(z.label)}</option>`).join("");
    if (App.state.mode === "routable" && areaKey() === "zone") applyArea();
  }).catch(() => {
    $("#rtZoneSel").innerHTML = `<option value="">${T("rt.presets_unavailable")}</option>`;
  });

  function pickZone(i) {
    zoneIdx = i;
    $("#rtZoneSel").value = String(i);
    zones.forEach((z, k) => z.rect.setStyle(k === i
      ? { color: "#d4351c", weight: 2.5, fillOpacity: 0 }
      : { color: "#555", weight: 1.5, fillOpacity: 0.04 }));
    defaultNames();
    setBbox(zones[i].bbox, false);
  }
  $("#rtZoneSel").addEventListener("change", (e) => pickZone(+e.target.value || 0));

  // ── rectangle drawing ──
  function startDraw() {
    drawing = true; corner = null;
    $("#map").classList.add("drawing");
    $("#rtDrawBtn").textContent = T("rt.draw_first");
  }
  function stopDraw() {
    drawing = false; corner = null;
    if (preview) { group.removeLayer(preview); preview = null; }
    $("#map").classList.remove("drawing");
  }
  $("#rtDrawBtn").addEventListener("click", startDraw);
  map.on("click", (e) => {
    if (!drawing || App.state.mode !== "routable") return;
    if (!corner) {
      corner = e.latlng;
      preview = L.rectangle([corner, corner], { ...style, dashArray: "4 4", interactive: false });
      group.addLayer(preview);
      $("#rtDrawBtn").textContent = T("rt.draw_second");
      return;
    }
    const a = corner, b = e.latlng;
    stopDraw();
    $("#rtDrawBtn").textContent = T("rt.draw_redo");
    setBbox([Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)], false);
  });
  map.on("mousemove", (e) => { if (drawing && corner && preview) preview.setBounds([corner, e.latlng]); });

  function applyArea() {
    const a = areaKey();
    $("#rtZoneRow").classList.toggle("hidden", a !== "zone");
    $("#rtDrawRow").classList.toggle("hidden", a !== "draw");
    $("#rtPkgCh").classList.toggle("hidden", a !== "ch");
    $("#rtPkgCustom").classList.toggle("hidden", a === "ch");
    if (a === "zone") zoneGroup.addTo(map); else map.removeLayer(zoneGroup);
    if (a !== "draw") stopDraw();
    $("#rtDrawBtn").textContent = T("rt.draw_start");
    defaultNames();
    if (a === "ch") setBbox(CH_BBOX);
    else if (a === "zone" && zones.length) pickZone(zoneIdx);
    else if (a === "draw") startDraw();
    hint();
  }
  document.querySelectorAll("input[name=rtArea]").forEach((r) => r.addEventListener("change", applyArea));

  function hint() {
    $("#placeHint").textContent = T("rt.hint_" + areaKey());
  }

  // ── naming ──
  $("#rtOptName").addEventListener("input", () => { userName = true; refresh(); });
  $("#rtOptFile").addEventListener("input", () => { userFile = true; refresh(); });
  $("#rtOptFid").addEventListener("input", refresh);
  function defaultNames() {
    const a = areaKey();
    let n = "CH routable", f = "CH_routable";
    if (a === "zone" && zones.length) {
      const z = zones[zoneIdx];
      n = `CH ${z.id.slice(3).replace(/_/g, " ")}`.slice(0, 40);
      f = `${z.id}_routable`;
    }
    if (a === "draw") { n = "CH custom area"; f = "CH_custom_routable"; }
    if (!userName || a === "ch") $("#rtOptName").value = n;
    if (!userFile || a === "ch") $("#rtOptFile").value = f;
    if (a === "ch") { userName = userFile = false; $("#rtOptFid").value = 6421; }
  }
  function opts() {
    const name = ($("#rtOptName").value.trim() || "CH routable").replace(/["`$\\]/g, "");
    const file = ($("#rtOptFile").value.trim() || "CH_routable").replace(/\.img$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_") + ".img";
    const fid = Math.min(65535, Math.max(1, parseInt($("#rtOptFid").value, 10) || 6421));
    return { name, file, fid, bbox: bbox.join(",") };
  }
  function commands() {
    const o = opts();
    const args = `--bbox ${o.bbox} --name "${o.name}" --family-id ${o.fid} --out out/${o.file}`;
    return {
      native: `./build_img.sh ${args}`,
      docker: `docker run --rm -v "$PWD":/w -w /w eclipse-temurin:21-jre bash -c \\\n  "apt-get update -qq && apt-get install -y -qq osmium-tool curl >/dev/null && ./build_img.sh ${args.replace(/"/g, '\\"')}"`,
      gha: `bbox:      ${o.bbox}\nname:      ${o.name}\nfamily_id: ${o.fid}\nout_name:  ${o.file}`,
    };
  }

  function refresh() {
    const a = areaKey(), o = opts();
    const km2 = a === "ch" ? CH_KM2 : areaKm2(bbox);
    const mb = Math.max(1, km2 * MB_PER_KM2);
    $("#rtStats").innerHTML = `
      <dt>${T("rt.stat_bbox")}</dt><dd>${o.bbox}</dd>
      <dt>${T("rt.stat_area")}</dt><dd>${Math.round(km2).toLocaleString("en").replace(/,/g, " ")} km²</dd>
      <dt>${T("rt.stat_size")}</dt><dd>~${App.fmtMb(mb)} MB <small>${T("rt.stat_size_note")}</small></dd>`;
    const c = commands();
    $("#rtCmdNative").textContent = c.native;
    $("#rtCmdDocker").textContent = c.docker;
    $("#rtCmdGha").textContent = c.gha;
    if (App.state.mode === "routable" && App.renderInstall) App.renderInstall();
  }

  function installHtml() {
    const d = profile();
    const o = areaKey() === "ch" ? { name: "CH routable", file: "CH_routable.img" } : opts();
    const v = { dev: d.name, file: App.esc(o.file), name: App.esc(o.name), folder: d.folder, folderAlt: d.folderAlt };
    const li = (arr) => arr.map((s) => `<li>${s.split("{name}").join(v.name)}</li>`).join("");
    return `
      <ol class="steps">
        <li>${T("rt.i.connect", v)}
          <table>
            <tr><th>Windows</th><td>${T("rt.i.win", v)}</td></tr>
            <tr><th>macOS</th><td>${T("rt.i.mac")}</td></tr>
            <tr><th>Linux</th><td>${T("rt.i.linux")}</td></tr>
          </table></li>
        <li>${T("rt.i.copy", v)}<pre>Internal Storage/${d.folder}/${v.file}</pre>${T("rt.i.copy_note")}</li>
        <li>${T("rt.i.eject")}</li>
        <li>${T("rt.i.reboot", { how: T(`rt.${d.key}.reboot`) })}</li>
        <li>${T("rt.i.enable")}<ul>${li(TA(`rt.${d.key}.enable`))}</ul></li>
        <li>${T("rt.i.route")}<ul>${li(TA(`rt.${d.key}.route`))}</ul></li>
      </ol>
      <div class="callout warn">${T("rt.i.not_listed", v)}</div>
      <div class="callout info">${T("rt.i.update", v)}</div>
      <details class="box"><summary>${T("rt.n.compat")}</summary><ul>${li(TA("rt.n.compat_list"))}</ul></details>
      <details class="box"><summary>${T("rt.n.why_osm")}</summary><p>${T("rt.n.why_osm_p")}</p></details>
      <details class="box"><summary>${T("rt.n.contents")}</summary><ul>${li(TA("rt.n.contents_list"))}</ul></details>`;
  }

  // ── prebuilt release ──
  let release = null;
  $("#rtDlImg").href = relUrl("CH_routable.img");
  $("#rtDlZip").href = relUrl("CH_routable.zip");
  fetch(`https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => { release = rel; renderRelease(); })
    .catch(() => { release = false; renderRelease(); });
  function renderRelease() {
    const img = release && release.assets.find((x) => x.name === "CH_routable.img");
    const zip = release && release.assets.find((x) => x.name === "CH_routable.zip");
    $("#rtDlImgLbl").textContent = T("rt.dl_img") + (img ? ` · ${Math.round(img.size / 1048576)} MB` : "");
    $("#rtDlZip").textContent = ".zip" + (zip ? ` · ${Math.round(zip.size / 1048576)} MB` : "");
    $("#rtRelInfo").textContent = release === false ? T("rt.rel_missing")
      : release ? T("rt.rel_built", { date: new Date(release.published_at || release.created_at).toISOString().slice(0, 10) }) : "";
  }

  // ── build kit: store-only zip, no dependency ──
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function makeZip(files) { // files: [{name, data: Uint8Array, exec}]
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 0x031e, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
      ch.setUint16(28, name.length, true); ch.setUint32(38, ((f.exec ? 0o100755 : 0o100644) << 16) >>> 0, true);
      ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + sz;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }
  async function getText(path) {
    for (const u of [path, rawUrl(path)]) {
      try { const r = await fetch(u); if (r.ok) return await r.text(); } catch (_) { /* try next */ }
    }
    throw new Error(`could not load ${path}`);
  }
  $("#rtKitBtn").addEventListener("click", async () => {
    const btn = $("#rtKitBtn");
    btn.disabled = true; btn.textContent = T("rt.kit_preparing");
    try {
      const [sh, args] = await Promise.all([getText("routable/build_img.sh"), getText("routable/mkgmap.args")]);
      const o = opts(), c = commands(), enc = new TextEncoder();
      const readme = [
        `Routable Garmin map build kit — ${o.name}`,
        `Device: ${profile().name}`,
        `Area (W,S,E,N): ${o.bbox}`,
        "",
        "Docker (any OS):",
        c.docker.replace(/\\\n\s*/g, ""),
        "",
        "Native (Linux/macOS, Java 11+, curl, osmium-tool):",
        c.native,
        "",
        `Result: out/${o.file}. Install: copy to Garmin/ (watch) or Garmin/Maps/ (Edge), reboot, enable in Map Manager.`,
        "Map data (c) OpenStreetMap contributors, ODbL.",
      ].join("\n");
      const run = `#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\n${c.native}\n`;
      const blob = makeZip([
        { name: "build_img.sh", data: enc.encode(sh), exec: true },
        { name: "mkgmap.args", data: enc.encode(args) },
        { name: "run.sh", data: enc.encode(run), exec: true },
        { name: "README.txt", data: enc.encode(readme) },
      ]);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = o.file.replace(/\.img$/, "") + "_kit.zip";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      alert(e.message);
    } finally {
      btn.disabled = false; btn.textContent = T("rt.kit");
    }
  });
  $("#rtCopyBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(commands().docker.replace(/\\\n\s*/g, "")).then(() => {
      $("#rtCopyBtn").textContent = T("rt.copied");
      setTimeout(() => ($("#rtCopyBtn").textContent = T("rt.copy")), 1500);
    });
  });

  App.modes.routable = {
    activate() {
      group.addTo(map);
      renderRelease();
      applyArea();
    },
    deactivate() {
      stopDraw();
      map.removeLayer(group);
      map.removeLayer(zoneGroup);
    },
    onPlace(p) {
      map.setView([p.lat, p.lon], 11);
      if (areaKey() === "zone") {
        const i = zones.findIndex((z) => p.lon >= z.bbox[0] && p.lon <= z.bbox[2] && p.lat >= z.bbox[1] && p.lat <= z.bbox[3]);
        if (i >= 0) pickZone(i);
      }
    },
    onDevice() { refresh(); },
    render() { hint(); renderRelease(); refresh(); },
    installHtml,
  };
  defaultNames();
})();
