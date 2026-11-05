import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { Breadcrumb, Dock, MobileNav } from "@/components/Dock";
import { FreshnessBadge } from "@/components/ui";
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
        <div className="relative flex items-start">
          {/* usePathname() is request data: under Cache Components it must stream inside Suspense */}
          <Suspense fallback={<div className="m-4 mr-0 hidden w-[232px] shrink-0 md:block" />}>
            <Dock />
          </Suspense>
          <div className="flex min-w-0 flex-1 flex-col gap-5 px-3 pb-24 pt-4 md:px-6 md:pb-10 md:pl-5">
            <header className="glass flex min-h-16 flex-wrap items-center gap-3 rounded-[20px] py-2.5 pl-5 pr-3">
              <Suspense fallback={<span className="mr-auto text-[13px] text-muted">FireWatch</span>}>
                <Breadcrumb />
              </Suspense>
              <Suspense fallback={<span className="skeleton h-[42px] w-44" />}>
                <FreshnessBadge />
              </Suspense>
            </header>
            <main className="flex min-w-0 flex-col gap-5">{children}</main>
            <footer className="text-[11px] leading-relaxed text-muted">
              Данные: NASA FIRMS (LANCE) · Open-Meteo (CC BY 4.0) · границы © участники OpenStreetMap (ODbL).
              Спутниковое обнаружение — это термическая аномалия, а не подтверждённый пожар.
            </footer>
          </div>
        </div>
        <Suspense fallback={null}>
          <MobileNav />
        </Suspense>
      </body>
    </html>
  );
}
