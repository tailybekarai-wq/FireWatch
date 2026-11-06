// Interface languages. Russian strings are the keys; Kazakh and English dictionaries map
// them to translations (lib/dict.kk.ts, lib/dict.en.ts). A missing entry falls back to
// Russian, so an untranslated string stays readable instead of breaking the page.
import { EN } from "./dict.en";
import { KK } from "./dict.kk";

export const LOCALES = ["ru", "kk", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ru";
export const LOCALE_COOKIE = "fw-lang";
export const LOCALE_LABEL: Record<Locale, string> = { ru: "RU", kk: "KZ", en: "EN" };
export const LOCALE_NAME: Record<Locale, string> = { ru: "Русский", kk: "Қазақша", en: "English" };
/** BCP 47 tags for <html lang>. */
export const LOCALE_TAG: Record<Locale, string> = { ru: "ru", kk: "kk", en: "en" };

const DICTS: Record<Locale, Record<string, string> | null> = { ru: null, kk: KK, en: EN };

export type T = (ru: string, vars?: Record<string, string | number>) => string;

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** Translator for a locale: t("{n} обнаружений", { n: 5 }). */
export function translator(locale: Locale): T {
  const dict = DICTS[locale];
  return (ru, vars) => {
    let s = dict?.[ru] ?? ru;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

export type RegionNames = { id: number; name_ru: string | null; name_kk: string | null; name_en: string | null };

/** Region name in the interface language (the regions table holds all three). */
export function regionLabel(r: Omit<RegionNames, "id"> | null | undefined, locale: Locale): string | null {
  if (!r) return null;
  const own = locale === "kk" ? r.name_kk : locale === "en" ? r.name_en : r.name_ru;
  return own ?? r.name_ru ?? r.name_kk ?? r.name_en ?? null;
}
