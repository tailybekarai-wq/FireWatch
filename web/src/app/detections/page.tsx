import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DetectionTable } from "@/components/DetectionTable";
import { PageHead, Panel, Skeleton, StateBox } from "@/components/ui";
import { getDetections, getRegions } from "@/lib/data";
import { CONFIDENCE, SATELLITES, num } from "@/lib/format";

export const metadata: Metadata = { title: "Обнаружения" };
const SIZE = 50;
const DAYS = [1, 7, 30, 90, 365];

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default function DetectionsPage({ searchParams }: PageProps<"/detections">) {
  return (
    <>
      <PageHead eyebrow="Спутниковые обнаружения" title="Обнаружения"
        sub="Все записи NASA FIRMS по Казахстану. Каждое обнаружение — термическая аномалия, а не подтверждённый пожар." />
      <Suspense fallback={<Skeleton h={480} />}>
        <Body searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Body({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const days = DAYS.includes(Number(one(sp.days))) ? Number(one(sp.days)) : 7;
  const satellite = one(sp.sat) in SATELLITES ? one(sp.sat) : "";
  const confidence = one(sp.conf) in CONFIDENCE ? one(sp.conf) : "";
  const region = Number(one(sp.region)) || 0;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  let data, regions;
  try {
    [data, regions] = await Promise.all([
      getDetections({ days, satellite: satellite || undefined, confidence: confidence || undefined, region: region || undefined, page, size: SIZE }),
      getRegions(),
    ]);
  } catch {
    return <StateBox tone="error" title="Не удалось загрузить обнаружения">База данных недоступна. Значения не подставляются.</StateBox>;
  }
  const pages = Math.max(1, Math.ceil(data.total / SIZE));
  const qs = (patch: Record<string, string | number>) => {
    const p = new URLSearchParams({ days: String(days), sat: satellite, conf: confidence, region: region ? String(region) : "", page: String(page), ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])) });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/detections?${p}`;
  };

  return (
    <Panel title={`${num(data.total)} обнаружений`} sub={`Страница ${page} из ${pages} · по ${SIZE} записей · новые сверху`}>
      <form className="flex flex-wrap items-end gap-3" action="/detections">
        <label className="flex flex-col gap-1.5 text-xs text-fg2">Период
          <select name="days" defaultValue={days} className="field">
            {DAYS.map((d) => <option key={d} value={d}>{d === 1 ? "24 часа" : `${d} дней`}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-fg2">Спутник
          <select name="sat" defaultValue={satellite} className="field">
            <option value="">Все</option>
            {Object.entries(SATELLITES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-fg2">Достоверность
          <select name="conf" defaultValue={confidence} className="field">
            <option value="">Любая</option>
            {Object.entries(CONFIDENCE).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-fg2">Регион
          <select name="region" defaultValue={region || ""} className="field max-w-64">
            <option value="">Весь Казахстан</option>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">Применить</button>
        <Link href="/detections" className="btn">Сбросить</Link>
      </form>
      <DetectionTable rows={data.rows} />
      <nav aria-label="Страницы" className="flex items-center justify-between gap-3 text-sm">
        {page > 1 ? <Link href={qs({ page: page - 1 })} className="btn">← Назад</Link> : <span />}
        <span className="mono text-xs text-muted">{page} / {pages}</span>
        {page < pages ? <Link href={qs({ page: page + 1 })} className="btn">Вперёд →</Link> : <span />}
      </nav>
    </Panel>
  );
}
