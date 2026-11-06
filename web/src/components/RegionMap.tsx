"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { AttributionControl, LngLatBounds, Map as MapLibre, Popup } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { REGION_RAMP, regionClass } from "@/lib/choropleth";
import { MAP_ATTRIBUTION, MAP_STYLE } from "./mapStyle";

export type RegionShape = { id: number; name: string; geometry: GeoJSON.Geometry; value: number; label: string };

/** Regions coloured by quantile class of one metric. */
export function RegionMap({ regions, breaks, unit }: { regions: RegionShape[]; breaks: number[]; unit: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const m = new MapLibre({ container: container.current, style: MAP_STYLE, center: [67, 48.2], zoom: 3.4, attributionControl: false });
    m.addControl(new AttributionControl({ compact: true, customAttribution: MAP_ATTRIBUTION }), "bottom-right");
    m.on("load", () => {
      m.addSource("regions", { type: "geojson", data: { type: "FeatureCollection", features: regions.map((r) => ({
        type: "Feature" as const, geometry: r.geometry,
        properties: { name: r.name, label: r.label, c: REGION_RAMP[regionClass(r.value, breaks)] },
      })) } });
      m.addLayer({ id: "fill", type: "fill", source: "regions", paint: { "fill-color": ["get", "c"], "fill-opacity": 0.72 } });
      m.addLayer({ id: "line", type: "line", source: "regions", paint: { "line-color": "#04070A", "line-width": 1 } });
      const b = new LngLatBounds();
      for (const r of regions) {
        const polys = r.geometry.type === "Polygon" ? [r.geometry.coordinates] : r.geometry.type === "MultiPolygon" ? r.geometry.coordinates : [];
        for (const p of polys) for (const c of p[0]) b.extend(c as [number, number]);
      }
      if (!b.isEmpty()) m.fitBounds(b, { padding: 24, duration: 0 });
      const popup = new Popup({ closeButton: false, closeOnClick: false });
      m.on("mousemove", "fill", (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const node = document.createElement("div");
        node.style.cssText = "color:#04070A;font:12px var(--font-sans)";
        const title = document.createElement("strong");
        title.textContent = String(p.name);
        node.append(title, document.createElement("br"), `${String(p.label)} ${unit}`.trim());
        popup.setLngLat(e.lngLat).setDOMContent(node).addTo(m);
        m.getCanvas().style.cursor = "pointer";
      });
      m.on("mouseleave", "fill", () => { popup.remove(); m.getCanvas().style.cursor = ""; });
    });
    return () => m.remove();
  }, [regions, breaks, unit]);

  return (
    <div className="relative h-[420px] overflow-hidden rounded-2xl border border-white/5 bg-[#070C10]">
      <div className="absolute inset-0"><div ref={container} className="h-full w-full" aria-label="Карта регионов по выбранной метрике" /></div>
    </div>
  );
}
