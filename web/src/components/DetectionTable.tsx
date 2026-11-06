import Link from "next/link";
import type { DetectionRow } from "@/lib/data";
import { CONFIDENCE, RISK, coord, dateTime, dec, satLabel } from "@/lib/format";
import { StateBox } from "./ui";
import { getRegionNamer, getT } from "@/lib/i18n-server";

export async function AssessmentBadge({ row }: { row: Pick<DetectionRow, "risk_level" | "probability" | "confidence_level"> }) {
  const { t } = await getT();
  if (row.risk_level && RISK[row.risk_level]) {
    const r = RISK[row.risk_level];
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium" style={{ color: r.color, background: `${r.color}1f` }}>
        <span className="dot size-1.5" style={{ background: r.color }} />{t(r.label)} · {Math.round((row.probability ?? 0) * 100)}%
      </span>
    );
  }
  const c = CONFIDENCE[row.confidence_level] ?? CONFIDENCE.nominal;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs" style={{ color: c.color, background: `${c.color}14` }}
      title={t("ML-модель не активна: показана достоверность обнаружения из FIRMS")}>
      <span className="dot size-1.5" style={{ background: c.color }} />{t(c.label)}
    </span>
  );
}

export async function DetectionTable({ rows, compact = false, detailsHref, selected }: {
  rows: DetectionRow[]; compact?: boolean; detailsHref?: (id: number) => string; selected?: number;
}) {
  const { t, locale } = await getT();
  const regionName = await getRegionNamer(locale);
  if (!rows.length) {
    return <StateBox title={t("Нет обнаружений по этим условиям")}>{t("Расширьте период или сбросьте фильтры.")}</StateBox>;
  }
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="data min-w-[720px]">
        <thead>
          <tr>
            <th>{t("Наблюдение (UTC+5)")}</th><th>{t("Координаты")}</th><th>{t("Спутник")}</th>{!compact && <th>{t("Регион")}</th>}
            <th className="text-right">{t("FRP, МВт")}</th><th>{t("Достоверность")}</th>{!compact && <th>{t("День/ночь")}</th>}<th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="row" style={r.id === selected ? { background: "rgba(59,227,138,.08)" } : undefined}>
              <td className="mono">{dateTime(r.observed_at)}</td>
              <td className="mono text-fg2">{coord(r.latitude, r.longitude)}</td>
              <td className="text-fg2">{satLabel(r.satellite)}</td>
              {!compact && <td className="text-fg2">{regionName(r.region_id, r.region_name) ?? "—"}</td>}
              <td className="mono text-right">{dec(r.frp_mw)}</td>
              <td><AssessmentBadge row={r} /></td>
              {!compact && <td className="text-fg2">{r.daynight === "D" ? t("день") : t("ночь")}</td>}
              <td className="text-right">
                <Link href={detailsHref ? detailsHref(r.id) : `/detections/${r.id}`} scroll={!detailsHref}
                  aria-label={detailsHref ? t("Открыть панель деталей #{id}", { id: r.id }) : undefined} className="text-xs no-underline">{t("Детали →")}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
