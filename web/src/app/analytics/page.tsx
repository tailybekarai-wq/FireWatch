import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { AreaChart, HBars, OrbitRings, VBars } from "@/components/charts";
import { RegionMap } from "@/components/RegionMap";
import { REGION_RAMP, quartiles, regionClass } from "@/lib/choropleth";
import { PageHead, Panel, PeriodSwitch, Skeleton, StateBox } from "@/components/ui";
import { REGION_METRICS, getFrpHistogram, getMonthly, getRegionStats, getSummary, getTimeline, type RegionMetric } from "@/lib/data";
import { dec, num } from "@/lib/format";

export const metadata: Metadata = { title: "Аналитика" };
const ALLOWED = [7, 30, 90, 365];
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export default function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  return (
    <Suspense fallback={<Skeleton h={600} />}><Body searchParams={searchParams} /></Suspense>
  );
}

async function Body({ searchParams }: { searchParams: PageProps<"/analytics">["searchParams"] }) {
  const sp = await searchParams;
  const days = ALLOWED.includes(Number(sp.days)) ? Number(sp.days) : 30;
  const metric = (String(sp.metric ?? "") in REGION_METRICS ? String(sp.metric) : "count") as RegionMetric;
  let summary, timeline, monthly, frp, regions;
  try {
    [summary, timeline, monthly, frp, regions] = await Promise.all([
      getSummary(days), getTimeline(days), getMonthly(), getFrpHistogram(days), getRegionStats(days, metric),
    ]);
  } catch {
    return <StateBox tone="error" title="Не удалось загрузить аналитику">База данных недоступна.</StateBox>;
  }
  const years = [...new Set(monthly.map((m) => m.year))];
  const maxMonth = Math.max(1, ...monthly.map((m) => m.n));
  const breaks = quartiles(regions.map((r) => r.value));
  const total = regions.reduce((a, r) => a + r.value, 0);
  const m = REGION_METRICS[metric];
  const fmt = (v: number) => (metric === "med_frp" ? dec(v) : num(Math.round(v)));
  const labels = timeline.points.map((p) => new Date(p.t).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }));

  return (
    <>
      <PageHead eyebrow="Аналитика обнаружений" title="Аналитика"
        sub="Все графики строятся по реальным записям базы. Пустые дни — это действительно ноль обнаружений.">
        <PeriodSwitch base="/analytics" days={days} options={ALLOWED} extra={`&metric=${metric}`} />
      </PageHead>
      <Panel title="Обнаружения по дням" sub={`${num(summary.period)} за ${days} дн`}>
        <AreaChart values={timeline.points.map((p) => p.n)} labels={labels} color="#36D6E7" />
      </Panel>
      <Panel title="Карта регионов" sub={`${m.label}${m.unit ? `, ${m.unit}` : ""} · за ${days} дн · по областям`}
        action={
          <div role="group" aria-label="Метрика" className="flex flex-wrap gap-1.5">
            {(Object.keys(REGION_METRICS) as RegionMetric[]).map((k) => (
              <Link key={k} href={`/analytics?days=${days}&metric=${k}`} aria-current={k === metric ? "true" : undefined} className="chip no-underline">
                {REGION_METRICS[k].label}
              </Link>
            ))}
          </div>
        }>
        <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
          <div className="flex min-w-0 flex-col gap-2">
            <RegionMap unit={m.unit} breaks={breaks}
              regions={regions.map((r) => ({ id: r.id, name: r.name, geometry: r.geometry, value: r.value, label: fmt(r.value) }))} />
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
              <span className="flex items-center gap-1.5"><span className="dot" style={{ background: REGION_RAMP[0] }} />0</span>
              {breaks.map((b, i) => (
                <span key={i} className="flex items-center gap-1.5"><span className="dot" style={{ background: REGION_RAMP[i + 1] }} />≤ {fmt(b)}</span>
              ))}
              <span className="flex items-center gap-1.5"><span className="dot" style={{ background: REGION_RAMP[4] }} />&gt; {fmt(breaks[2])}</span>
              <span>· квартили по областям с ненулевым значением</span>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-fg2">{metric === "med_frp" ? "Значение по области" : "Доля от общего"}</span>
            <ul className="m-0 flex max-h-[420px] list-none flex-col gap-1 overflow-y-auto p-0 text-[13px]">
              {regions.map((r) => (
                <li key={r.id}>
                  <Link href={`/detections?days=${days}&region=${r.id}`} className="row grid grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-fg no-underline">
                    <span className="dot" style={{ background: REGION_RAMP[regionClass(r.value, breaks)] }} />
                    <span className="truncate">{r.name}</span>
                    <span className="mono text-xs text-fg2">{fmt(r.value)}{metric !== "med_frp" && total > 0 ? ` · ${dec((100 * r.value) / total)}%` : ""}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>
      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title="Регионы" sub="Распределение по областям" delay={0.05}>
          <HBars rows={summary.topRegions.map((r) => ({ label: r.name, n: r.n, href: `/detections?days=${days}&region=${r.id}` }))} limit={20} />
        </Panel>
        <Panel title="Спутники" sub="Доля платформ" delay={0.1}>
          {summary.bySatellite.length ? <OrbitRings rows={summary.bySatellite} /> : <StateBox title="Нет данных" />}
        </Panel>
        <Panel title="Мощность излучения (FRP)" sub="Число обнаружений по диапазонам, МВт" delay={0.15}>
          <VBars rows={frp.map((b) => ({ label: b.bucket, n: b.n }))} />
        </Panel>
      </div>
      <Panel title="Сезонность" sub="Обнаружения по месяцам · чем ярче ячейка, тем больше обнаружений">
        <div className="overflow-x-auto">
          <table className="data min-w-[720px]">
            <thead><tr><th>Год</th>{MONTHS.map((m) => <th key={m} className="text-center">{m}</th>)}</tr></thead>
            <tbody>
              {years.map((y) => (
                <tr key={y}>
                  <td className="mono">{y}</td>
                  {MONTHS.map((_, i) => {
                    const n = monthly.find((m) => m.year === y && m.month === i + 1)?.n;
                    return (
                      <td key={i} className="mono text-center text-xs" title={n != null ? `${MONTHS[i]} ${y}: ${num(n)}` : "нет данных"}
                        style={{ background: n ? `rgba(255,122,61,${0.08 + 0.6 * (n / maxMonth)})` : "transparent" }}>
                        {n != null ? num(n) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
