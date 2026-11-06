import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AssessmentBadge, DetectionTable } from "@/components/DetectionTable";
import { PageHead, Panel, Skeleton, StateBox } from "@/components/ui";
import { RISK_FILTERS, getDetection, getDetections, getRegions, type RiskFilter } from "@/lib/data";
import { CONFIDENCE, SATELLITES, coord, dateTime, dec, firmsMapUrl, num, satLabel } from "@/lib/format";

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
  const risk = one(sp.risk) in RISK_FILTERS ? (one(sp.risk) as RiskFilter) : undefined;
  const region = Number(one(sp.region)) || 0;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const sel = Number(one(sp.sel)) || 0;
  let data, regions, selected;
  try {
    [data, regions, selected] = await Promise.all([
      getDetections({ days, satellite: satellite || undefined, confidence: confidence || undefined, risk, region: region || undefined, page, size: SIZE }),
      getRegions(),
      sel > 0 ? getDetection(sel) : null,
    ]);
  } catch {
    return <StateBox tone="error" title="Не удалось загрузить обнаружения">База данных недоступна. Значения не подставляются.</StateBox>;
  }
  const pages = Math.max(1, Math.ceil(data.total / SIZE));
  const filters = { days: String(days), sat: satellite, conf: confidence, risk: risk ?? "", region: region ? String(region) : "" };
  const qs = (patch: Record<string, string | number>) => {
    const p = new URLSearchParams({ ...filters, page: String(page), sel: sel ? String(sel) : "",
      ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])) });
    for (const [k, v] of [...p.entries()]) if (!v || (k === "page" && v === "1")) p.delete(k);
    return `/detections?${p}`;
  };
  const csv = `/api/export?${new URLSearchParams(Object.entries(filters).filter(([, v]) => v))}`;

  return (
    <div className="grid items-start gap-5 2xl:grid-cols-[1fr_360px]">
      <Panel title={`${num(data.total)} обнаружений`} sub={`Страница ${page} из ${pages} · по ${SIZE} записей · новые сверху`}
        action={<a href={csv} className="btn" title="Все записи по фильтрам, до 50 000 строк, с указанием источника">Экспорт CSV</a>}>
        <form className="flex flex-wrap items-end gap-3" action="/detections">
          <label className="flex flex-col gap-1.5 text-xs text-fg2">Период
            <select name="days" defaultValue={days} className="field">
              {DAYS.map((d) => <option key={d} value={d}>{d === 1 ? "24 часа" : `${d} дней`}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-fg2">ML-риск
            <select name="risk" defaultValue={risk ?? ""} className="field">
              <option value="">Любой</option>
              {Object.entries(RISK_FILTERS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
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
        <DetectionTable rows={data.rows} selected={sel} detailsHref={(id) => qs({ sel: id })} />
        <nav aria-label="Страницы" className="flex items-center justify-between gap-3 text-sm">
          {page > 1 ? <Link href={qs({ page: page - 1 })} className="btn">← Назад</Link> : <span />}
          <span className="mono text-xs text-muted">{page} / {pages}</span>
          {page < pages ? <Link href={qs({ page: page + 1 })} className="btn">Вперёд →</Link> : <span />}
        </nav>
      </Panel>

      {selected && (
        <aside aria-label="Детали обнаружения" className="glass2 rise flex flex-col gap-3.5 rounded-3xl p-5 2xl:sticky 2xl:top-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="mono m-0 text-lg font-medium">{coord(selected.latitude, selected.longitude)}</h2>
              <span className="mono text-[11px] text-muted">#{selected.id} · {dateTime(selected.observed_at)}</span>
            </div>
            <Link href={qs({ sel: "" })} scroll={false} aria-label="Закрыть детали" className="btn size-9 p-0">✕</Link>
          </div>
          <AssessmentBadge row={selected} />
          <dl className="observation m-0 grid grid-cols-2 gap-3 rounded-2xl p-3.5 text-xs">
            <div className="flex flex-col gap-0.5"><dt className="text-muted">FRP</dt><dd className="mono m-0">{dec(selected.frp_mw)} МВт</dd></div>
            <div className="flex flex-col gap-0.5"><dt className="text-muted">Достоверность</dt><dd className="m-0">{CONFIDENCE[selected.confidence_level]?.label} ({selected.confidence_raw})</dd></div>
            <div className="flex flex-col gap-0.5"><dt className="text-muted">Спутник</dt><dd className="m-0">{satLabel(selected.satellite)}</dd></div>
            <div className="flex flex-col gap-0.5"><dt className="text-muted">Версия</dt><dd className="mono m-0">{selected.processing_level} · {selected.product_version}</dd></div>
            <div className="col-span-2 flex flex-col gap-0.5"><dt className="text-muted">Пиксель</dt>
              <dd className="mono m-0">{dec(selected.scan_km, 2)} × {dec(selected.track_km, 2)} км · соседей в 5 км за ±48 ч: {num(selected.neighbors)}</dd></div>
          </dl>
          <span className="text-xs text-fg2">Не является подтверждённым пожаром.</span>
          <div className="grid grid-cols-2 gap-2">
            <Link href={`/detections/${selected.id}`} className="btn btn-primary">Полная запись</Link>
            <a href={firmsMapUrl(selected.latitude, selected.longitude, selected.observed_at)} target="_blank" rel="noreferrer" className="btn">FIRMS ↗</a>
          </div>
          {selected.cluster_id && <Link href={`/hotspots/${selected.cluster_id}`} className="text-xs no-underline">Потенциальный очаг #{selected.cluster_id} →</Link>}
        </aside>
      )}
    </div>
  );
}
