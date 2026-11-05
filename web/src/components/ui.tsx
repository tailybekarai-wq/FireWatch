import Link from "next/link";
import type { ReactNode } from "react";
import { getFreshness } from "@/lib/data";
import { ago, timeOnly } from "@/lib/format";

export function Panel({ title, sub, action, children, className = "", delay = 0 }: {
  title?: string; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; delay?: number;
}) {
  return (
    <section className={`glass rise flex min-w-0 flex-col gap-3.5 rounded-3xl p-5 ${className}`} style={{ animationDelay: `${delay}s` }}>
      {(title || action) && (
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            {title && <h2 className="m-0 text-lg font-semibold tracking-tight">{title}</h2>}
            {sub && <span className="text-xs text-muted">{sub}</span>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: string }) {
  return (
    <article className="glass lift rise flex flex-col gap-2.5 rounded-[20px] p-[18px]" style={accent ? { borderColor: accent } : undefined}>
      <span className="text-xs text-fg2">{label}</span>
      <span className="mono text-[28px] font-medium leading-none tracking-tight">{value}</span>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </article>
  );
}

export function StateBox({ tone = "empty", title, children, action }: {
  tone?: "empty" | "error" | "info"; title: string; children?: ReactNode; action?: ReactNode;
}) {
  const color = tone === "error" ? "#FF4D5E" : tone === "info" ? "#36D6E7" : "#7F8D99";
  return (
    <div role={tone === "error" ? "alert" : "status"} className="flex flex-col items-start gap-2 rounded-2xl border border-white/5 p-5"
      style={{ background: `${color}0d` }}>
      <span className="flex items-center gap-2 text-sm font-semibold"><span className="dot" style={{ background: color }} />{title}</span>
      {children && <span className="text-[13px] leading-relaxed text-fg2">{children}</span>}
      {action}
    </div>
  );
}

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton w-full" style={{ height: h }} aria-hidden="true" />;
}

export function PageHead({ eyebrow, title, sub, children }: { eyebrow: string; title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="rise flex flex-wrap items-end justify-between gap-5">
      <div className="flex max-w-2xl flex-col gap-3">
        <span className="eyebrow text-forest">{eyebrow}</span>
        <h1 className="m-0 text-4xl font-semibold leading-none tracking-[-0.045em] md:text-5xl">{title}</h1>
        {sub && <p className="m-0 text-[15px] leading-relaxed text-fg2">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

export function PeriodSwitch({ base, days, options = [1, 7, 30], extra = "" }: {
  base: string; days: number; options?: number[]; extra?: string;
}) {
  const label = (d: number) => (d === 1 ? "24 ч" : `${d} дн`);
  return (
    <div role="group" aria-label="Период" className="glass flex rounded-[14px] p-1">
      {options.map((d) => (
        <Link key={d} href={`${base}?days=${d}${extra}`} aria-current={d === days ? "true" : undefined}
          className="flex h-9 items-center rounded-[10px] px-4 text-[13px] font-medium no-underline"
          style={{ background: d === days ? "rgba(255,255,255,.10)" : "transparent", color: d === days ? "#EEF3F6" : "#9DAAB5" }}>
          {label(d)}
        </Link>
      ))}
    </div>
  );
}

/** Live indicator in the top bar: real time of the last successful FIRMS fetch. */
export async function FreshnessBadge() {
  let f;
  try {
    f = await getFreshness();
  } catch {
    return <span className="glass flex h-[42px] items-center gap-2 rounded-[13px] px-3.5 text-xs text-[#FF4D5E]">База недоступна</span>;
  }
  const stale = f.stale;
  const color = stale ? "#F2C14E" : "#36D6E7";
  return (
    <span title={`Последнее успешное обновление FIRMS: ${f.lastSuccess ? new Date(f.lastSuccess).toISOString() : "нет"}`}
      className="flex h-[42px] items-center gap-2.5 rounded-[13px] px-3.5 text-xs text-fg2"
      style={{ background: `${color}12`, border: `1px solid ${color}29` }}>
      <span className="relative size-2"><span className="absolute -inset-1 rounded-full border" style={{ borderColor: `${color}73` }} />
        <span className="absolute inset-0 rounded-full" style={{ background: color }} /></span>
      {stale ? "Данные устарели" : "Live"} · <span className="mono text-fg">{timeOnly(f.lastSuccess)}</span>
      <span className="hidden text-muted lg:inline">({ago(f.lastSuccess)})</span>
    </span>
  );
}

export async function StaleBanner() {
  let f;
  try { f = await getFreshness(); } catch { return null; }
  if (!f.stale) return null;
  return (
    <StateBox tone="info" title="Данные FIRMS не обновлялись более 3 часов">
      Последнее успешное обновление: {f.lastSuccess ? `${timeOnly(f.lastSuccess)} (${ago(f.lastSuccess)})` : "ещё не было"}.
      Цифры ниже показаны как есть, без подстановок. Подробности на странице <Link href="/sources">Источники</Link>.
    </StateBox>
  );
}
