"use client";

import { useI18n } from "./I18nProvider";

/** Satellite / scheme switch shown over a map. */
export function BasemapToggle({ satellite, onChange, className = "" }: {
  satellite: boolean; onChange: (v: boolean) => void; className?: string;
}) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t("Подложка карты")} className={`glass flex rounded-[12px] p-1 text-xs ${className}`}>
      {([true, false] as const).map((v) => (
        <button key={String(v)} type="button" aria-pressed={satellite === v} onClick={() => onChange(v)}
          className="h-7 rounded-[9px] px-2.5 font-medium transition-colors"
          style={{ background: satellite === v ? "rgba(255,255,255,.12)" : "transparent", color: satellite === v ? "#EEF3F6" : "#9DAAB5" }}>
          {v ? t("Спутник") : t("Схема")}
        </button>
      ))}
    </div>
  );
}
