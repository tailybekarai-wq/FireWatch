import type { Metadata } from "next";
import { PageHead, Panel } from "@/components/ui";

export const metadata: Metadata = { title: "О системе" };

const TERMS = [
  ["Спутниковое обнаружение", "Пиксель, в котором алгоритм NASA FIRMS нашёл термическую аномалию. Координата — центр пикселя (375 м у VIIRS, ~1 км у MODIS)."],
  ["Потенциальный очаг", "Группа обнаружений, близких по месту и времени. Кластеризация появится в следующих версиях."],
  ["ML-оценка", "Вероятность того, что обнаружение связано с гарью растительности, по версии конкретной модели. Не подтверждение пожара."],
  ["Подтверждённый пожар", "Только при наличии независимого достоверного источника. В текущей версии не используется."],
  ["FRP", "Fire Radiative Power — мощность теплового излучения пикселя, мегаватты."],
  ["Достоверность (confidence)", "Оценка FIRMS: VIIRS — низкая/номинальная/высокая, MODIS — 0–100 % (сведено к тем же трём классам)."],
  ["NRT", "Near Real-Time: данные публикуются в течение ~3 часов после пролёта спутника. Архив SP — научная версия с задержкой 2–3 месяца."],
];

export default function AboutPage() {
  return (
    <>
      <PageHead eyebrow="Методология" title="О системе"
        sub="FireWatch — дипломный проект: информационная система раннего обнаружения лесных пожаров в Казахстане по спутниковым данным." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Термины">
          <dl className="m-0 flex flex-col gap-3">
            {TERMS.map(([t, d]) => (
              <div key={t} className="flex flex-col gap-1"><dt className="text-sm font-semibold">{t}</dt><dd className="m-0 text-[13px] leading-relaxed text-fg2">{d}</dd></div>
            ))}
          </dl>
        </Panel>
        <Panel title="Ограничения данных" delay={0.05}>
          <ul className="m-0 flex flex-col gap-2 pl-5 text-[13px] leading-relaxed text-fg2">
            <li>Полярные спутники пролетают над точкой несколько раз в сутки: пожар между пролётами виден только при следующем.</li>
            <li>Облачность и дым скрывают пожары: отсутствие обнаружений не означает отсутствие пожаров.</li>
            <li>Около 22 % обнаружений VIIRS в Казахстане — промышленные источники тепла (факелы), а не растительные пожары.</li>
            <li>Suomi NPP прекратил выдачу данных 02.11.2026; MODIS (Terra, Aqua) завершает работу в 2027 году.</li>
            <li>Погода — фактор пожарной опасности, а не доказательство пожара.</li>
          </ul>
        </Panel>
        <Panel title="Источники и лицензии" delay={0.1}>
          <ul className="m-0 flex flex-col gap-2 pl-5 text-[13px] leading-relaxed text-fg2">
            <li><a href="https://firms.modaps.eosdis.nasa.gov/">NASA FIRMS</a> (LANCE) — активные пожары VIIRS и MODIS.</li>
            <li><a href="https://open-meteo.com/">Open-Meteo</a> — погода, CC BY 4.0, некоммерческое использование.</li>
            <li><a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> — административные границы (ODbL) и подложка карты через OpenFreeMap.</li>
          </ul>
        </Panel>
        <Panel title="Исходный код" delay={0.15}>
          <p className="m-0 text-[13px] leading-relaxed text-fg2">
            Репозиторий: <a href="https://github.com/tailybekarai-wq/FireWatch">github.com/tailybekarai-wq/FireWatch</a>. Сбор данных выполняется
            GitHub Actions каждые 30 минут, база — PostgreSQL/PostGIS (Neon).
          </p>
        </Panel>
      </div>
    </>
  );
}
