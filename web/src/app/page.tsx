import Link from "next/link";
import { Suspense } from "react";
import { AreaChart, HBars, OrbitRings } from "@/components/charts";
import { DetectionTable } from "@/components/DetectionTable";
import { Kpi, PageHead, Panel, PeriodSwitch, Skeleton, StaleBanner, StateBox } from "@/components/ui";
import { getRecent, getSummary, getTimeline } from "@/lib/data";
import { dateTime, num, timeOnly } from "@/lib/format";
import { getRegionNamer, getT } from "@/lib/i18n-server";

const ALLOWED = [1, 7, 30];

export default async function Dashboard({ searchParams }: PageProps<"/">) {
  return (
    <>
      <Suspense fallback={null}><StaleBanner /></Suspense>
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardBody searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Skeleton h={90} />
      <div className="grid gap-4 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={110} />)}</div>
      <Skeleton h={300} />
    </div>
  );
}

async function DashboardBody({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { t, locale } = await getT();
  const regionName = await getRegionNamer(locale);
  const sp = await searchParams;
  const days = ALLOWED.includes(Number(sp.days)) ? Number(sp.days) : 7;
  let summary, timeline, recent;
  try {
    [summary, timeline, recent] = await Promise.all([getSummary(days), getTimeline(days === 1 ? 1 : days), getRecent(8)]);
  } catch (error) {
    console.error(error);
    return <StateBox tone="error" title={t("Не удалось загрузить данные")}>{t("База данных недоступна. Повторите попытку позже — значения не подставляются.")}</StateBox>;
  }
  const delta = summary.last24h - summary.prev24h;
  const labels = timeline.points.map((p) => (timeline.unit === "hour" ? timeOnly(p.t) : new Date(p.t).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })));

  return (
    <>
      <PageHead eyebrow="Live thermal watch" title={t("Мониторинг лесных пожаров")}
        sub={t("Спутниковые обнаружения термических аномалий на территории Казахстана: NASA FIRMS (VIIRS NOAA-20/21, MODIS).")}>
        <PeriodSwitch base="/" days={days} />
      </PageHead>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label={t("Обнаружений за 24 ч")} value={num(summary.last24h)}
          hint={t("к предыдущим 24 ч: {d}", { d: `${delta >= 0 ? "+" : ""}${num(delta)}` })} accent="rgba(54,214,231,.25)" />
        <Kpi label={t("За период · {p}", { p: days === 1 ? t("24 ч") : t("{n} дн", { n: days }) })} value={num(summary.period)} hint={t("по суточной статистике")} />
        <Kpi label={t("Всего в базе")} value={num(summary.total)} hint={t("с 01.01.2025")} />
        <Kpi label={t("ML-оценка")} value={summary.model ? summary.model.version : "—"}
          hint={summary.model ? summary.model.name : t("Модель не активна: показаны данные FIRMS без ML")} accent="rgba(255,122,61,.22)" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title={t("Динамика обнаружений")} sub={timeline.unit === "hour" ? t("По часам, местное время (UTC+5)") : t("По дням")}
          action={<Link href={`/analytics?days=${Math.max(days, 30)}`} className="text-xs no-underline">{t("Аналитика →")}</Link>}>
          <AreaChart values={timeline.points.map((p) => p.n)} labels={labels} />
        </Panel>
        <Panel title={t("Доля спутников")} sub={t("Обнаружения за период по платформам")} delay={0.1}>
          {summary.bySatellite.length ? <OrbitRings rows={summary.bySatellite} /> :
            <StateBox title={t("За период обнаружений нет")}>{t("Попробуйте период 7 или 30 дней.")}</StateBox>}
        </Panel>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Panel title={t("Регионы")} sub={t("Больше всего обнаружений за период")} delay={0.05}>
          {summary.topRegions.length ? (
            <HBars rows={summary.topRegions.map((r) => ({ label: regionName(r.id, r.name) ?? r.name, n: r.n, href: `/detections?days=${days}&region=${r.id}` }))} limit={8} />
          ) : <StateBox title={t("Нет данных за период")} />}
        </Panel>
        <Panel title={t("Последние обнаружения")} sub={recent.length ? t("Новейшее: {at}", { at: dateTime(recent[0].observed_at) }) : undefined}
          action={<Link href="/detections" className="btn btn-primary">{t("Все обнаружения")}</Link>} delay={0.1}>
          <DetectionTable rows={recent} compact />
        </Panel>
      </div>
    </>
  );
}
