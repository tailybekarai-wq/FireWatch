import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { HBars } from "@/components/charts";
import { Panel, Skeleton, StateBox } from "@/components/ui";
import { getActiveModel, getDetection, getModels, getPrediction, type ActiveModel } from "@/lib/data";
import { FEATURE_LABELS, RISK, coord, dateTime, num } from "@/lib/format";
import { getT } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "ML-модель" };
const REPO = "https://github.com/tailybekarai-wq/FireWatch";
const NAMES: Record<string, string> = {
  lightgbm: "LightGBM (модель)", random_forest: "Random Forest", baseline1: "Логистическая регрессия", baseline0: "Правило FIRMS (confidence)",
};
const STATUS: Record<string, string> = { active: "в работе", rejected: "отклонена", retired: "выведена", candidate: "кандидат" };

export default async function MlPage({ searchParams }: PageProps<"/ml">) {
  const { t } = await getT();
  return (
    <>
      <div className="rise flex flex-col gap-3">
        <span className="eyebrow text-forest">Machine learning</span>
        <h1 className="m-0 text-4xl font-semibold leading-none tracking-[-0.045em] md:text-5xl">{t("ML-модель")}</h1>
        <p className="m-0 max-w-2xl text-[15px] leading-relaxed text-fg2">
{t("Модель оценивает, связано ли спутниковое обнаружение с гарью растительности, картированной независимым продуктом MODIS. Все цифры ниже — из проверки на годах, которые модель не видела при обучении.")}
</p>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="observation rise flex flex-col gap-2 rounded-3xl p-5">
          <span className="mono text-[11px] tracking-[.14em] text-signal">{t("01 · ОФИЦИАЛЬНОЕ НАБЛЮДЕНИЕ")}</span>
          <h2 className="m-0 text-lg font-semibold">{t("Термическая аномалия со спутника")}</h2>
          <p className="m-0 text-[13px] leading-relaxed text-fg2">{t("Сплошная рамка. Данные NASA FIRMS как есть, система их никогда не изменяет.")}</p>
        </div>
        <div className="estimate rise flex flex-col gap-2 rounded-3xl p-5" style={{ animationDelay: ".08s" }}>
          <span className="mono text-[11px] tracking-[.14em] text-[#FF9A6B]">{t("02 · ML-ОЦЕНКА")}</span>
          <h2 className="m-0 text-lg font-semibold">{t("Вероятность и уровень риска")}</h2>
          <p className="m-0 text-[13px] leading-relaxed text-fg2">{t("Пунктирная рамка. Аналитическая оценка с версией модели. Не подтверждает пожар.")}</p>
        </div>
      </div>
      <Suspense fallback={<Skeleton h={480} />}><Body searchParams={searchParams} /></Suspense>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-white/5 p-3.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="mono text-2xl font-medium tracking-tight">{value}</span>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  );
}

const f3 = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(3).replace(".", ","));

/** Confusion counts on the test years for "high or critical" vs the rest, from the level table. */
function confusion(m: ActiveModel) {
  const lv = m.metrics.levels;
  const flagged = ["very_high", "high"];
  const tp = flagged.reduce((a, k) => a + Math.round((lv[k]?.test_n ?? 0) * (lv[k]?.test_precision ?? 0)), 0);
  const pp = flagged.reduce((a, k) => a + (lv[k]?.test_n ?? 0), 0);
  const n = m.metrics.splits.sizes.test;
  const pos = Math.round(n * m.metrics.splits.positive_share.test);
  const fp = pp - tp;
  const fn = pos - tp;
  const tn = n - pp - fn;
  const precision = pp ? tp / pp : 0;
  const recall = pos ? tp / pos : 0;
  return { tp, fp, fn, tn, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

async function Body({ searchParams }: { searchParams: PageProps<"/ml">["searchParams"] }) {
  const { t } = await getT();
  const sp = await searchParams;
  const lookup = Number(Array.isArray(sp.id) ? sp.id[0] : sp.id) || 0;
  let model, models, prediction, detection;
  try {
    [model, models, prediction, detection] = await Promise.all([
      getActiveModel(), getModels(), lookup > 0 ? getPrediction(lookup) : null, lookup > 0 ? getDetection(lookup) : null,
    ]);
  } catch {
    return <StateBox tone="error" title={t("Не удалось загрузить сведения о модели")}>{t("База данных недоступна.")}</StateBox>;
  }
  if (!model) {
    return (
      <Panel title={t("Активной модели нет")}>
        <StateBox tone="info" title={t("ML-оценка не используется")}>
          Система показывает только наблюдения FIRMS. {models.length ? t("Обученные версии не прошли критерии допуска.") : t("Модель ещё не обучена.")}
        </StateBox>
      </Panel>
    );
  }
  const tm = model.metrics.test;
  const ci = model.metrics.test_ci95;
  const c = confusion(model);
  // doy_sin and doy_cos are one "season" signal for a reader
  const importance = Object.entries(model.metrics.importance).reduce<Record<string, number>>((acc, [k, v]) => {
    const label = FEATURE_LABELS[k] ?? k;
    acc[label] = (acc[label] ?? 0) + v;
    return acc;
  }, {});
  const maxImp = Math.max(...Object.values(importance));
  const overview: [string, ReactNode][] = [
    [t("Алгоритм"), model.algorithm],
    [t("Обучена"), dateTime(model.trained_at)],
    [t("Обучение"), t("VIIRS NOAA-20, Казахстан, 2019–2022 · {n} объектов", { n: num(model.metrics.splits.sizes.train) })],
    [t("Проверка (test)"), t("2024–2025 · {n} объектов, оценена один раз", { n: num(model.metrics.splits.sizes.test) })],
    [t("Признаки"), t("{n} · только информация до момента наблюдения", { n: model.features.length })],
    [t("Код"), <a key="git" href={`${REPO}/commit/${model.git_sha}`} target="_blank" rel="noreferrer" className="mono">{model.git_sha.slice(0, 7)}</a>],
  ];

  return (
    <>
      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title={t("Обзор модели")} sub={`${model.name} ${model.version} · ${t(STATUS[model.status] ?? model.status)}`}>
          <dl className="m-0 grid gap-3 text-[13px]">
            {overview.map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5"><dt className="text-[11px] text-muted">{k}</dt><dd className="m-0">{v}</dd></div>
            ))}
          </dl>
          <a href={`${REPO}/blob/main/ml/models/${model.version}/evaluation.md`} target="_blank" rel="noreferrer" className="text-xs no-underline">
{t("Полный отчёт об оценке ↗")}
</a>
        </Panel>

        <Panel title={t("Качество на проверке")} sub={t("Годы 2024–2025, не использованные при обучении")} delay={0.05} className="xl:col-span-2">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="PR-AUC" value={f3(tm.lightgbm?.pr_auc)}
              hint={ci["lightgbm.pr_auc"] ? t("95 % ДИ {lo}–{hi}", { lo: f3(ci["lightgbm.pr_auc"][0]), hi: f3(ci["lightgbm.pr_auc"][1]) }) : undefined} />
            <Stat label="ROC-AUC" value={f3(tm.lightgbm?.roc_auc)} />
            <Stat label={t("Точность (≥ высокий)")} value={`${Math.round(c.precision * 100)}%`} hint={t("доля действительно связанных с гарью")} />
            <Stat label={t("Полнота (≥ высокий)")} value={`${Math.round(c.recall * 100)}%`} hint={`F1 ${f3(c.f1)}`} />
          </div>
          <table className="data">
            <thead><tr><th>{t("Модель")}</th><th className="text-right">PR-AUC</th><th className="text-right">ROC-AUC</th><th className="text-right">Brier</th></tr></thead>
            <tbody>
              {Object.keys(NAMES).filter((k) => tm[k]).map((k) => (
                <tr key={k} className="row" style={k === "lightgbm" ? { background: "rgba(59,227,138,.06)" } : undefined}>
                  <td>{t(NAMES[k])}</td>
                  <td className="mono text-right">{f3(tm[k].pr_auc)}</td>
                  <td className="mono text-right">{f3(tm[k].roc_auc)}</td>
                  <td className="mono text-right">{f3(tm[k].brier)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="text-[11px] text-muted">
            {t("Brier — ошибка вероятностей (меньше — лучше). Критерии допуска ML_STRATEGY §8")}{" "}
            {Object.values(model.metrics.gate).every(Boolean) ? t("выполнены все") : t("выполнены не все")}.
          </span>
        </Panel>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title={t("Важность признаков")} sub={t("Средний |SHAP| на проверочной выборке, 100 — самый влиятельный")} className="xl:col-span-2">
          <HBars color="#FF9A6B" limit={12}
            rows={Object.entries(importance).sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label: t(label), n: Math.round((v / maxImp) * 100) }))} />
        </Panel>
        <Panel title={t("Матрица ошибок")} sub={t("Порог: уровень «высокий» и выше · test 2024–2025")} delay={0.05}>
          <div className="grid grid-cols-[auto_1fr_1fr] gap-1.5 text-center text-xs">
            <span />
            <span className="text-muted">{t("Оценка: гарь")}</span>
            <span className="text-muted">{t("Оценка: нет")}</span>
            <span className="self-center text-left text-muted">{t("Гарь")}</span>
            <span className="rounded-xl bg-[#3BE38A1f] p-3"><span className="mono block text-lg">{num(c.tp)}</span>{t("верно")}</span>
            <span className="rounded-xl bg-white/5 p-3"><span className="mono block text-lg">{num(c.fn)}</span>{t("пропущено")}</span>
            <span className="self-center text-left text-muted">{t("Нет гари")}</span>
            <span className="rounded-xl bg-[#FF4D5E1a] p-3"><span className="mono block text-lg">{num(c.fp)}</span>{t("ложная тревога")}</span>
            <span className="rounded-xl bg-white/5 p-3"><span className="mono block text-lg">{num(c.tn)}</span>{t("верно")}</span>
          </div>
          <span className="text-[11px] leading-relaxed text-muted">{t("«Гарь» — по карте MODIS MCD64A1. Мелкие пожары без гари 500 м попадают в «нет гари».")}</span>
        </Panel>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title={t("Оценка конкретного обнаружения")} sub={t("Номер записи — чтобы увидеть, из чего сложилась оценка")}>
          <form action="/ml" className="flex gap-2">
            <input name="id" type="number" min={1} defaultValue={lookup || ""} placeholder={t("ID обнаружения")} aria-label={t("ID обнаружения")} className="field flex-1" />
            <button type="submit" className="btn btn-primary">{t("Показать")}</button>
          </form>
          {lookup > 0 && !detection && <StateBox title={t("Запись не найдена")}>{t("Обнаружения #")}{lookup}{" "}{t("нет в базе.")}</StateBox>}
          {detection && !prediction && (
            <StateBox title={t("Нет оценки")}>
              #{detection.id} ({coord(detection.latitude, detection.longitude)}) {t("не оценивалось: модель оценивает VIIRS за последние 7 дней.")}
            </StateBox>
          )}
          {detection && prediction && (
            <div className="estimate flex flex-col gap-2.5 rounded-2xl p-4 text-[13px]">
              <span className="flex flex-wrap items-baseline gap-3">
                <span className="mono text-3xl">{Math.round(prediction.probability * 100)}%</span>
                <span style={{ color: RISK[prediction.risk_level]?.color }}>{t(RISK[prediction.risk_level]?.label ?? prediction.risk_level)}</span>
                <Link href={`/detections/${detection.id}`} className="mono text-xs no-underline">#{detection.id} →</Link>
              </span>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {(prediction.top_contributions ?? []).map((x) => (
                  <li key={x.feature} className="flex justify-between gap-3 text-fg2">
                    <span>{x.contribution > 0 ? "↑" : "↓"} {t(FEATURE_LABELS[x.feature] ?? x.feature)}</span>
                    <span className="mono text-xs">{x.contribution > 0 ? "+" : ""}{x.contribution.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
              <span className="text-[11px] text-muted">{t("Вклады в логарифмических шансах (SHAP), до калибровки.")}</span>
            </div>
          )}
        </Panel>
        <Panel title={t("Ограничения и проверка")} delay={0.05}>
          <p className="m-0 text-[13px] leading-relaxed text-fg2">{model.limitations}</p>
          <p className="m-0 text-[13px] leading-relaxed text-fg2">{model.validation_scheme}</p>
          <table className="data">
            <thead><tr><th>{t("Версия")}</th><th>{t("Статус")}</th><th>{t("Обучена")}</th></tr></thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.version} className="row"><td className="mono">{m.version}</td><td>{t(STATUS[m.status] ?? m.status)}</td><td className="mono">{dateTime(m.trained_at)}</td></tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
