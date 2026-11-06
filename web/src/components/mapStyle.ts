// Shared basemap settings for every MapLibre map in the app.
import { setWorkerUrl } from "maplibre-gl";

export const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/dark";
export const MAP_ATTRIBUTION = '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · © участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · NASA FIRMS';

// Copied from the installed package by scripts/copy-maplibre-worker.mjs (predev/prebuild).
setWorkerUrl("/maplibre-gl-worker.mjs");
