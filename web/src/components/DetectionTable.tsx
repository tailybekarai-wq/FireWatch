import Link from "next/link";
import type { DetectionRow } from "@/lib/data";
import { CONFIDENCE, RISK, coord, dateTime, dec, satLabel } from "@/lib/format";
import { StateBox } from "./ui";

export function AssessmentBadge({ row }: { row: Pick<DetectionRow, "risk_level" | "probability" | "confidence_level"> }) {
  if (row.risk_level && RISK[row.risk_level]) {
    const r = RISK[row.risk_level];
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium" style={{ color: r.color, background: `${r.color}1f` }}>
        <span className="dot size-1.5" style={{ background: r.color }} />{r.label} · {Math.round((row.probability ?? 0) * 100)}%
      </span>
    );
  }
  const c = CONFIDENCE[row.confidence_level] ?? CONFIDENCE.nominal;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs" style={{ color: c.color, background: `${c.color}14` }}
      title="ML-модель не активна: показана достоверность обнаружения из FIRMS">
      <span className="dot size-1.5" style={{ background: c.color }} />{c.label}
    </span>
  );
}

export function DetectionTable({ rows, compact = false, detailsHref, selected }: {
  rows: DetectionRow[]; compact?: boolean; detailsHref?: (id: number) => string; selected?: number;
}) {
  if (!rows.length) {
    return <StateBox title="Нет обнаружений по этим условиям">Расширьте период или сбросьте фильтры.</StateBox>;
  }
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="data min-w-[720px]">
        <thead>
          <tr>
            <th>Наблюдение (UTC+5)</th><th>Координаты</th><th>Спутник</th>{!compact && <th>Регион</th>}
            <th className="text-right">FRP, МВт</th><th>Достоверность</th>{!compact && <th>День/ночь</th>}<th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="row" style={r.id === selected ? { background: "rgba(59,227,138,.08)" } : undefined}>
              <td className="mono">{dateTime(r.observed_at)}</td>
              <td className="mono text-fg2">{coord(r.latitude, r.longitude)}</td>
              <td className="text-fg2">{satLabel(r.satellite)}</td>
              {!compact && <td className="text-fg2">{r.region_name ?? "—"}</td>}
              <td className="mono text-right">{dec(r.frp_mw)}</td>
              <td><AssessmentBadge row={r} /></td>
              {!compact && <td className="text-fg2">{r.daynight === "D" ? "день" : "ночь"}</td>}
              <td className="text-right">
                <Link href={detailsHref ? detailsHref(r.id) : `/detections/${r.id}`} scroll={!detailsHref}
                  aria-label={detailsHref ? `Открыть панель деталей #${r.id}` : undefined} className="text-xs no-underline">Детали →</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
