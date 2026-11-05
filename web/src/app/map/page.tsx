import type { Metadata } from "next";
import { Suspense } from "react";
import { FireMap } from "@/components/FireMap";
import { Skeleton, StateBox } from "@/components/ui";
import { getRegions } from "@/lib/data";

export const metadata: Metadata = { title: "Карта пожаров" };

export default function MapPage() {
  return (
    <Suspense fallback={<Skeleton h={620} />}>
      <MapWithRegions />
    </Suspense>
  );
}

async function MapWithRegions() {
  const regions = await getRegions().catch(() => null);
  if (!regions) {
    return <StateBox tone="error" title="Не удалось загрузить список регионов">База данных недоступна.</StateBox>;
  }
  return <FireMap regions={regions} />;
}
