import type { Metadata } from "next";
import { PageHead, Panel } from "@/components/ui";
import { getT } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "О системе" };

const TERMS = [
  ["Спутниковое обнаружение", "Пиксель, в котором алгоритм NASA FIRMS нашёл термическую аномалию. Координата — центр пикселя (375 м у VIIRS, ~1 км у MODIS)."],
  ["Потенциальный очаг", "Группа обнаружений на расстоянии до ~750 м друг от друга в пределах 72 часов (DBSCAN). Не подтверждённый пожар и не его площадь."],
  ["ML-оценка", "Вероятность того, что обнаружение связано с гарью растительности, по версии конкретной модели. Не подтверждение пожара."],
  ["Подтверждённый пожар", "Только при наличии независимого достоверного источника. В текущей версии не используется."],
  ["FRP", "Fire Radiative Power — мощность теплового излучения пикселя, мегаватты."],
  ["Достоверность (confidence)", "Оценка FIRMS: VIIRS — низкая/номинальная/высокая, MODIS — 0–100 % (сведено к тем же трём классам)."],
  ["NRT", "Near Real-Time: данные публикуются в течение ~3 часов после пролёта спутника. Архив SP — научная версия с задержкой 2–3 месяца."],
];

export default async function AboutPage() {
  const { t } = await getT();
  return (
    <>
      <PageHead eyebrow={t("Методология")} title={t("О системе")}
        sub={t("FireWatch — дипломный проект: информационная система раннего обнаружения лесных пожаров в Казахстане по спутниковым данным.")} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title={t("Термины")}>
          <dl className="m-0 flex flex-col gap-3">
            {TERMS.map(([term, def]) => (
              <div key={term} className="flex flex-col gap-1"><dt className="text-sm font-semibold">{t(term)}</dt><dd className="m-0 text-[13px] leading-relaxed text-fg2">{t(def)}</dd></div>
            ))}
          </dl>
        </Panel>
        <Panel title={t("Ограничения данных")} delay={0.05}>
          <ul className="m-0 flex flex-col gap-2 pl-5 text-[13px] leading-relaxed text-fg2">
            <li>{t("Полярные спутники пролетают над точкой несколько раз в сутки: пожар между пролётами виден только при следующем.")}</li>
            <li>{t("Облачность и дым скрывают пожары: отсутствие обнаружений не означает отсутствие пожаров.")}</li>
            <li>{t("Около 22 % обнаружений VIIRS в Казахстане — промышленные источники тепла (факелы), а не растительные пожары.")}</li>
            <li>{t("Suomi NPP прекратил выдачу данных 02.11.2026; MODIS (Terra, Aqua) завершает работу в 2027 году.")}</li>
            <li>{t("Погода — фактор пожарной опасности, а не доказательство пожара.")}</li>
          </ul>
        </Panel>
        <Panel title={t("Источники и лицензии")} delay={0.1}>
          <ul className="m-0 flex flex-col gap-2 pl-5 text-[13px] leading-relaxed text-fg2">
            <li><a href="https://firms.modaps.eosdis.nasa.gov/">NASA FIRMS</a>{" "}{t("(LANCE) — активные пожары VIIRS и MODIS.")}</li>
            <li><a href="https://open-meteo.com/">Open-Meteo</a>{" "}{t("— погода, CC BY 4.0, некоммерческое использование.")}</li>
            <li><a href="https://s2maps.eu">Sentinel-2 cloudless</a>{" "}{t("(EOX, данные Copernicus Sentinel 2024) — спутниковая подложка, CC BY-NC-SA 4.0.")}</li>
            <li><a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>{" "}{t("— административные границы (ODbL) и подложка карты через OpenFreeMap.")}</li>
          </ul>
        </Panel>
        <Panel title={t("Исходный код")} delay={0.15}>
          <p className="m-0 text-[13px] leading-relaxed text-fg2">
{t("Репозиторий:")}{" "}<a href="https://github.com/tailybekarai-wq/FireWatch">github.com/tailybekarai-wq/FireWatch</a>{t(". Сбор данных выполняется GitHub Actions каждые 30 минут, база — PostgreSQL/PostGIS (Neon).")}
</p>
        </Panel>
      </div>
    </>
  );
}
