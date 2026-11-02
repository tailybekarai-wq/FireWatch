// Placeholder until stage 7: shows project status only, never observation data.
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">FireWatch</h1>
        <p className="text-foreground/70">
          Система раннего обнаружения лесных пожаров в Казахстане по спутниковым данным. Идёт
          разработка: подключение источников данных запланировано на этап 3.
        </p>
        <p className="text-sm text-foreground/50">
          Данные на этой странице не отображаются, пока не подключён реальный источник.
        </p>
      </div>
    </main>
  );
}
