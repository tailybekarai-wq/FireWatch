import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense, type ReactNode } from "react";
import { Breadcrumb, Dock, MobileNav } from "@/components/Dock";
import { I18nProvider } from "@/components/I18nProvider";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { FreshnessBadge, Notifications } from "@/components/ui";
import { getT } from "@/lib/i18n-server";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin", "cyrillic"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "cyrillic"] });

export const metadata: Metadata = {
  title: { default: "FireWatch", template: "%s · FireWatch" },
  description: "Раннее обнаружение лесных пожаров в Казахстане по спутниковым данным NASA FIRMS.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" className={`${geist.variable} ${geistMono.variable} antialiased`}>
      <body className="relative min-h-screen overflow-x-hidden">
        <div aria-hidden="true" className="drift pointer-events-none fixed left-[18%] top-28 size-[760px] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(255,122,61,.12), rgba(255,122,61,0))" }} />
        <div aria-hidden="true" className="drift pointer-events-none fixed -right-48 top-[60vh] size-[820px] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(59,227,138,.07), rgba(59,227,138,0))", animationDelay: "-6s" }} />
        {/* The language comes from a cookie (request data), so the whole shell streams inside Suspense. */}
        <Suspense fallback={<ShellFallback />}>
          <Shell>{children}</Shell>
        </Suspense>
      </body>
    </html>
  );
}

function ShellFallback() {
  return (
    <div className="relative flex items-start">
      <div className="glass m-4 mr-0 hidden h-[calc(100vh-32px)] w-[232px] shrink-0 rounded-3xl md:block" />
      <div className="flex min-w-0 flex-1 flex-col gap-5 px-3 pt-4 md:px-6 md:pl-5">
        <div className="glass min-h-16 rounded-[20px]" />
        <div className="skeleton h-[420px]" />
      </div>
    </div>
  );
}

async function Shell({ children }: { children: ReactNode }) {
  const { t, locale } = await getT();
  return (
    <I18nProvider locale={locale}>
      <div className="relative flex items-start">
        <Dock />
        <div className="flex min-w-0 flex-1 flex-col gap-5 px-3 pb-24 pt-4 md:px-6 md:pb-10 md:pl-5">
          <header className="glass flex min-h-16 flex-wrap items-center gap-3 rounded-[20px] py-2.5 pl-5 pr-3">
            <Breadcrumb />
            <LanguageSwitch />
            <Suspense fallback={<span className="skeleton h-[42px] w-44" />}>
              <FreshnessBadge />
            </Suspense>
            <Suspense fallback={<span className="skeleton size-[42px]" />}>
              <Notifications />
            </Suspense>
          </header>
          <main className="flex min-w-0 flex-col gap-5">{children}</main>
          <footer className="text-[11px] leading-relaxed text-muted">
            {t("Данные: NASA FIRMS (LANCE) · Open-Meteo (CC BY 4.0) · границы © участники OpenStreetMap (ODbL).")}{" "}
            {t("Спутниковое обнаружение — это термическая аномалия, а не подтверждённый пожар.")}
          </footer>
        </div>
      </div>
      <MobileNav />
    </I18nProvider>
  );
}
