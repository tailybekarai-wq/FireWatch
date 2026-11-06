import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { SpotMap } from "@/components/SpotMap";
import { Panel, Skeleton, StateBox } from "@/components/ui";
import { getDetection, getHistory, getNeighbours, getPrediction } from "@/lib/data";
import {
  CONFIDENCE, FEATURE_LABELS, NO_SCORE, RISK, coord, dateTime, dec, firmsMapUrl, kmhToMs, num, satLabel, windDir,
} from "@/lib/format";

const FIRE_TYPE: Record<number, string> = { 0: "растительный пожар (предположительно)", 1: "вулкан", 2: "статичный источник", 3: "на шельфе" };
const TRACKED: Record<string, string> = {
  product_version: "версия продукта", processing_level: "уровень обработки", frp_mw: "FRP", confidence_raw: "достоверность",
  confidence_level: "уровень достоверности", bright_main_k: "TI4 / яркость", bright_aux_k: "TI5", scan_km: "scan", track_km: "track",
};

export default function DetectionPage({ params }: PageProps<"/detections/[id]">) {
  return (
    <Suspense fallback={<Skeleton h={640} />}>
      <Detail params={params} />
    </Suspense>
  );
}

function Pill({ color, children, pulse = false }: { color: string; children: ReactNode; pulse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium" style={{ color, background: `${color}1c` }}>
      <span className={`dot size-1.5 ${pulse ? "pulse" : ""}`} style={{ background: color }} />{children}
    </span>
  );
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] text-muted">{k}</dt>
      <dd className="mono m-0 break-words text-[13px]">{children}</dd>
    </div>
  );
}

async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  let d, prediction, history, neighbours;
  try {
    [d, prediction, history, neighbours] = await Promise.all([getDetection(id), getPrediction(id), getHistory(id), getNeighbours(id, 2000)]);
  } catch {
    return <StateBox tone="error" title="Не удалось загрузить запись">База данных недоступна. Значения не подставляются.</StateBox>;
  }
  if (!d) notFound();
  const w = d.weather;
  const risk = prediction ? RISK[prediction.risk_level] : null;
  const markColor = risk?.color ?? CONFIDENCE[d.confidence_level]?.color ?? "#36D6E7";
  // doy_sin and doy_cos share one plain-language label: show it once
  const drivers = (prediction?.top_contributions ?? []).filter((c, i, all) =>
    all.findIndex((o) => FEATURE_LABELS[o.feature] === FEATURE_LABELS[c.feature]) === i);
  const ms = kmhToMs(w?.wind_speed_10m_kmh);

  return (
    <>
      <div className="rise flex flex-wrap items-end justify-between gap-5">
        <div className="flex flex-col gap-2.5">
          <Link href="/detections" className="text-[13px] text-fg2 no-underline">← Все обнаружения</Link>
          <span className="flex flex-wrap items-center gap-2.5">
            {risk ? <Pill color={risk.color}>{risk.label} · ML-оценка</Pill> : <Pill color={NO_SCORE.color}>{NO_SCORE.label}</Pill>}
            {d.fresh && <Pill color="#FF7A3D" pulse>Наблюдение &lt; 3 ч назад</Pill>}
            <span className="mono rounded-full bg-white/5 px-3 py-1 text-xs text-fg2">{d.processing_level} · v{d.product_version}</span>
          </span>
          <h1 className="mono m-0 text-3xl font-medium tracking-[-0.04em] md:text-[44px] md:leading-none">{coord(d.latitude, d.longitude)}</h1>
          <span className="text-sm text-fg2">
            Обнаружение <span className="mono text-fg">#{d.id}</span>{d.region_name ? ` · ${d.region_name}` : ""} · наблюдение{" "}
            <span className="mono text-fg">{dateTime(d.observed_at)}</span> (UTC+5)
          </span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Link href={`/map?focus=${d.id}`} className="btn btn-primary">На карте</Link>
          <a href={firmsMapUrl(d.latitude, d.longitude, d.observed_at)} target="_blank" rel="noreferrer" className="btn">FIRMS Fire Map ↗</a>
          <a href={`/api/export?id=${d.id}`} className="btn">Экспорт CSV</a>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
        <section aria-label="Карта местности" className="rise flex min-w-0 flex-col gap-2" style={{ animationDelay: ".06s" }}>
          <SpotMap label="Карта местности вокруг обнаружения" center={{ lat: d.latitude, lon: d.longitude }} radiusKm={2} focusColor={markColor}
            points={neighbours.map((n) => ({ id: n.id, lat: n.latitude, lon: n.longitude, t: "", href: `/detections/${n.id}`,
              color: n.risk_level ? RISK[n.risk_level]?.color ?? NO_SCORE.color : "#36D6E7" }))} />
          <span className="text-[11px] text-muted">
            Пунктир — окрестность 2 км · точки — соседние обнаружения за ±48 ч · пиксель {dec(d.scan_km, 2)} × {dec(d.track_km, 2)} км
          </span>
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          <section aria-label="Спутниковое наблюдение" className="observation rise flex flex-col gap-3 rounded-3xl p-5">
            <span className="mono flex justify-between text-[11px] tracking-[.14em] text-signal">
              ОФИЦИАЛЬНОЕ НАБЛЮДЕНИЕ<span className="tracking-normal text-muted">NASA FIRMS</span>
            </span>
            <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
              <Fact k="Время (UTC)">{dateTime(d.observed_at, true)}</Fact>
              <Fact k="Спутник">{satLabel(d.satellite)}</Fact>
              <Fact k="FRP">{dec(d.frp_mw)} МВт</Fact>
              <Fact k="Достоверность">{CONFIDENCE[d.confidence_level]?.label ?? d.confidence_level} ({d.confidence_raw})</Fact>
              <Fact k="Яркость TI4 / TI5">{dec(d.bright_main_k)} / {dec(d.bright_aux_k)} K</Fact>
              <Fact k="Пиксель">{dec(d.scan_km, 2)} × {dec(d.track_km, 2)} км</Fact>
              <Fact k="День / ночь">{d.daynight === "D" ? "день" : "ночь"}</Fact>
              <Fact k="Регион">{d.region_name ?? "—"}</Fact>
              {d.fire_type != null && <Fact k="Тип (архив SP)">{FIRE_TYPE[d.fire_type] ?? d.fire_type}</Fact>}
              <Fact k="Соседи (5 км, ±48 ч)">{num(d.neighbors)}</Fact>
            </dl>
          </section>

          <section aria-label="ML-оценка" className="estimate rise flex flex-col gap-3 rounded-3xl p-5" style={{ animationDelay: ".08s" }}>
            <span className="mono flex justify-between text-[11px] tracking-[.14em] text-[#FF9A6B]">
              ML-ОЦЕНКА<span className="tracking-normal text-muted">{prediction ? `модель ${prediction.version}` : "нет оценки"}</span>
            </span>
            {prediction && risk ? (
              <>
                <span className="flex items-baseline gap-3">
                  <span className="mono text-4xl font-medium tracking-[-0.04em]">{Math.round(prediction.probability * 100)}%</span>
                  <span className="text-[13px] text-fg2">вероятность → <span style={{ color: risk.color }}>{risk.label}</span></span>
                </span>
                {drivers.length > 0 && (
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
                    {drivers.slice(0, 4).map((c) => (
                      <li key={c.feature} className="flex items-center justify-between gap-3">
                        <span className="text-fg2">{c.contribution > 0 ? "↑ повышает" : "↓ понижает"}: <span className="text-fg">{FEATURE_LABELS[c.feature] ?? c.feature}</span></span>
                        <span className="mono text-xs text-muted">{dec(c.value, Number.isInteger(c.value) ? 0 : 2)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <span className="text-xs leading-relaxed text-fg2">
                  Вероятность связи обнаружения с картируемой гарью растительности. Аналитическая оценка, не подтверждение пожара.{" "}
                  <Link href="/ml" className="no-underline">Как это работает →</Link>
                </span>
              </>
            ) : (
              <span className="text-[13px] leading-relaxed text-fg2">
                {d.instrument === "MODIS"
                  ? "MODIS не оценивается: модель обучена на данных VIIRS."
                  : "Оценки для этой записи нет: модель оценивает обнаружения VIIRS за последние 7 дней после её включения."}
              </span>
            )}
          </section>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title="История записи" sub="Изменения значений при переобработке (URT → NRT и т. п.)">
          {history.length ? (
            <ul className="m-0 flex list-none flex-col gap-3 p-0 text-[13px]">
              {history.map((h) => (
                <li key={h.changed_at} className="flex flex-col gap-1">
                  <span className="mono text-xs text-muted">{dateTime(h.changed_at)}</span>
                  {Object.entries(h.changes).map(([k, [from, to]]) => (
                    <span key={k}>{TRACKED[k] ?? k}: <span className="mono text-muted line-through">{String(from)}</span> → <span className="mono">{String(to)}</span></span>
                  ))}
                </li>
              ))}
            </ul>
          ) : (
            <StateBox title="Изменений не было">Значения записи не менялись с первой загрузки {dateTime(d.ingested_at)}.</StateBox>
          )}
          <span className="text-[11px] text-muted">Источник: {d.source_name} · получено в запуске #{d.run_id}</span>
        </Panel>

        <Panel title="Погода в момент наблюдения" sub="Open-Meteo · ячейка 0,25° · фактор опасности, а не признак пожара" delay={0.05}>
          {w ? (
            <dl className="m-0 grid grid-cols-2 gap-4">
              <Fact k="Температура">{dec(w.temperature_2m_c)} °C</Fact>
              <Fact k="Влажность">{dec(w.relative_humidity_2m_pct, 0)} %</Fact>
              <Fact k="Ветер">{ms == null ? "—" : `${dec(ms)} м/с · ${windDir(w.wind_direction_10m_deg)}`}</Fact>
              <Fact k="Осадки за час">{dec(w.precipitation_mm)} мм</Fact>
              <Fact k="VPD">{dec(w.vpd_kpa, 2)} кПа</Fact>
              <Fact k="Модель">{w.model}</Fact>
            </dl>
          ) : (
            <StateBox title="Погода не загружена">
              Для истории погода не загружается (лимит Open-Meteo); для свежих записей она появляется после ближайшего сбора.
            </StateBox>
          )}
        </Panel>

        <Panel title={`Соседи · 2 км · ${neighbours.length}`} sub="Обнаружения за ±48 ч, ближайшие по времени" delay={0.1}>
          {neighbours.length ? (
            <ul className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0 text-[13px]">
              {neighbours.map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-3 rounded-xl px-2 py-1.5 hover:bg-white/5">
                  <Link href={`/detections/${n.id}`} className="flex items-center gap-2 text-fg no-underline">
                    <span className="dot" style={{ background: n.risk_level ? RISK[n.risk_level]?.color : "#36D6E7" }} />
                    <span className="mono">{dec(n.dist_km, 2)} км</span>
                    <span className="mono text-muted">Δt {n.dt_min > 0 ? "+" : ""}{num(n.dt_min)} мин</span>
                  </Link>
                  {n.cluster_id && <Link href={`/hotspots/${n.cluster_id}`} className="mono text-xs no-underline">очаг #{n.cluster_id} →</Link>}
                </li>
              ))}
            </ul>
          ) : (
            <StateBox title="Соседей нет">В радиусе 2 км за ±48 часов других обнаружений нет.</StateBox>
          )}
          {d.cluster_id && <Link href={`/hotspots/${d.cluster_id}`} className="btn self-start">Потенциальный очаг #{d.cluster_id} →</Link>}
        </Panel>
      </div>
    </>
  );
}
