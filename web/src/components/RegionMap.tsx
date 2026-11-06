"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { AttributionControl, LngLatBounds, Map as MapLibre, Popup } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { REGION_RAMP, regionClass } from "@/lib/choropleth";
import { MAP_ATTRIBUTION, MAP_STYLE, addSatellite } from "./mapStyle";
import { useI18n } from "@/components/I18nProvider";

export type RegionShape = { id: number; name: string; geometry: GeoJSON.Geometry; value: number; label: string };

/** Regions coloured by quantile class of one metric. */
export function RegionMap({ regions, breaks, unit }: { regions: RegionShape[]; breaks: number[]; unit: string }) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const m = new MapLibre({ container: container.current, style: MAP_STYLE, center: [67, 48.2], zoom: 3.4, attributionControl: false });
    m.addControl(new AttributionControl({ compact: true, customAttribution: MAP_ATTRIBUTION }), "bottom-right");
    m.on("load", () => {
      addSatellite(m, true);
      m.addSource("regions", { type: "geojson", data: { type: "FeatureCollection", features: regions.map((r) => ({
        type: "Feature" as const, id: r.id, geometry: r.geometry,
        properties: { name: r.name, label: r.label, c: REGION_RAMP[regionClass(r.value, breaks)] },
      })) } });
      // fades in after load; the hovered region lights up (feature-state, smooth transition)
      m.addLayer({ id: "fill", type: "fill", source: "regions", paint: {
        "fill-color": ["get", "c"], "fill-opacity": 0, "fill-opacity-transition": { duration: 900, delay: 150 } } });
      m.addLayer({ id: "line", type: "line", source: "regions", paint: {
        "line-color": ["case", ["boolean", ["feature-state", "hover"], false], "#EEF3F6", "rgba(4,7,10,.9)"],
        "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2, 1] } });
      requestAnimationFrame(() => m.setPaintProperty("fill", "fill-opacity",
        ["case", ["boolean", ["feature-state", "hover"], false], 0.88, 0.62]));
      const b = new LngLatBounds();
      for (const r of regions) {
        const polys = r.geometry.type === "Polygon" ? [r.geometry.coordinates] : r.geometry.type === "MultiPolygon" ? r.geometry.coordinates : [];
        for (const p of polys) for (const c of p[0]) b.extend(c as [number, number]);
      }
      if (!b.isEmpty()) m.fitBounds(b, { padding: 24, duration: 1200, essential: true });
      const popup = new Popup({ closeButton: false, closeOnClick: false });
      let hovered: string | number | undefined;
      const hover = (id: string | number | undefined) => {
        if (hovered !== undefined) m.setFeatureState({ source: "regions", id: hovered }, { hover: false });
        hovered = id;
        if (id !== undefined) m.setFeatureState({ source: "regions", id }, { hover: true });
      };
      m.on("mousemove", "fill", (e) => {
        const f = e.features?.[0];
        const p = f?.properties;
        if (!f || !p) return;
        if (f.id !== hovered) hover(f.id);
        const node = document.createElement("div");
        node.style.cssText = "color:#EEF3F6;font:12px/1.5 var(--font-sans)";
        const title = document.createElement("strong");
        title.textContent = String(p.name);
        node.append(title, document.createElement("br"), `${String(p.label)} ${unit}`.trim());
        popup.setLngLat(e.lngLat).setDOMContent(node).addTo(m);
        m.getCanvas().style.cursor = "pointer";
      });
      m.on("mouseleave", "fill", () => { hover(undefined); popup.remove(); m.getCanvas().style.cursor = ""; });
    });
    return () => m.remove();
  }, [regions, breaks, unit]);

  return (
    <div className="relative h-[420px] overflow-hidden rounded-2xl border border-white/5 bg-[#070C10]">
      <div className="absolute inset-0"><div ref={container} className="h-full w-full" aria-label={t("Карта регионов по выбранной метрике")} /></div>
    </div>
  );
}
