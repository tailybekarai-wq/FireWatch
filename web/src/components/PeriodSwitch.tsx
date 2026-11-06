"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * Period tabs with a sliding indicator. The indicator moves on click (before the server
 * answers); `days` from the URL stays the source of truth once navigation completes.
 */
export function PeriodSwitch({ base, days, options = [1, 7, 30], extra = "" }: {
  base: string; days: number; options?: number[]; extra?: string;
}) {
  const [pending, setPending] = useState<{ from: number; to: number } | null>(null);
  const active = pending && pending.from === days ? pending.to : days;
  const index = Math.max(0, options.indexOf(active));
  const label = (d: number) => (d === 1 ? "24 ч" : `${d} дн`);
  return (
    <div role="group" aria-label="Период" className="glass relative grid rounded-[14px] p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <span aria-hidden="true" className="absolute bottom-1 left-1 top-1 rounded-[10px] transition-transform duration-500"
        style={{
          width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${index * 100}%)`,
          background: "rgba(255,255,255,.10)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.08)",
          transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
        }} />
      {options.map((d) => (
        <Link key={d} href={`${base}?days=${d}${extra}`} scroll={false} aria-current={d === active ? "true" : undefined}
          onClick={() => setPending({ from: days, to: d })}
          className="relative flex h-9 items-center justify-center rounded-[10px] px-4 text-[13px] font-medium no-underline outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-[#36D6E7]/60"
          style={{ color: d === active ? "#EEF3F6" : "#9DAAB5" }}>
          {label(d)}
        </Link>
      ))}
    </div>
  );
}
