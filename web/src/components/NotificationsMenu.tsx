"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Notification } from "@/lib/data";
import { ago } from "@/lib/format";

const KEY = "fw.notifications.read";
const COLOR: Record<Notification["kind"], string> = { risk: "#FF4D5E", hotspot: "#FF7A3D", source: "#F2C14E", run: "#F2C14E" };
const idOf = (n: Notification) => `${n.kind}|${n.title}|${n.at ?? ""}`;

// Read marks are a per-browser convenience only; storage may be unavailable (private mode).
const listeners = new Set<() => void>();
function readMarks(): string {
  try { return window.localStorage.getItem(KEY) ?? "[]"; } catch { return "[]"; }
}
function writeMarks(ids: string[]) {
  try { window.localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* not persisted */ }
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function NotificationsMenu({ items }: { items: Notification[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const raw = useSyncExternalStore(subscribe, readMarks, () => "[]");
  let marks: string[] = [];
  try { marks = JSON.parse(raw) as string[]; } catch { marks = []; }
  const read = new Set(marks);
  const unread = items.filter((n) => !read.has(idOf(n))).length;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button type="button" aria-label={`Уведомления${unread ? `: ${unread} новых` : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="btn relative size-[42px] p-0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="mono absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#FF4D5E] px-1 text-[10px] text-white">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Уведомления" className="glass2 rise absolute right-0 top-[50px] z-40 flex w-[340px] max-w-[calc(100vw-32px)] flex-col gap-2 rounded-[20px] p-3">
          <div className="flex items-center justify-between px-1.5 pt-1">
            <span className="text-sm font-semibold">Уведомления</span>
            {items.length > 0 && (
              <button type="button" className="text-xs text-fg2 hover:text-fg" onClick={() => writeMarks(items.map(idOf))}>Отметить прочитанными</button>
            )}
          </div>
          {items.length ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {items.map((n) => (
                <li key={idOf(n)}>
                  <Link href={n.href} onClick={() => setOpen(false)}
                    className="row flex gap-3 rounded-xl px-2 py-2 text-fg no-underline" style={{ opacity: read.has(idOf(n)) ? 0.6 : 1 }}>
                    <span className="dot mt-1.5" style={{ background: COLOR[n.kind] }} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px]">{n.title}</span>
                      <span className="text-[11px] text-muted">{n.detail}{n.at ? ` · ${ago(n.at)}` : ""}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 px-1.5 pb-1.5 text-xs leading-relaxed text-muted">
              Событий нет: за 24 ч нет обнаружений с высоким риском, растущих очагов и задержек источников.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
