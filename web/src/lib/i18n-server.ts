// Server side of the interface language: the choice lives in a cookie set by LanguageSwitch.
// cookies() is request data, so every caller renders inside the layout's Suspense boundary.
import { cookies } from "next/headers";
import { getRegionNames } from "./data";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, regionLabel, translator, type Locale, type T } from "./i18n";

export async function getLocale(): Promise<Locale> {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

export async function getT(): Promise<{ t: T; locale: Locale }> {
  const locale = await getLocale();
  return { t: translator(locale), locale };
}

export type RegionNamer = (id: number | null | undefined, fallback?: string | null) => string | null;

/** id -> region name in the current language. */
export async function getRegionNamer(locale: Locale): Promise<RegionNamer> {
  const names = new Map((await getRegionNames()).map((r) => [r.id, r]));
  return (id, fallback = null) => (id == null ? fallback : regionLabel(names.get(id), locale) ?? fallback);
}
