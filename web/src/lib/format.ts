// Formatting helpers. Times are stored in UTC; Kazakhstan has used a single UTC+5 zone
// since 2024-03-01, so local time is rendered through tzdata (Asia/Almaty), not a fixed offset.
export const TZ = "Asia/Almaty";

const nf = new Intl.NumberFormat("ru-RU");
export const num = (n: number | null | undefined) => (n == null ? "—" : nf.format(n));
export const dec = (n: number | null | undefined, digits = 1) =>
  n == null ? "—" : n.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const coord = (lat: number, lon: number) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

export function dateTime(value: Date | string | null | undefined, utc = false) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ru-RU", {
    timeZone: utc ? "UTC" : TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeOnly(value: Date | string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

type Tr = (ru: string, vars?: Record<string, string | number>) => string;
const asIs: Tr = (ru, vars) => (vars ? Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), ru) : ru);

/** "5 мин назад"; pass the interface translator to localise. */
export function ago(value: Date | string | null | undefined, t: Tr = asIs, now = new Date()) {
  if (!value) return t("нет данных");
  const minutes = Math.round((now.getTime() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return t("только что");
  if (minutes < 60) return t("{n} мин назад", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("{n} ч назад", { n: hours });
  return t("{n} дн назад", { n: Math.round(hours / 24) });
}

export const SATELLITES: Record<string, { label: string; color: string }> = {
  N20: { label: "VIIRS · NOAA-20", color: "#36D6E7" },
  N21: { label: "VIIRS · NOAA-21", color: "#8FB0FF" },
  N: { label: "VIIRS · Suomi NPP", color: "#3BE38A" },
  Terra: { label: "MODIS · Terra", color: "#C49BFF" },
  Aqua: { label: "MODIS · Aqua", color: "#9DAAB5" },
};
export const satLabel = (code: string) => SATELLITES[code]?.label ?? code;

// Without an active ML model, markers show the FIRMS detection confidence in the
// "observation" (cyan) family; ML risk colours are reserved for model estimates.
export const CONFIDENCE: Record<string, { label: string; color: string }> = {
  high: { label: "Высокая", color: "#8BEAF4" },
  nominal: { label: "Номинальная", color: "#36D6E7" },
  low: { label: "Низкая", color: "#5F7F8C" },
};
export const RISK: Record<string, { label: string; color: string }> = {
  very_high: { label: "Критический", color: "#FF4D5E" },
  high: { label: "Высокий", color: "#FF7A3D" },
  moderate: { label: "Повышенный", color: "#F2C14E" },
  low: { label: "Низкий", color: "#8A97A2" },
};
export const NO_SCORE = { label: "Нет оценки", color: "#5C6873" };

/** Model features in plain words (names match firewatch_ml.features.FEATURES). */
export const FEATURE_LABELS: Record<string, string> = {
  frp_mw: "мощность излучения (FRP)",
  bright_ti4: "яркостная температура TI4",
  bright_ti5: "яркостная температура TI5",
  ti4_minus_ti5: "разность TI4 − TI5",
  confidence: "достоверность FIRMS",
  is_night: "ночное наблюдение",
  scan_km: "размер пикселя (scan)",
  track_km: "размер пикселя (track)",
  solar_hour: "местное солнечное время",
  doy_sin: "сезон (день года)",
  doy_cos: "сезон (день года)",
  n_1km_24h: "соседи в 1 км за 24 ч",
  n_1km_72h: "соседи в 1 км за 72 ч",
  n_5km_24h: "соседи в 5 км за 24 ч",
  n_5km_72h: "соседи в 5 км за 72 ч",
  frp_5km_72h: "FRP соседей в 5 км за 72 ч",
  persist_500m_365d: "постоянный источник в этой точке (за год)",
};

/** NASA FIRMS Fire Map centred on a point for the day of observation (UTC). */
export function firmsMapUrl(lat: number, lon: number, at: string) {
  const day = new Date(at).toISOString().slice(0, 10);
  return `https://firms.modaps.eosdis.nasa.gov/map/#d:${day};@${lon.toFixed(4)},${lat.toFixed(4)},12.0z`;
}

const DIRS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];
export const windDir = (deg: number | null | undefined) => (deg == null ? "—" : DIRS[Math.round(deg / 45) % 8]);
export const kmhToMs = (v: number | null | undefined) => (v == null ? null : v / 3.6);
