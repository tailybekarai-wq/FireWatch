import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AssessmentBadge } from "@/components/DetectionTable";
import { Panel, Skeleton, StateBox } from "@/components/ui";
import { getDetection } from "@/lib/data";
import { coord, dateTime, dec, num, satLabel } from "@/lib/format";

const FIRE_TYPE: Record<number, string> = { 0: "растительный пожар (предположительно)", 1: "вулкан", 2: "статичный источник", 3: "на шельфе" };

export default function DetectionPage({ params }: PageProps<"/detections/[id]">) {
  return (
    <Suspense fallback={<Skeleton h={520} />}>
      <Detail params={params} />
    </Suspense>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <span className="flex flex-col gap-1 text-[13px]"><span className="text-xs text-muted">{label}</span>{children}</span>;
}

async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  let d;
  try { d = await getDetection(id); } catch {
    return <StateBox tone="error" title="Не удалось загрузить запись">База данных недоступна.</StateBox>;
  }
  if (!d) notFound();
  const w = d.weather;
  return (
    <>
      <div className="rise flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <span className="eyebrow text-signal">Спутниковое обнаружение #{d.id}</span>
          <h1 className="mono m-0 text-3xl font-medium tracking-tight md:text-4xl">{coord(d.latitude, d.longitude)}</h1>
          <span className="text-sm text-fg2">Термическая аномалия, обнаруженная спутником. Не является подтверждённым пожаром.</span>
        </div>
        <div className="flex gap-2"><AssessmentBadge row={d} /><Link href="/map" className="btn">На карте</Link></div>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Наблюдение" sub="Как в источнике NASA FIRMS">
          <div className="observation grid grid-cols-2 gap-4 rounded-2xl p-4 md:grid-cols-3">
            <Field label="Время (UTC+5)"><span className="mono">{dateTime(d.observed_at)}</span></Field>
            <Field label="Время (UTC)"><span className="mono">{dateTime(d.observed_at, true)}</span></Field>
            <Field label="Спутник">{satLabel(d.satellite)}</Field>
            <Field label="FRP"><span className="mono">{dec(d.frp_mw)} МВт</span></Field>
            <Field label="Яркостная температура"><span className="mono">{dec(d.bright_main_k)} / {dec(d.bright_aux_k)} K</span></Field>
            <Field label="Размер пикселя"><span className="mono">{dec(d.scan_km, 2)} × {dec(d.track_km, 2)} км</span></Field>
            <Field label="Достоверность">{d.confidence_level} <span className="mono text-muted">({d.confidence_raw})</span></Field>
            <Field label="День / ночь">{d.daynight === "D" ? "день" : "ночь"}</Field>
            <Field label="Регион">{d.region_name ?? "—"}</Field>
            {d.fire_type != null && <Field label="Тип (архив SP)">{FIRE_TYPE[d.fire_type] ?? d.fire_type}</Field>}
            <Field label="Соседние обнаружения">{num(d.neighbors)} в радиусе 5 км, ±48 ч</Field>
          </div>
        </Panel>
        <Panel title="ML-оценка" sub="Аналитическая оценка, не подтверждение пожара" delay={0.05}>
          <div className="estimate flex flex-col gap-2 rounded-2xl p-4 text-[13px] text-fg2">
            {d.probability != null ? (
              <><span className="mono text-3xl text-fg">{Math.round(d.probability * 100)}%</span>
                <span>Модель {d.model_name} {d.model_version}</span></>
            ) : (
              <span>Модель не активна. Оценка появится после обучения и проверки на реальных данных (этап 6).</span>
            )}
          </div>
        </Panel>
        <Panel title="Погода в момент наблюдения" sub="Фактор пожарной опасности, а не признак пожара" delay={0.1}>
          {w ? (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Field label="Температура"><span className="mono">{dec(w.temperature_2m_c)} °C</span></Field>
              <Field label="Влажность"><span className="mono">{dec(w.relative_humidity_2m_pct, 0)} %</span></Field>
              <Field label="Ветер"><span className="mono">{dec(w.wind_speed_10m_kmh)} км/ч · {dec(w.wind_direction_10m_deg, 0)}°</span></Field>
              <Field label="Осадки"><span className="mono">{dec(w.precipitation_mm)} мм</span></Field>
              <Field label="VPD"><span className="mono">{dec(w.vpd_kpa, 2)} кПа</span></Field>
              <Field label="Источник">{w.source} · ячейка 0,25° · {w.model}</Field>
            </div>
          ) : (
            <StateBox title="Погода не загружена">Для этой записи погоды нет: для истории она не загружается (лимиты Open-Meteo), для свежих — появится после следующего сбора.</StateBox>
          )}
        </Panel>
        <Panel title="Происхождение данных" delay={0.15}>
          <div className="grid gap-3 text-[13px]">
            <Field label="Источник"><a href={d.source_url} target="_blank" rel="noreferrer">{d.source_name} ↗</a></Field>
            <Field label="Продукт и версия"><span className="mono">{d.processing_level} · {d.product_version}</span></Field>
            <Field label="Получено системой"><span className="mono">{dateTime(d.ingested_at)} · запуск #{d.run_id}</span></Field>
            <Field label="Запрос"><span className="mono break-all text-xs text-fg2">{d.request_url_redacted}</span></Field>
            <Field label="SHA-256 ответа"><span className="mono break-all text-xs text-fg2">{d.body_sha256 ?? "—"}</span></Field>
            {d.docs_url && <Field label="Документация"><a href={d.docs_url} target="_blank" rel="noreferrer">{d.docs_url}</a></Field>}
          </div>
        </Panel>
      </div>
    </>
  );
}
