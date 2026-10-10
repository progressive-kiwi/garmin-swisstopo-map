# Routable vector map — fenix 9 Pro / Edge 1050

Web app: [`tools/routable.html`](../tools/routable.html) (GitHub Pages: `routable.html`).

## Review against fenix 9 Pro (Oct 2026)

| Finding | Impact | Action |
|---|---|---|
| Repo ships raster KMZ Custom Maps only | Not routable, no search; raster decode slows pan/zoom | Added routable `.img` pipeline |
| 500-tile / 3 MB-per-KMZ cap drives the whole zone design | Irrelevant for vector `.img` (fenix 9 Pro and Edge 1050: 64 GB) | One whole-country file (310 MB) |
| fenix 9 series: new mapping engine (perspective view, 30–40 % faster pan, +50 % RAM) | Third-party `.img` and KMZ behaviour not yet publicly confirmed | Marked unverified; test-area flow in web app |
| `install.html` / `INSTALL.md` assume a USB drive named GARMIN | fenix 7+/8/9 and Edge 1050 use MTP; macOS Finder shows nothing | MTP steps per OS in `routable.html` |
| `watches.json` lacks fenix 9 | Device not selectable in tile picker | Added fenix 9 Pro 43/47/51 (cap assumed = fenix 8, flagged disputed) |
| `build_manifest.py` default slug `JoepVdE/...` | Download links point to upstream, not this fork | Unchanged (manifest built in private repo) |

## Pipeline

`routable/build_img.sh`: Swiss OSM extract → `osmium extract` (optional bbox) → splitter → mkgmap (`route`, `index`, `housenumbers`, simplified geometry, mapnik TYP) → single `.img`.

Options: `routable/mkgmap.args`.

Zoom levels (`levels=0:24, 1:22, 2:21, 3:20, 4:19, 5:18, 6:16`):

| Level | Resolution | Approx. scale | Content (mkgmap default style) |
|---|---|---|---|
| 0 | 24 | ≤ 200 m | all: paths, buildings, house numbers, POIs |
| 1–2 | 22–21 | 300 m–1 km | minor roads, tracks, mid-size areas |
| 3–4 | 20–19 | 1–3 km | secondary roads, villages, lakes |
| 5 | 18 | 5–10 km | main roads, towns, large water / forest |
| 6 | 16 | 20–30 km | motorways, trunk roads, cities, large lakes |

Default style has 4 levels (24/22/20/18); the 7-level set costs +2 % size (304 → 310 MB) and keeps the vector map visible when zoomed far out. `polygon-size-limits` drops small polygons per level. Excluded on purpose: DEM/hillshading, contours, hiking-route overlays.

| Build | Size | Time (4 cores) |
|---|---|---|
| All of Switzerland | 310 MB | ~6 min + download |
| Zürich city (~150 km²) | 10 MB | ~1 min |

CI: `.github/workflows/build-routable-img.yml`
- monthly / manual without bbox → release `routable-latest` (`CH_routable.img`, `CH_routable.zip`)
- manual with bbox → workflow artifact

Pages deploy copies `routable/` next to the page so the web app can assemble build-kit zips.

## Install (summary)

| | fenix 9 Pro | Edge 1050 |
|---|---|---|
| USB | MTP | MTP |
| Folder | `Garmin/` (fallback `Garmin/Maps/`) | `Garmin/Maps/` (fallback `Garmin/`) |
| Enable | Map → Map Manager (or CityNavigator layer) | Settings → Navigation → Maps → Map Info |
| Disable | TopoActive (same area), Custom Maps layer | TopoActive Europe |

Data: © OpenStreetMap contributors, ODbL. TYP from mkgmap (GPL).
