"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import {
  AttributionControl, Map as MapLibre, NavigationControl, setWorkerUrl,
  type GeoJSONSource, type MapGeoJSONFeature, type MapLayerMouseEvent,
} from "maplibre-gl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CONFIDENCE, SATELLITES, coord, dateTime, dec, satLabel } from "@/lib/format";

const STYLE = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/dark";
const ATTRIBUTION = '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · © участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · NASA FIRMS';
// Copied from the installed package by scripts/copy-maplibre-worker.mjs (predev/prebuild).
setWorkerUrl("/maplibre-gl-worker.mjs");
const PERIODS = [{ d: 1, label: "24 часа" }, { d: 3, label: "3 дня" }, { d: 7, label: "7 дней" }, { d: 30, label: "30 дней" }];

type Props = { id: number; s: string; c: string; f: number | null; t: string; r: string | null };
type Selected = Props & { lon: number; lat: number };
type Meta = { count: number; truncated: boolean } | null;

export function FireMap({ regions }: { regions: { id: number; name: string }[] }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const [days, setDays] = useState(1);
  const [sats, setSats] = useState<string[]>([]);
  const [conf, setConf] = useState<string[]>([]);
  const [region, setRegion] = useState("");
  const [result, setResult] = useState<{ key: string; status: "ok" | "error"; meta: Meta } | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const key = `${days}|${sats.join(",")}|${conf.join(",")}|${region}`;
  const state = !result || result.key !== key ? "loading" : result.status;
  const meta = result?.key === key ? result.meta : null;

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new MapLibre({
      container: container.current, style: STYLE, center: [67, 48.2], zoom: 3.6, attributionControl: false,
    });
    m.addControl(new AttributionControl({ compact: true, customAttribution: ATTRIBUTION }), "bottom-right");
    m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    m.on("load", () => {
      m.addSource("det", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterRadius: 38, clusterMaxZoom: 9 });
      m.addLayer({ id: "clusters", type: "circle", source: "det", filter: ["has", "point_count"], paint: {
        "circle-color": "#36D6E7", "circle-opacity": 0.22, "circle-stroke-color": "#36D6E7", "circle-stroke-width": 1.2,
        "circle-radius": ["step", ["get", "point_count"], 14, 25, 18, 100, 24, 500, 30] } });
      m.addLayer({ id: "cluster-count", type: "symbol", source: "det", filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11, "text-font": ["Noto Sans Regular"] },
        paint: { "text-color": "#EEF3F6" } });
      m.addLayer({ id: "points", type: "circle", source: "det", filter: ["!", ["has", "point_count"]], paint: {
        "circle-color": ["match", ["get", "c"], "high", CONFIDENCE.high.color, "low", CONFIDENCE.low.color, CONFIDENCE.nominal.color],
        "circle-radius": ["interpolate", ["linear"], ["ln", ["max", 1, ["coalesce", ["get", "f"], 1]]], 0, 3.5, 7, 11],
        "circle-stroke-color": "#04070A", "circle-stroke-width": 1.5, "circle-blur": 0.1 } });
      m.on("click", "clusters", async (e: MapLayerMouseEvent) => {
        const f = e.features?.[0] as MapGeoJSONFeature | undefined;
        if (!f) return;
        const zoom = await (m.getSource("det") as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id as number);
        m.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
      });
      m.on("click", "points", (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
        setSelected({ ...(f.properties as unknown as Props), lon, lat });
      });
      for (const layer of ["clusters", "points"]) {
        m.on("mouseenter", layer, () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", layer, () => { m.getCanvas().style.cursor = ""; });
      }
      setReady(true);
    });
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!map.current || !ready) return;
    let cancelled = false;
    const [d, s, c, r] = key.split("|");
    const qs = new URLSearchParams({ days: d });
    if (s) qs.set("sat", s);
    if (c) qs.set("conf", c);
    if (r) qs.set("region", r);
    fetch(`/api/detections?${qs}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const json = await res.json();
        if (cancelled || !map.current) return;
        (map.current.getSource("det") as GeoJSONSource).setData(json);
        setResult({ key, status: "ok", meta: json.meta });
      })
      .catch(() => { if (!cancelled) setResult({ key, status: "error", meta: null }); });
    return () => { cancelled = true; };
  }, [key, ready]);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const reset = () => { setDays(1); setSats([]); setConf([]); setRegion(""); };

  return (
    <div className="relative h-[calc(100vh-150px)] min-h-[560px] overflow-hidden rounded-[28px] border border-white/5 bg-[#070C10]">
      {/* .maplibregl-map sets position:relative, so positioning lives on a wrapper */}
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" aria-label="Карта спутниковых обнаружений" />
      </div>

      <aside aria-label="Фильтры карты" className="glass rise absolute left-4 top-4 flex max-h-[calc(100%-32px)] w-[300px] max-w-[calc(100%-32px)] flex-col gap-4 overflow-y-auto rounded-[22px] p-[18px]">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-[17px] font-semibold tracking-tight">Фильтры</h2>
          <button type="button" onClick={reset} className="btn h-[30px] px-2.5 text-xs">Сбросить</button>
        </div>
        <div role="group" aria-label="Период" className="grid grid-cols-2 gap-1.5">
          {PERIODS.map((p) => (
            <button key={p.d} type="button" aria-pressed={days === p.d} onClick={() => setDays(p.d)}
              className="h-[38px] rounded-[11px] border text-xs font-medium"
              style={{ borderColor: days === p.d ? "rgba(59,227,138,.45)" : "rgba(255,255,255,.07)",
                background: days === p.d ? "rgba(59,227,138,.14)" : "rgba(255,255,255,.03)", color: days === p.d ? "#EEF3F6" : "#9DAAB5" }}>
              {p.label}
            </button>
          ))}
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="pb-2 text-xs text-fg2">Достоверность FIRMS</legend>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(CONFIDENCE).map(([k, c]) => (
              <button key={k} type="button" className="chip" aria-pressed={conf.includes(k)} onClick={() => toggle(conf, k, setConf)}>
                <span className="dot" style={{ background: c.color }} />{c.label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="pb-2 text-xs text-fg2">Спутник</legend>
          <div className="flex flex-wrap gap-1.5">
            {["N20", "N21", "Terra", "Aqua"].map((s) => (
              <button key={s} type="button" className="chip" aria-pressed={sats.includes(s)} onClick={() => toggle(sats, s, setSats)}>
                <span className="dot" style={{ background: SATELLITES[s].color }} />{SATELLITES[s].label}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1.5 text-xs text-fg2">Регион
          <select className="field" value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">Весь Казахстан</option>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <div className="flex justify-between border-t border-white/5 pt-3 text-xs text-fg2" aria-live="polite">
          {state === "loading" && <span>Загрузка…</span>}
          {state === "error" && <span className="text-[#FF4D5E]">Не удалось загрузить данные</span>}
          {state === "ok" && meta && (
            <>Найдено<span className="mono text-fg">{meta.count.toLocaleString("ru-RU")}{meta.truncated ? "+" : ""}</span></>
          )}
        </div>
        {state === "ok" && meta?.count === 0 && (
          <p className="m-0 text-xs leading-relaxed text-muted">Нет обнаружений по этим условиям. Попробуйте период 7 дней.</p>
        )}
        {meta?.truncated && <p className="m-0 text-xs text-muted">Показаны последние 20 000 точек — уточните фильтры.</p>}
        <p className="m-0 text-[11px] leading-relaxed text-muted">
          Цвет — достоверность обнаружения FIRMS, размер — мощность излучения (FRP). ML-оценка не активна.
        </p>
      </aside>

      {selected && (
        <aside aria-label="Детали обнаружения" className="glass2 rise absolute right-4 top-4 flex w-[340px] max-w-[calc(100%-32px)] flex-col gap-3.5 rounded-[22px] p-[18px]">
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-signal">Спутниковое обнаружение</span>
              <h2 className="mono m-0 text-lg font-medium">{coord(selected.lat, selected.lon)}</h2>
              <span className="mono text-[11px] text-muted">#{selected.id}{selected.r ? ` · ${selected.r}` : ""}</span>
            </div>
            <button type="button" aria-label="Закрыть" onClick={() => setSelected(null)} className="btn size-9 p-0">✕</button>
          </div>
          <div className="observation flex flex-col gap-3 rounded-2xl p-3.5">
            <span className="mono text-[10px] tracking-[.14em] text-signal">НАБЛЮДЕНИЕ СПУТНИКА</span>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <span className="flex flex-col gap-0.5"><span className="text-muted">Спутник</span>{satLabel(selected.s)}</span>
              <span className="flex flex-col gap-0.5"><span className="text-muted">FRP</span><span className="mono">{dec(selected.f)} МВт</span></span>
              <span className="flex flex-col gap-0.5"><span className="text-muted">Наблюдение</span><span className="mono">{dateTime(selected.t)}</span></span>
              <span className="flex flex-col gap-0.5"><span className="text-muted">Достоверность</span>{CONFIDENCE[selected.c]?.label ?? selected.c}</span>
            </div>
          </div>
          <div className="estimate flex flex-col gap-1.5 rounded-2xl p-3.5">
            <span className="mono text-[10px] tracking-[.14em] text-[#FF9A6B]">ML-ОЦЕНКА</span>
            <span className="text-xs leading-relaxed text-fg2">Модель не активна. Оценка появится после обучения и проверки (этап 6).</span>
          </div>
          <Link href={`/detections/${selected.id}`} className="btn btn-primary">Открыть запись</Link>
        </aside>
      )}
    </div>
  );
}
