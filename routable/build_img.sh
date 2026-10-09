#!/usr/bin/env bash
# Build a routable Garmin vector map (single .img) of Switzerland or a
# sub-area, for fenix 9 Pro / Edge 1050.
#
# Pipeline: OSM extract (.pbf) -> optional bbox crop (osmium) -> splitter ->
# mkgmap (--route --index --gmapsupp) -> <out>.img
#
# Usage:
#   ./build_img.sh                                  # all of Switzerland
#   ./build_img.sh --bbox 7.30,46.35,8.15,46.75     # minlon,minlat,maxlon,maxlat
#   ./build_img.sh --bbox ... --name "Wallis" --out wallis_routable.img
#
# Options:
#   --bbox  W,S,E,N     crop area (WGS84 degrees). Requires osmium-tool.
#   --name  TEXT        map name shown on the device   (default "CH routable")
#   --out   FILE        output .img                    (default CH_routable.img)
#   --family-id N       Garmin family ID, 1..65535     (default 6421)
#   --pbf   FILE        use a local .osm.pbf instead of downloading
#   --work  DIR         scratch directory              (default ./work)
#   --no-typ            skip the mapnik TYP (device default colours)
#
# Env: JAVA_XMX (default 4g), MKGMAP_URL, SPLITTER_URL.
# Needs: bash, curl, tar, java >= 11; osmium only when --bbox is given.
set -euo pipefail

BBOX=""; NAME="CH routable"; OUT="CH_routable.img"; FID=6421
PBF=""; WORK="./work"; TYP=1
JAVA_XMX="${JAVA_XMX:-4g}"
MKGMAP_URL="${MKGMAP_URL:-https://www.mkgmap.org.uk/download/mkgmap-latest.tar.gz}"
SPLITTER_URL="${SPLITTER_URL:-https://www.mkgmap.org.uk/download/splitter-latest.tar.gz}"
PBF_URLS=(
  "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf"
  "https://download.openstreetmap.fr/extracts/europe/switzerland.osm.pbf"
)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bbox)      BBOX="$2"; shift 2 ;;
    --name)      NAME="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    --family-id) FID="$2"; shift 2 ;;
    --pbf)       PBF="$2"; shift 2 ;;
    --work)      WORK="$2"; shift 2 ;;
    --no-typ)    TYP=0; shift ;;
    -h|--help)   sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$BBOX" && ! "$BBOX" =~ ^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$ ]]; then
  echo "--bbox must be W,S,E,N in decimal degrees" >&2; exit 2
fi
if (( FID < 1 || FID > 65535 )); then echo "--family-id out of range" >&2; exit 2; fi

mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
log() { printf '\n== %s\n' "$*"; }

# --- tools -----------------------------------------------------------------
fetch_tool() {  # url -> extracted dir path on stdout
  local url="$1" tgz="$WORK/$(basename "$1")"
  [[ -s "$tgz" ]] || curl -fsSL --retry 4 -o "$tgz" "$url"
  local dir; dir="$(tar tzf "$tgz" | head -1 | cut -d/ -f1)"
  [[ -d "$WORK/$dir" ]] || tar xzf "$tgz" -C "$WORK"
  echo "$WORK/$dir"
}
log "fetching mkgmap + splitter"
MKGMAP_DIR="$(fetch_tool "$MKGMAP_URL")"
SPLITTER_DIR="$(fetch_tool "$SPLITTER_URL")"
echo "mkgmap:   $MKGMAP_DIR"; echo "splitter: $SPLITTER_DIR"

# --- OSM data --------------------------------------------------------------
if [[ -z "$PBF" ]]; then
  PBF="$WORK/switzerland.osm.pbf"
  if [[ ! -s "$PBF" ]]; then
    log "downloading Switzerland OSM extract"
    for u in "${PBF_URLS[@]}"; do
      if curl -fSL --retry 3 -o "$PBF.part" "$u"; then mv "$PBF.part" "$PBF"; break; fi
      echo "  failed: $u"
    done
    [[ -s "$PBF" ]] || { echo "could not download an OSM extract" >&2; exit 1; }
  fi
fi

SRC="$PBF"
if [[ -n "$BBOX" ]]; then
  command -v osmium >/dev/null || { echo "--bbox needs osmium-tool (apt install osmium-tool / brew install osmium-tool)" >&2; exit 1; }
  log "cropping to $BBOX"
  SRC="$WORK/area.osm.pbf"
  osmium extract --overwrite --strategy=smart -b "$BBOX" -o "$SRC" "$PBF"
fi

# --- split -----------------------------------------------------------------
log "splitting"
rm -rf "$WORK/tiles"; mkdir -p "$WORK/tiles"
java -Xmx"$JAVA_XMX" -jar "$SPLITTER_DIR/splitter.jar" \
  --output-dir="$WORK/tiles" \
  --mapid="$(( (FID % 9000 + 1000) * 10000 + 1 ))" \
  --max-nodes=1200000 \
  "$SRC" > "$WORK/splitter.log"

# --- compile ---------------------------------------------------------------
log "compiling routable map"
rm -rf "$WORK/img"; mkdir -p "$WORK/img"
TYP_ARGS=()
(( TYP )) && TYP_ARGS=("$MKGMAP_DIR/examples/typ-files/mapnik.txt")
java -Xmx"$JAVA_XMX" -jar "$MKGMAP_DIR/mkgmap.jar" \
  --output-dir="$WORK/img" \
  -c "$HERE/mkgmap.args" \
  --family-id="$FID" --product-id=1 \
  --family-name="$NAME" --series-name="$NAME" --description="$NAME" \
  --area-name="$NAME" \
  --copyright-message="Map data (c) OpenStreetMap contributors, ODbL" \
  --gmapsupp \
  -c "$WORK/tiles/template.args" \
  "${TYP_ARGS[@]}" > "$WORK/mkgmap.log" 2>&1 || { tail -40 "$WORK/mkgmap.log" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
mv "$WORK/img/gmapsupp.img" "$OUT"
log "done: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Copy it to Garmin/ on the device (see tools/routable.html, step 4)."
