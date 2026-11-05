"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV = [
  { href: "/", label: "Обзор", section: "Мониторинг", d: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" },
  { href: "/map", label: "Карта пожаров", section: "Мониторинг", d: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" },
  { href: "/detections", label: "Обнаружения", section: "Мониторинг", d: "M12 3c1.2 3.4 5 5.4 5 10a5 5 0 0 1-10 0c0-2.3 1-3.7 2.3-4.8 0 2 .9 3.3 2.3 3.3 0-3.5-1-5.8.4-8.5z" },
  { href: "/analytics", label: "Аналитика", section: "Анализ", d: "M4 20V11M10 20V5M16 20v-6M21 20H3" },
  { href: "/ml", label: "ML-модель", section: "Анализ", d: "M6 6h12v12H6zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4M10 10h4v4h-4z" },
  { href: "/sources", label: "Источники", section: "Система", d: "M4 5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" },
  { href: "/about", label: "О системе", section: "Система", d: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" },
];

export function activeNav(pathname: string) {
  return NAV.find((n) => (n.href === "/" ? pathname === "/" : pathname.startsWith(n.href))) ?? NAV[0];
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M16 4c6.6 0 12 5.2 12 11.6 0 6.8-5.6 12.4-12 12.4S4 22.4 4 15.6C4 9.2 9.4 4 16 4z" stroke="#3BE38A" strokeOpacity=".35" strokeWidth="1.2" />
      <path d="M16 8.5c4.3 0 7.8 3.3 7.8 7.4 0 4.4-3.6 7.8-7.8 7.8s-7.8-3.4-7.8-7.8c0-4.1 3.5-7.4 7.8-7.4z" stroke="#3BE38A" strokeOpacity=".6" strokeWidth="1.2" />
      <path d="M16 12.6c2 0 3.6 1.5 3.6 3.4 0 2.1-1.6 3.6-3.6 3.6s-3.6-1.5-3.6-3.6c0-1.9 1.6-3.4 3.6-3.4z" stroke="#FF7A3D" strokeWidth="1.4" />
      <circle cx="16" cy="16" r="1.6" fill="#FF7A3D" />
    </svg>
  );
}

export function Dock() {
  const pathname = usePathname();
  const active = activeNav(pathname);
  return (
    <nav aria-label="Основная навигация"
      className="glass sticky top-4 z-20 m-4 mr-0 hidden h-[calc(100vh-32px)] w-[232px] shrink-0 flex-col gap-1.5 rounded-3xl px-2.5 py-3.5 md:flex">
      <Link href="/" className="mb-2.5 flex h-[52px] items-center gap-3 px-1.5 text-fg no-underline hover:text-fg">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[13px] border border-white/10"
          style={{ background: "radial-gradient(circle at 50% 55%, rgba(255,122,61,.35), rgba(255,122,61,0) 70%), #0B1218" }}>
          <Logo />
        </span>
        <span className="flex flex-col">
          <span className="text-base font-semibold tracking-tight">FireWatch</span>
          <span className="text-[11px] text-muted">Спутниковый мониторинг</span>
        </span>
      </Link>
      {NAV.map((item) => {
        const on = item.href === active.href;
        return (
          <Link key={item.href} href={item.href} aria-current={on ? "page" : undefined}
            className="relative flex h-12 items-center gap-3 rounded-[14px] px-3 text-sm font-medium no-underline"
            style={{
              color: on ? "#EEF3F6" : "#9DAAB5",
              background: on ? "radial-gradient(120% 140% at 0% 50%, rgba(59,227,138,.20), rgba(59,227,138,.04) 70%)" : "transparent",
              boxShadow: on ? "inset 0 0 0 1px rgba(59,227,138,.22)" : "none",
            }}>
            <span className="absolute -left-2.5 top-3.5 h-5 w-[3px] rounded-r" style={{ background: on ? "#3BE38A" : "transparent" }} />
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: on ? "#3BE38A" : "#8C9AA6" }}>
              <path d={item.d} />
            </svg>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const active = activeNav(pathname);
  return (
    <nav aria-label="Навигация" className="glass2 fixed inset-x-3 bottom-3 z-30 flex justify-around rounded-2xl px-1 py-1.5 md:hidden">
      {NAV.slice(0, 5).map((item) => {
        const on = item.href === active.href;
        return (
          <Link key={item.href} href={item.href} aria-current={on ? "page" : undefined}
            className="flex min-w-14 flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[10px] no-underline"
            style={{ color: on ? "#3BE38A" : "#9DAAB5" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.d} /></svg>
            {item.label.split(" ")[0]}
          </Link>
        );
      })}
    </nav>
  );
}

export function Breadcrumb() {
  const item = activeNav(usePathname());
  return (
    <nav aria-label="Хлебные крошки" className="mr-auto flex items-center gap-2 text-[13px] text-muted">
      <Link href="/" className="text-muted no-underline">FireWatch</Link>
      <span aria-hidden="true">›</span>
      <span>{item.section}</span>
      <span aria-hidden="true">›</span>
      <span className="font-semibold text-fg">{item.label}</span>
    </nav>
  );
}
