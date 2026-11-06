"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, LOCALE_TAG, translator, type Locale, type T } from "@/lib/i18n";

const I18n = createContext<{ locale: Locale; t: T }>({ locale: DEFAULT_LOCALE, t: translator(DEFAULT_LOCALE) });

/** Interface language for client components (the server passes the cookie value). */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: translator(locale) }), [locale]);
  useEffect(() => { document.documentElement.lang = LOCALE_TAG[locale]; }, [locale]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export function useI18n() {
  return useContext(I18n);
}
