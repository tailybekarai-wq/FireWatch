// Shared basemap settings for every MapLibre map in the app.
import { setWorkerUrl, type Map as MapLibre } from "maplibre-gl";

export const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/dark";
export const MAP_ATTRIBUTION = '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · © участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · NASA FIRMS'
  + ' · <a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024, CC BY-NC-SA 4.0)';

// Real imagery: Sentinel-2 cloudless 2024 mosaic (10 m), free for non-commercial use, no key.
const SATELLITE_TILES = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg";

// Copied from the installed package by scripts/copy-maplibre-worker.mjs (predev/prebuild).
setWorkerUrl("/maplibre-gl-worker.mjs");

/**
 * Adds the satellite layer under the basemap labels, so place names stay readable.
 * Call after the style has loaded and before adding data layers.
 */
export function addSatellite(m: MapLibre, visible: boolean) {
  m.addSource("satellite", { type: "raster", tiles: [SATELLITE_TILES], tileSize: 256, maxzoom: 16 });
  const firstLabel = m.getStyle().layers.find((l) => l.type === "symbol")?.id;
  m.addLayer({
    id: "satellite", type: "raster", source: "satellite",
    layout: { visibility: visible ? "visible" : "none" },
    paint: { "raster-opacity": 0.95, "raster-fade-duration": 400, "raster-saturation": -0.1, "raster-brightness-max": 0.9 },
  }, firstLabel);
  // the compact attribution opens expanded on load; keep it behind its (i) button
  m.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
}

export function setSatellite(m: MapLibre, visible: boolean) {
  if (m.getLayer("satellite")) m.setLayoutProperty("satellite", "visibility", visible ? "visible" : "none");
}

/** Expanding, fading ring on a circle layer; returns a function that stops it. */
export function pulse(m: MapLibre, layer: string, from = 8, to = 28, periodMs = 1800) {
  let frame = 0;
  const start = performance.now();
  const tick = (now: number) => {
    if (!m.getLayer(layer)) return;
    const k = ((now - start) % periodMs) / periodMs;
    m.setPaintProperty(layer, "circle-radius", from + (to - from) * k);
    m.setPaintProperty(layer, "circle-stroke-opacity", 0.9 * (1 - k));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
