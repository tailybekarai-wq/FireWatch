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

export function ago(value: Date | string | null | undefined, now = new Date()) {
  if (!value) return "нет данных";
  const minutes = Math.round((now.getTime() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
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
