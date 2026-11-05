import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHead, Panel, Skeleton, StateBox } from "@/components/ui";
import { getModels } from "@/lib/data";
import { dateTime } from "@/lib/format";

export const metadata: Metadata = { title: "ML-модель" };

export default function MlPage() {
  return (
    <>
      <PageHead eyebrow="Machine learning" title="ML-модель"
        sub="Модель оценивает, связано ли обнаружение с картируемой гарью растительности. Метрики показываются только из реальной проверки." />
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="observation rise flex flex-col gap-2 rounded-3xl p-5">
          <span className="mono text-[11px] tracking-[.14em] text-signal">01 · НАБЛЮДЕНИЕ</span>
          <h2 className="m-0 text-lg font-semibold">Термическая аномалия со спутника</h2>
          <p className="m-0 text-[13px] leading-relaxed text-fg2">Данные NASA FIRMS как есть: координаты, время, FRP, достоверность. Никогда не изменяются системой.</p>
        </div>
        <div className="estimate rise flex flex-col gap-2 rounded-3xl p-5" style={{ animationDelay: ".08s" }}>
          <span className="mono text-[11px] tracking-[.14em] text-[#FF9A6B]">02 · ML-ОЦЕНКА</span>
          <h2 className="m-0 text-lg font-semibold">Вероятность и уровень риска</h2>
          <p className="m-0 text-[13px] leading-relaxed text-fg2">Аналитическая оценка с версией модели. Не подтверждает пожар.</p>
        </div>
      </div>
      <Suspense fallback={<Skeleton h={240} />}><Models /></Suspense>
    </>
  );
}

async function Models() {
  let models;
  try { models = await getModels(); } catch {
    return <StateBox tone="error" title="Не удалось загрузить сведения о модели">База данных недоступна.</StateBox>;
  }
  if (!models.length) {
    return (
      <Panel title="Модель ещё не обучена" sub="Этап 6 плана разработки">
        <StateBox tone="info" title="ML-оценка пока не используется">
          Сейчас система показывает только официальные наблюдения FIRMS. Модель (LightGBM) будет обучена на архиве VIIRS 2019–2025
          с разметкой по картам гарей и допущена в работу, только если превзойдёт простые правила на отложенной выборке.
          Метрики появятся здесь из отчёта проверки — заранее они не заявляются.
        </StateBox>
        <Link href="/about" className="text-sm no-underline">Как будет устроена модель →</Link>
      </Panel>
    );
  }
  return (
    <Panel title="Версии модели">
      <table className="data">
        <thead><tr><th>Версия</th><th>Алгоритм</th><th>Статус</th><th>Обучена</th><th>Метрики</th></tr></thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.version} className="row">
              <td className="mono">{m.name} {m.version}</td>
              <td>{m.algorithm}</td>
              <td>{m.status}</td>
              <td className="mono">{dateTime(m.trained_at)}</td>
              <td className="mono text-xs text-fg2">{JSON.stringify(m.metrics).slice(0, 160)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
