"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALES, LOCALE_COOKIE, LOCALE_LABEL, LOCALE_NAME } from "@/lib/i18n";
import { useI18n } from "./I18nProvider";

/** RU / KZ / EN. Stores the choice in a cookie for a year and re-renders on the server. */
export function LanguageSwitch() {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const index = LOCALES.indexOf(locale);
  return (
    <div role="group" aria-label={t("Язык интерфейса")} className="glass relative grid h-[42px] grid-cols-3 rounded-[13px] p-1"
      style={{ opacity: pending ? 0.7 : 1 }}>
      <span aria-hidden="true" className="absolute bottom-1 left-1 top-1 rounded-[10px] transition-transform duration-500"
        style={{ width: "calc((100% - 8px) / 3)", transform: `translateX(${index * 100}%)`, background: "rgba(255,255,255,.10)",
          transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)" }} />
      {LOCALES.map((l) => (
        <button key={l} type="button" lang={l} title={LOCALE_NAME[l]} aria-pressed={l === locale}
          onClick={() => {
            if (l === locale) return;
            document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
            start(() => router.refresh());
          }}
          className="mono relative px-2.5 text-[11px] font-medium transition-colors"
          style={{ color: l === locale ? "#EEF3F6" : "#9DAAB5" }}>
          {LOCALE_LABEL[l]}
        </button>
      ))}
    </div>
  );
}
