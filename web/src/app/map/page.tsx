import type { Metadata } from "next";
import { Suspense } from "react";
import { FireMap } from "@/components/FireMap";
import { Skeleton, StateBox } from "@/components/ui";
import { getActiveModel, getFocus, getRegions } from "@/lib/data";
import { getRegionNamer, getT } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Карта пожаров" };

export default function MapPage({ searchParams }: PageProps<"/map">) {
  return (
    <Suspense fallback={<Skeleton h={620} />}>
      <MapWithRegions searchParams={searchParams} />
    </Suspense>
  );
}

async function MapWithRegions({ searchParams }: { searchParams: PageProps<"/map">["searchParams"] }) {
  const { t, locale } = await getT();
  const regionName = await getRegionNamer(locale);
  const sp = await searchParams;
  const focusId = Number(Array.isArray(sp.focus) ? sp.focus[0] : sp.focus);
  let regions, model, focus;
  try {
    [regions, model, focus] = await Promise.all([
      getRegions(),
      getActiveModel(),
      Number.isInteger(focusId) && focusId > 0 ? getFocus(focusId) : null,
    ]);
  } catch {
    return <StateBox tone="error" title={t("Не удалось загрузить карту")}>{t("База данных недоступна.")}</StateBox>;
  }
  return <FireMap regions={regions.map((r) => ({ id: r.id, name: regionName(r.id, r.name) ?? r.name }))} model={model ? model.version : null} focus={focus} />;
}
