import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHead, Panel, Skeleton, StateBox } from "@/components/ui";
import { getRecentRuns, getSources } from "@/lib/data";
import { ago, dateTime, num } from "@/lib/format";

export const metadata: Metadata = { title: "Источники данных" };

const STATUS = {
  ok: { label: "Работает", color: "#3BE38A" },
  error: { label: "Ошибка", color: "#FF4D5E" },
  idle: { label: "Не опрашивается", color: "#8A97A2" },
  retired: { label: "Прекращён", color: "#F2C14E" },
};

export default function SourcesPage() {
  return (
    <>
      <PageHead eyebrow="Pipeline" title="Источники данных"
        sub="Откуда берутся данные, когда они обновлялись и что пошло не так. Сбор выполняется GitHub Actions каждые 30 минут." />
      <Suspense fallback={<Skeleton h={480} />}><Body /></Suspense>
    </>
  );
}

async function Body() {
  let sources, runs;
  try { [sources, runs] = await Promise.all([getSources(), getRecentRuns(12)]); } catch {
    return <StateBox tone="error" title="Не удалось загрузить статус источников">База данных недоступна.</StateBox>;
  }
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sources.map((s, i) => {
          const st = s.deprecated_at ? STATUS.retired : !s.enabled ? STATUS.idle : s.last_status === "ok" ? STATUS.ok : s.last_status ? STATUS.error : STATUS.idle;
          return (
            <article key={s.code} className="glass lift rise flex flex-col gap-3 rounded-[22px] p-[18px]" style={{ animationDelay: `${i * 0.03}s` }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h2 className="m-0 text-base font-semibold">{s.name}</h2>
                  <span className="text-xs text-muted">{s.provider}</span>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]" style={{ color: st.color, background: `${st.color}1a` }}>
                  <span className="dot size-1.5" style={{ background: st.color }} />{st.label}
                </span>
              </div>
              {s.description && <p className="m-0 text-[13px] leading-relaxed text-fg2">{s.description}</p>}
              <dl className="m-0 grid grid-cols-2 gap-2 text-xs">
                <dt className="text-muted">Последний успех</dt><dd className="mono m-0">{s.last_success_at ? ago(s.last_success_at) : "—"}</dd>
                {s.records_total != null && (<><dt className="text-muted">Записей всего</dt><dd className="mono m-0">{num(s.records_total)}</dd></>)}
                {s.records_last_24h != null && (<><dt className="text-muted">Получено за 24 ч</dt><dd className="mono m-0">{num(s.records_last_24h)}</dd></>)}
              </dl>
              {s.last_error && (
                <p className="m-0 rounded-xl bg-[#FF4D5E]/10 p-2.5 text-xs text-[#FF9AA4]">
                  {dateTime(s.last_error_at)}: {s.last_error.slice(0, 200)}
                </p>
              )}
              <div className="mt-auto flex flex-wrap gap-3 text-xs">
                <a href={s.official_url} target="_blank" rel="noreferrer">Сайт ↗</a>
                {s.docs_url && <a href={s.docs_url} target="_blank" rel="noreferrer">Документация ↗</a>}
                <span className="text-muted">{s.license}</span>
              </div>
            </article>
          );
        })}
      </div>
      <Panel title="Последние запуски" sub="Журнал ingestion_runs: плановые, ручные и загрузка истории">
        <div className="-mx-2 overflow-x-auto">
          <table className="data min-w-[640px]">
            <thead><tr><th>#</th><th>Тип</th><th>Статус</th><th>Начало</th><th>Окончание</th><th>Ошибка</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="row">
                  <td className="mono">{r.id}</td>
                  <td className="text-fg2">{r.trigger}</td>
                  <td style={{ color: r.status === "success" ? "#3BE38A" : r.status === "failed" ? "#FF4D5E" : "#F2C14E" }}>{r.status}</td>
                  <td className="mono">{dateTime(r.started_at)}</td>
                  <td className="mono">{dateTime(r.finished_at)}</td>
                  <td className="max-w-80 truncate text-xs text-fg2">{r.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
