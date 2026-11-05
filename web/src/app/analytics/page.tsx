import type { Metadata } from "next";
import { Suspense } from "react";
import { AreaChart, HBars, OrbitRings, VBars } from "@/components/charts";
import { PageHead, Panel, PeriodSwitch, Skeleton, StateBox } from "@/components/ui";
import { getFrpHistogram, getMonthly, getSummary, getTimeline } from "@/lib/data";
import { num } from "@/lib/format";

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
  let summary, timeline, monthly, frp;
  try {
    [summary, timeline, monthly, frp] = await Promise.all([getSummary(days), getTimeline(days), getMonthly(), getFrpHistogram(days)]);
  } catch {
    return <StateBox tone="error" title="Не удалось загрузить аналитику">База данных недоступна.</StateBox>;
  }
  const years = [...new Set(monthly.map((m) => m.year))];
  const maxMonth = Math.max(1, ...monthly.map((m) => m.n));
  const labels = timeline.points.map((p) => new Date(p.t).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }));

  return (
    <>
      <PageHead eyebrow="Аналитика обнаружений" title="Аналитика"
        sub="Все графики строятся по реальным записям базы. Пустые дни — это действительно ноль обнаружений.">
        <PeriodSwitch base="/analytics" days={days} options={ALLOWED} />
      </PageHead>
      <Panel title="Обнаружения по дням" sub={`${num(summary.period)} за ${days} дн`}>
        <AreaChart values={timeline.points.map((p) => p.n)} labels={labels} color="#36D6E7" />
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
