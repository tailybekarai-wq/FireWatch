"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { AttributionControl, LngLatBounds, Map as MapLibre, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { dateTime } from "@/lib/format";
import { BasemapToggle } from "./BasemapToggle";
import { MAP_ATTRIBUTION, MAP_STYLE, addSatellite, pulse, setSatellite } from "./mapStyle";

export type SpotPoint = { id: number; lat: number; lon: number; color: string; t: string; href?: string };

/** Ring of a circle on the sphere, for the neighbourhood outline. */
function circle(lat: number, lon: number, km: number, steps = 64): [number, number][] {
  const d = km / 6371.0088;
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const b = (2 * Math.PI * i) / steps;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI];
  });
}

/**
 * Small map around one detection or one hotspot. With `replay`, a slider steps through the
 * observation times: only points seen up to the selected moment are shown, newer brighter.
 */
export function SpotMap({ center, points, radiusKm, hull, focusColor, replay = false, height = 440, label }: {
  center: { lat: number; lon: number }; points: SpotPoint[]; radiusKm?: number; hull?: GeoJSON.Polygon | null;
  focusColor?: string; replay?: boolean; height?: number; label: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const times = useMemo(() => [...new Set(points.map((p) => p.t))].sort(), [points]);
  const [step, setStep] = useState(Math.max(0, times.length - 1));
  const [playing, setPlaying] = useState(false);
  const [satellite, setSat] = useState(true);
  const until = replay && times.length ? times[Math.min(step, times.length - 1)] : undefined;

  useEffect(() => {
    if (!container.current || map.current) return;
    // start from a regional view and fly in once the data layers are ready
    const m = new MapLibre({ container: container.current, style: MAP_STYLE, center: [center.lon, center.lat], zoom: 6, attributionControl: false });
    let stopPulse = () => {};
    m.addControl(new AttributionControl({ compact: true, customAttribution: MAP_ATTRIBUTION }), "bottom-right");
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      addSatellite(m, true);
      m.addSource("area", { type: "geojson", data: { type: "FeatureCollection", features: [
        ...(radiusKm ? [{ type: "Feature" as const, properties: { kind: "radius" }, geometry: { type: "Polygon" as const, coordinates: [circle(center.lat, center.lon, radiusKm)] } }] : []),
        ...(hull ? [{ type: "Feature" as const, properties: { kind: "hull" }, geometry: hull }] : []),
      ] } });
      m.addLayer({ id: "area-fill", type: "fill", source: "area", filter: ["==", ["get", "kind"], "hull"], paint: { "fill-color": "#FF7A3D", "fill-opacity": 0.08 } });
      m.addLayer({ id: "area-line", type: "line", source: "area", paint: {
        "line-color": ["match", ["get", "kind"], "hull", "#FF9A6B", "rgba(238,243,246,.45)"], "line-width": 1.2, "line-dasharray": [3, 3] } });
      m.addSource("pts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "pts", type: "circle", source: "pts", paint: {
        "circle-color": ["get", "color"], "circle-radius": 0, "circle-radius-transition": { duration: 700, delay: 0 }, "circle-opacity": ["get", "o"],
        "circle-stroke-color": "#04070A", "circle-stroke-width": 2 } });
      if (focusColor) {
        m.addSource("focus", { type: "geojson", data: { type: "Point", coordinates: [center.lon, center.lat] } });
        m.addLayer({ id: "focus-halo", type: "circle", source: "focus", paint: { "circle-radius": 14, "circle-opacity": 0, "circle-stroke-color": "#EEF3F6", "circle-stroke-width": 1.5 } });
        m.addLayer({ id: "focus-ring", type: "circle", source: "focus", paint: { "circle-radius": 8, "circle-opacity": 0, "circle-stroke-color": focusColor, "circle-stroke-width": 2 } });
        stopPulse = pulse(m, "focus-ring");
        m.addLayer({ id: "focus", type: "circle", source: "focus", paint: { "circle-radius": 7, "circle-color": focusColor, "circle-stroke-color": "#04070A", "circle-stroke-width": 2 } });
      }
      const b = new LngLatBounds([center.lon, center.lat], [center.lon, center.lat]);
      for (const p of points) b.extend([p.lon, p.lat]);
      if (radiusKm) for (const c of circle(center.lat, center.lon, radiusKm, 8)) b.extend(c);
      if (hull) for (const c of hull.coordinates[0]) b.extend(c as [number, number]);
      m.fitBounds(b, { padding: 56, maxZoom: 14, duration: 1800, essential: true });
      m.once("moveend", () => { if (m.getLayer("pts")) m.setPaintProperty("pts", "circle-radius", 6); });
      m.on("click", "pts", (e) => {
        const href = e.features?.[0]?.properties?.href;
        if (href) window.location.assign(String(href));
      });
      m.on("mouseenter", "pts", () => { m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "pts", () => { m.getCanvas().style.cursor = ""; });
      setReady(true);
    });
    map.current = m;
    return () => { stopPulse(); m.remove(); map.current = null; };
  }, [center.lat, center.lon, radiusKm, hull, focusColor, points]);

  useEffect(() => {
    if (ready && map.current) setSatellite(map.current, satellite);
  }, [ready, satellite]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const visible = until ? points.filter((p) => p.t <= until) : points;
    const first = times.length ? new Date(times[0]).getTime() : 0;
    const last = until ? new Date(until).getTime() : first;
    const span = Math.max(1, last - first);
    (map.current.getSource("pts") as GeoJSONSource).setData({ type: "FeatureCollection", features: visible.map((p) => ({
      type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
      properties: { color: p.color, href: p.href ?? "", o: replay ? 0.3 + 0.7 * ((new Date(p.t).getTime() - first) / span) : 1 },
    })) });
  }, [ready, points, until, replay, times]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setStep((s) => {
        if (s >= times.length - 1) { setPlaying(false); return s; }
        return s + 1;
      });
    }, 700);
    return () => window.clearInterval(id);
  }, [playing, times.length]);

  return (
    <div className="relative overflow-hidden rounded-[28px] border border-white/5 bg-[#070C10]" style={{ height }}>
      {/* .maplibregl-map sets position:relative, so positioning lives on a wrapper */}
      <div className="absolute inset-0"><div ref={container} className="h-full w-full" aria-label={label} /></div>
      <BasemapToggle satellite={satellite} onChange={setSat} className="absolute left-4 top-4" />
      {replay && times.length > 1 && (
        <div className="glass absolute inset-x-4 bottom-9 flex items-center gap-2.5 rounded-2xl px-3 py-2 text-xs">
          <button type="button" className="btn h-8 px-2.5" aria-label="Предыдущий шаг"
            onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)); }}>‹</button>
          <button type="button" className="btn h-8 px-3"
            onClick={() => { if (!playing && step >= times.length - 1) setStep(0); setPlaying((p) => !p); }}>
            {playing ? "Пауза" : "▶ Повтор"}
          </button>
          <button type="button" className="btn h-8 px-2.5" aria-label="Следующий шаг"
            onClick={() => { setPlaying(false); setStep((s) => Math.min(times.length - 1, s + 1)); }}>›</button>
          <input type="range" min={0} max={times.length - 1} value={Math.min(step, times.length - 1)} aria-label="Момент наблюдения"
            onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }} className="min-w-0 flex-1 accent-[#FF7A3D]" />
          <span className="mono whitespace-nowrap text-fg2">{dateTime(until)}</span>
        </div>
      )}
    </div>
  );
}
