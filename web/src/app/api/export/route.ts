// CSV export of real records with source attribution. Filters are validated and bound.
import { type NextRequest } from "next/server";
import { EXPORT_LIMIT, RISK_FILTERS, getExportRows, type RiskFilter } from "@/lib/data";

const SATELLITES = new Set(["N20", "N21", "N", "Terra", "Aqua"]);
const CONFIDENCE = new Set(["low", "nominal", "high"]);
const COLUMNS = [
  "id", "observed_at_utc", "latitude", "longitude", "satellite", "instrument", "frp_mw",
  "confidence_level", "confidence_raw", "daynight", "region", "source", "product_version",
  "cluster_id", "ml_probability", "ml_risk_level", "ml_model_version",
] as const;

function cell(v: unknown): string {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const int = (k: string) => { const n = Number(sp.get(k)); return Number.isInteger(n) && n > 0 ? n : 0; };
  const pick = (k: string, allowed: Set<string>) => { const v = sp.get(k) ?? ""; return allowed.has(v) ? v : undefined; };
  let name: string;
  let rows;
  try {
    if (int("cluster")) {
      name = `hotspot_${int("cluster")}`;
      rows = await getExportRows({ cluster: int("cluster") });
    } else if (int("id")) {
      name = `detection_${int("id")}`;
      rows = await getExportRows({ id: int("id") });
    } else {
      const days = Math.min(Math.max(int("days") || 7, 1), 366);
      const risk = sp.get("risk") ?? "";
      name = `detections_${days}d`;
      rows = await getExportRows({
        days,
        satellite: pick("sat", SATELLITES),
        confidence: pick("conf", CONFIDENCE),
        region: int("region") || undefined,
        risk: risk in RISK_FILTERS ? (risk as RiskFilter) : undefined,
      });
    }
  } catch (error) {
    console.error("GET /api/export failed", error);
    return new Response("database_unavailable\n", { status: 503 });
  }
  const lines = [
    "# FireWatch export. Source: NASA FIRMS (LANCE), https://firms.modaps.eosdis.nasa.gov/ ;"
      + " ML columns are model estimates, not confirmed fires.",
    `# Generated ${new Date().toISOString()} · rows ${rows.length}${rows.length >= EXPORT_LIMIT ? ` (limited to ${EXPORT_LIMIT})` : ""}`,
    COLUMNS.join(","),
    ...rows.map((r) => [
      r.id, r.observed_at, r.latitude, r.longitude, r.satellite, r.instrument, r.frp_mw,
      r.confidence_level, r.confidence_raw, r.daynight, r.region_name, r.source_code, r.product_version,
      r.cluster_id, r.probability, r.risk_level, r.model_version,
    ].map(cell).join(",")),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
