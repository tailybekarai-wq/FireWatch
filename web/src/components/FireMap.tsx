"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import {
  AttributionControl, Map as MapLibre, NavigationControl,
  type GeoJSONSource, type MapGeoJSONFeature, type MapLayerMouseEvent,
} from "maplibre-gl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Focus } from "@/lib/data";
import { CONFIDENCE, NO_SCORE, RISK, SATELLITES, coord, dateTime, dec, firmsMapUrl, satLabel } from "@/lib/format";
import { BasemapToggle } from "./BasemapToggle";
import { MAP_ATTRIBUTION, MAP_STYLE, addSatellite, pulse, setSatellite } from "./mapStyle";

const PERIODS = [{ d: 1, label: "24 часа" }, { d: 3, label: "3 дня" }, { d: 7, label: "7 дней" }, { d: 30, label: "30 дней" }];
const RISK_KEYS = ["very_high", "high", "moderate", "low", "none"] as const;
const RISK_ORDER: Record<string, number> = { very_high: 0, high: 1, moderate: 2, low: 3, none: 4 };
const FRESH_MS = 3 * 3600_000;
const LIST_LIMIT = 300;

type Props = { id: number; s: string; c: string; f: number | null; t: string; r: string | null; p: number | null; k: string; cl: number | null };
type Feature = GeoJSON.Feature<GeoJSON.Point, Props>;
type Selected = Props & { lon: number; lat: number; fresh: boolean };
type Meta = { count: number; truncated: boolean } | null;
type Mode = "ml" | "firms";

const riskColor = (k: string) => (k in RISK ? RISK[k].color : NO_SCORE.color);

function colorExpression(mode: Mode) {
  return mode === "ml"
    ? ["match", ["get", "k"], "very_high", RISK.very_high.color, "high", RISK.high.color, "moderate", RISK.moderate.color, "low", RISK.low.color, NO_SCORE.color]
    : ["match", ["get", "c"], "high", CONFIDENCE.high.color, "low", CONFIDENCE.low.color, CONFIDENCE.nominal.color];
}

/** GeoJSON-source properties come back serialised from the worker: nulls become "null". */
function readProps(raw: Record<string, unknown>): Props {
  const nul = <T,>(v: unknown) => (v == null || v === "null" ? null : (v as T));
  return {
    id: Number(raw.id), s: String(raw.s), c: String(raw.c), t: String(raw.t), k: String(raw.k ?? "none"),
    f: nul<number>(raw.f), r: nul<string>(raw.r), p: nul<number>(raw.p), cl: nul<number>(raw.cl),
  };
}

export function FireMap({ regions, model, focus }: { regions: { id: number; name: string }[]; model: string | null; focus: Focus | null }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const data = useRef<Feature[]>([]);
  const [ready, setReady] = useState(false);
  const [days, setDays] = useState(focus ? PERIODS.find((p) => p.d >= focus.days)?.d ?? focus.days : 1);
  const [sats, setSats] = useState<string[]>([]);
  const [conf, setConf] = useState<string[]>([]);
  const [risk, setRisk] = useState<string[]>([]);
  const [region, setRegion] = useState("");
  const [mode, setMode] = useState<Mode>(model ? "ml" : "firms");
  const [view, setView] = useState<"map" | "list">("map");
  const [listRows, setListRows] = useState<Feature[]>([]);
  const [result, setResult] = useState<{ key: string; status: "ok" | "error"; meta: Meta } | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [satellite, setSat] = useState(true);
  const key = `${days}|${sats.join(",")}|${conf.join(",")}|${risk.join(",")}|${region}`;
  const state = !result || result.key !== key ? "loading" : result.status;
  const meta = result?.key === key ? result.meta : null;

  const select = useCallback((p: Props, lon: number, lat: number) => {
    setSelected({ ...p, lon, lat, fresh: Date.now() - new Date(p.t).getTime() < FRESH_MS });
  }, []);

  /** Rows inside the current viewport, highest ML level first, then newest. */
  const refreshList = useCallback(() => {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds();
    const rows = data.current
      .filter((f) => b.contains(f.geometry.coordinates as [number, number]))
      .sort((a, z) => (RISK_ORDER[a.properties.k] ?? 4) - (RISK_ORDER[z.properties.k] ?? 4) || z.properties.t.localeCompare(a.properties.t));
    setListRows(rows.slice(0, LIST_LIMIT));
  }, []);

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new MapLibre({ container: container.current, style: MAP_STYLE, attributionControl: false, center: [67, 48.2], zoom: 3.6 });
    let stopPulse = () => {};
    m.addControl(new AttributionControl({ compact: true, customAttribution: MAP_ATTRIBUTION }), "bottom-right");
    m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    m.on("load", () => {
      addSatellite(m, true);
      m.addSource("det", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterRadius: 38, clusterMaxZoom: 9 });
      m.addLayer({ id: "clusters", type: "circle", source: "det", filter: ["has", "point_count"], paint: {
        "circle-color": "#36D6E7", "circle-opacity": 0.22, "circle-stroke-color": "#36D6E7", "circle-stroke-width": 1.2,
        "circle-radius": ["step", ["get", "point_count"], 14, 25, 18, 100, 24, 500, 30] } });
      m.addLayer({ id: "cluster-count", type: "symbol", source: "det", filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11, "text-font": ["Noto Sans Regular"] },
        paint: { "text-color": "#EEF3F6" } });
      m.addLayer({ id: "points", type: "circle", source: "det", filter: ["!", ["has", "point_count"]], paint: {
        "circle-color": colorExpression("firms") as never,
        "circle-radius": ["interpolate", ["linear"], ["ln", ["max", 1, ["coalesce", ["get", "f"], 1]]], 0, 3.5, 7, 11],
        "circle-stroke-color": "#04070A", "circle-stroke-width": 1.5, "circle-blur": 0.1 } });
      m.addSource("sel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "sel-ring", type: "circle", source: "sel", paint: { "circle-radius": 8, "circle-opacity": 0, "circle-stroke-color": "#EEF3F6", "circle-stroke-width": 2 } });
      stopPulse = pulse(m, "sel-ring", 9, 30);
      if (focus) m.flyTo({ center: [focus.lon, focus.lat], zoom: 11, duration: 2600, curve: 1.6, essential: true });
      m.on("click", "clusters", async (e: MapLayerMouseEvent) => {
        const f = e.features?.[0] as MapGeoJSONFeature | undefined;
        if (!f) return;
        const zoom = await (m.getSource("det") as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id as number);
        m.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom, duration: 900 });
      });
      m.on("click", "points", (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
        select(readProps(f.properties as Record<string, unknown>), lon, lat);
        m.easeTo({ center: [lon, lat], duration: 700 });
      });
      for (const layer of ["clusters", "points"]) {
        m.on("mouseenter", layer, () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", layer, () => { m.getCanvas().style.cursor = ""; });
      }
      m.on("moveend", refreshList);
      setReady(true);
    });
    map.current = m;
    return () => { stopPulse(); m.remove(); map.current = null; };
  }, [focus, refreshList, select]);

  useEffect(() => {
    if (ready && map.current) setSatellite(map.current, satellite);
  }, [ready, satellite]);

  // pulsing ring follows the selected detection
  useEffect(() => {
    if (!ready || !map.current) return;
    (map.current.getSource("sel") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: selected
      ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [selected.lon, selected.lat] } }] : [] });
  }, [ready, selected]);

  useEffect(() => {
    if (!map.current || !ready) return;
    map.current.setPaintProperty("points", "circle-color", colorExpression(mode) as never);
  }, [mode, ready]);

  useEffect(() => {
    if (!map.current || !ready) return;
    let cancelled = false;
    const [d, s, c, k, r] = key.split("|");
    const qs = new URLSearchParams({ days: d });
    if (s) qs.set("sat", s);
    if (c) qs.set("conf", c);
    if (k) qs.set("risk", k.replace("none", "unscored"));
    if (r) qs.set("region", r);
    fetch(`/api/detections?${qs}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const json = await res.json();
        if (cancelled || !map.current) return;
        data.current = json.features;
        (map.current.getSource("det") as GeoJSONSource).setData(json);
        setResult({ key, status: "ok", meta: json.meta });
        refreshList();
        const hit = focus && data.current.find((f) => f.properties.id === focus.id);
        if (hit) select(hit.properties, focus.lon, focus.lat);
      })
      .catch(() => { if (!cancelled) setResult({ key, status: "error", meta: null }); });
    return () => { cancelled = true; };
  }, [key, ready, refreshList, focus, select]);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const reset = () => { setDays(1); setSats([]); setConf([]); setRisk([]); setRegion(""); };
  const flyTo = (f: Feature) => {
    const [lon, lat] = f.geometry.coordinates;
    map.current?.flyTo({ center: [lon, lat], zoom: Math.max(map.current.getZoom(), 10), duration: 1400, essential: true });
    select(f.properties, lon, lat);
  };

  return (
    <div className="relative h-[calc(100vh-150px)] min-h-[560px] overflow-hidden rounded-[28px] border border-white/5 bg-[#070C10]">
      {/* .maplibregl-map sets position:relative, so positioning lives on a wrapper */}
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" aria-label="Карта спутниковых обнаружений" />
      </div>
      <BasemapToggle satellite={satellite} onChange={setSat} className="absolute bottom-4 left-1/2 -translate-x-1/2" />

      <aside aria-label="Фильтры карты" className="glass rise absolute left-4 top-4 flex max-h-[calc(100%-32px)] w-[300px] max-w-[calc(100%-32px)] flex-col gap-4 overflow-y-auto rounded-[22px] p-[18px]">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-[17px] font-semibold tracking-tight">Фильтры</h2>
          <button type="button" onClick={reset} className="btn h-[30px] px-2.5 text-xs">Сбросить</button>
        </div>
        <div role="group" aria-label="Режим просмотра" className="grid grid-cols-2 gap-1.5 rounded-[13px] bg-white/[.03] p-1">
          {(["map", "list"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => { setView(v); refreshList(); }}
              className="h-8 rounded-[10px] text-xs font-medium"
              style={{ background: view === v ? "rgba(255,255,255,.10)" : "transparent", color: view === v ? "#EEF3F6" : "#9DAAB5" }}>
              {v === "map" ? "Карта" : "Список"}
            </button>
          ))}
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
        {!PERIODS.some((p) => p.d === days) && <span className="text-xs text-fg2">Период: {days} дн — чтобы показать выбранное обнаружение</span>}
        <label className="flex flex-col gap-1.5 text-xs text-fg2">Цвет точек
          <select className="field" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="ml" disabled={!model}>ML-оценка{model ? ` (модель ${model})` : " — модель не активна"}</option>
            <option value="firms">Достоверность FIRMS</option>
          </select>
        </label>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="pb-2 text-xs text-fg2">ML-риск</legend>
          <div className="flex flex-wrap gap-1.5">
            {RISK_KEYS.map((k) => (
              <button key={k} type="button" className="chip" aria-pressed={risk.includes(k)} onClick={() => toggle(risk, k, setRisk)}>
                <span className="dot" style={{ background: riskColor(k) }} />{k === "none" ? NO_SCORE.label : RISK[k].label}
              </button>
            ))}
          </div>
        </fieldset>
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
          {mode === "ml"
            ? "Цвет — уровень ML-оценки: вероятность связи с гарью, не подтверждение пожара. Серые — без оценки (MODIS или старше 7 дней)."
            : "Цвет — достоверность обнаружения FIRMS."} Размер — мощность излучения (FRP).
        </p>
      </aside>

      {view === "list" && (
        <section aria-label="Обнаружения в видимой области" className="glass2 rise absolute bottom-4 right-4 top-4 flex w-[400px] max-w-[calc(100%-32px)] flex-col gap-3 rounded-[22px] p-[18px]">
          <div className="flex items-baseline justify-between">
            <h2 className="m-0 text-[17px] font-semibold tracking-tight">В видимой области</h2>
            <span className="mono text-xs text-fg2">{listRows.length.toLocaleString("ru-RU")}{listRows.length >= LIST_LIMIT ? "+" : ""}</span>
          </div>
          <span className="text-[11px] text-muted">Сначала самый высокий ML-риск, затем новые. Двигайте карту — список обновится.</span>
          <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
            {listRows.length ? (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {listRows.map((f) => (
                  <li key={f.properties.id}>
                    <button type="button" onClick={() => flyTo(f)}
                      className="row grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl px-2 py-2 text-left text-xs">
                      <span className="dot" style={{ background: mode === "ml" ? riskColor(f.properties.k) : CONFIDENCE[f.properties.c]?.color }} />
                      <span className="flex min-w-0 flex-col">
                        <span className="mono truncate text-fg">{coord(f.geometry.coordinates[1], f.geometry.coordinates[0])}</span>
                        <span className="truncate text-muted">{dateTime(f.properties.t)} · {f.properties.r ?? "—"}</span>
                      </span>
                      <span className="mono text-fg2">{f.properties.p != null ? `${Math.round(f.properties.p * 100)}%` : "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 px-2 text-xs text-muted">В видимой области обнаружений нет.</p>
            )}
          </div>
        </section>
      )}

      {selected && (
        <aside aria-label="Детали обнаружения" className="glass2 rise absolute right-4 top-4 z-10 flex w-[340px] max-w-[calc(100%-32px)] flex-col gap-3.5 rounded-[22px] p-[18px]">
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex flex-col gap-1.5">
              <span className="flex flex-wrap items-center gap-2 text-xs font-semibold text-signal">
                Спутниковое обнаружение
                {selected.fresh && <span className="rounded-full bg-[#FF7A3D1f] px-2 py-0.5 text-[11px] text-[#FF9A6B]">&lt; 3 ч</span>}
              </span>
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
            {selected.p != null && selected.k in RISK ? (
              <span className="flex flex-wrap items-baseline gap-2.5">
                <span className="mono text-2xl">{Math.round(selected.p * 100)}%</span>
                <span className="text-xs" style={{ color: RISK[selected.k].color }}>{RISK[selected.k].label}</span>
                <span className="text-[11px] text-muted">не подтверждение пожара</span>
              </span>
            ) : (
              <span className="text-xs leading-relaxed text-fg2">Нет оценки: модель оценивает VIIRS за последние 7 дней.</span>
            )}
          </div>
          {selected.cl != null && (
            <Link href={`/hotspots/${selected.cl}`} className="flex items-center justify-between rounded-2xl border border-white/5 px-3.5 py-2.5 text-xs text-fg no-underline hover:bg-white/5">
              <span>Часть потенциального очага <span className="mono">#{selected.cl}</span></span><span>→</span>
            </Link>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Link href={`/detections/${selected.id}`} className="btn btn-primary">Открыть запись</Link>
            <a href={firmsMapUrl(selected.lat, selected.lon, selected.t)} target="_blank" rel="noreferrer" className="btn">FIRMS ↗</a>
          </div>
        </aside>
      )}
    </div>
  );
}
