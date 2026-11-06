import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { AreaChart } from "@/components/charts";
import { AssessmentBadge } from "@/components/DetectionTable";
import { SpotMap } from "@/components/SpotMap";
import { Kpi, Panel, Skeleton, StateBox } from "@/components/ui";
import { getHotspot, getHotspotDetections, getHotspotHourly } from "@/lib/data";
import { CONFIDENCE, NO_SCORE, RISK, coord, dateTime, dec, kmhToMs, num, satLabel, timeOnly, windDir } from "@/lib/format";

export const metadata: Metadata = { title: "Потенциальный очаг" };

export default function HotspotPage({ params }: PageProps<"/hotspots/[id]">) {
  return (
    <Suspense fallback={<Skeleton h={640} />}>
      <Body params={params} />
    </Suspense>
  );
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] text-muted">{k}</dt>
      <dd className="m-0 text-[13px]">{children}</dd>
    </div>
  );
}

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  let h, members, hourly;
  try {
    [h, members, hourly] = await Promise.all([getHotspot(id), getHotspotDetections(id), getHotspotHourly(id)]);
  } catch {
    return <StateBox tone="error" title="Не удалось загрузить очаг">База данных недоступна. Значения не подставляются.</StateBox>;
  }
  if (!h) notFound();
  const w = h.weather;
  const ms = kmhToMs(w?.wind_speed_10m_kmh);
  const risk = h.max_risk ? RISK[h.max_risk] : null;
  const active = h.status === "active";
  const latest = members.at(-1);

  return (
    <>
      <div className="rise flex flex-wrap items-end justify-between gap-5">
        <div className="flex max-w-3xl flex-col gap-2.5">
          <Link href="/map" className="text-[13px] text-fg2 no-underline">← Карта пожаров</Link>
          <span className="flex flex-wrap items-center gap-2.5 text-xs">
            <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 font-medium"
              style={{ color: active ? "#FF9A6B" : "#9DAAB5", background: active ? "rgba(255,122,61,.12)" : "rgba(255,255,255,.05)" }}>
              <span className="dot size-1.5" style={{ background: active ? "#FF7A3D" : "#7F8D99" }} />
              {active ? "Активен · обнаружения за последние 24 ч" : "Неактивен · нет новых обнаружений 24 ч"}
            </span>
            <span className="mono rounded-full bg-white/5 px-3 py-1 text-fg2">очаг #{h.id}</span>
          </span>
          <h1 className="m-0 text-3xl font-semibold leading-tight tracking-[-0.035em] md:text-[40px]">
            {num(h.detection_count)} обнаружений рядом{h.region_name ? ` · ${h.region_name}` : ""}
          </h1>
          <span className="text-sm leading-relaxed text-fg2">
            Потенциальный очаг — группа спутниковых обнаружений на расстоянии до ~750 м друг от друга в пределах 72 часов.
            Это не подтверждённый пожар и не его площадь.
          </span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {latest && <Link href={`/map?focus=${latest.id}`} className="btn btn-primary">На карте</Link>}
          <a href={`/api/export?cluster=${h.id}`} className="btn">Экспорт CSV</a>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Первое обнаружение" value={timeOnly(h.first_observed_at)} hint={dateTime(h.first_observed_at)} />
        <Kpi label="Последнее обнаружение" value={timeOnly(h.last_observed_at)} hint={dateTime(h.last_observed_at)} />
        <Kpi label="Суммарная FRP, МВт" value={dec(h.total_frp_mw, 0)} hint={`максимум ${dec(h.max_frp_mw)} МВт`} />
        <Kpi label="Наибольший ML-риск" value={risk ? risk.label : "—"} accent={risk ? `${risk.color}66` : undefined}
          hint={h.scored ? `оценено ${num(h.scored)} из ${num(h.detection_count)}` : "оценок нет"} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
        <section aria-label="Карта очага с повтором по времени" className="rise flex min-w-0 flex-col gap-2">
          <SpotMap label="Карта очага" replay center={{ lat: h.lat, lon: h.lon }} hull={h.hull}
            points={members.map((m) => ({ id: m.id, lat: m.latitude, lon: m.longitude, t: new Date(m.observed_at).toISOString(),
              href: `/detections/${m.id}`,
              color: m.risk_level ? RISK[m.risk_level]?.color ?? NO_SCORE.color : CONFIDENCE[m.confidence_level]?.color ?? "#36D6E7" }))} />
          <span className="text-[11px] text-muted">
            Ярче — новее · пунктир — выпуклая оболочка очага · цвет — ML-риск, если оценён, иначе достоверность FIRMS
          </span>
        </section>
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Активность по часам" sub={`${dateTime(h.first_observed_at)} — ${dateTime(h.last_observed_at)}`}>
            {hourly.length > 1 ? (
              <AreaChart height={160} color="#FF7A3D" values={hourly.map((p) => p.n)} labels={hourly.map((p) => timeOnly(p.t))} />
            ) : (
              <StateBox title="Все обнаружения в пределах одного часа">{num(h.detection_count)} обнаружений.</StateBox>
            )}
          </Panel>
          <Panel title="Контекст" delay={0.05}>
            <dl className="m-0 grid grid-cols-2 gap-4">
              <Fact k="Регион">{h.region_name ?? "—"}</Fact>
              <Fact k="Центр"><span className="mono">{coord(h.lat, h.lon)}</span></Fact>
              <Fact k="Ветер">{ms == null ? "нет данных" : <span className="mono">{dec(ms)} м/с · {windDir(w?.wind_direction_10m_deg)}</span>}</Fact>
              <Fact k="Влажность">{w?.relative_humidity_2m_pct == null ? "нет данных" : <span className="mono">{dec(w.relative_humidity_2m_pct, 0)} %</span>}</Fact>
              <Fact k="Спутники">{(h.satellites ?? []).map(satLabel).join(", ") || "—"}</Fact>
              <Fact k="Алгоритм"><span className="mono text-xs">{h.algorithm}</span></Fact>
            </dl>
            {w && <span className="text-[11px] text-muted">Погода Open-Meteo для последнего обнаружения с погодой ({dateTime(w.valid_at)})</span>}
          </Panel>
        </div>
      </div>

      <Panel title={`Обнаружения в очаге · ${num(members.length)}`} sub="В порядке наблюдения">
        <div className="-mx-2 max-h-[520px] overflow-auto">
          <table className="data min-w-[720px]">
            <thead><tr><th>Наблюдение (UTC+5)</th><th>Координаты</th><th>Спутник</th><th className="text-right">FRP, МВт</th><th>Оценка</th><th /></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="row">
                  <td className="mono">{dateTime(m.observed_at)}</td>
                  <td className="mono text-fg2">{coord(m.latitude, m.longitude)}</td>
                  <td className="text-fg2">{satLabel(m.satellite)}</td>
                  <td className="mono text-right">{dec(m.frp_mw)}</td>
                  <td><AssessmentBadge row={m} /></td>
                  <td className="text-right"><Link href={`/detections/${m.id}`} className="text-xs no-underline">Открыть →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
