// Dependency-free SVG charts in the Thermal Glass style. They only draw the numbers
// they are given; an all-zero series renders as a flat line, never an invented shape.
import { num, SATELLITES } from "@/lib/format";

export function AreaChart({ values, labels, color = "#3BE38A", height = 220 }: {
  values: number[]; labels: string[]; color?: string; height?: number;
}) {
  const w = 600;
  const h = 200;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [i * step, h - (v / max) * (h - 16) - 4] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const id = `g${color.slice(1)}`;
  const ticks = [0, Math.floor(labels.length / 4), Math.floor(labels.length / 2), Math.floor((3 * labels.length) / 4), labels.length - 1];
  return (
    <figure className="m-0 flex flex-col gap-2">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img"
        aria-label={`График: максимум ${num(max)}, всего ${num(values.reduce((a, b) => a + b, 0))}`}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".25" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        <g stroke="rgba(255,255,255,.05)"><path d={`M0 ${h * 0.25}h${w}M0 ${h * 0.5}h${w}M0 ${h * 0.75}h${w}`} /></g>
        {pts.length > 0 && <path d={`${line} L${w} ${h} L0 ${h}Z`} fill={`url(#${id})`} />}
        <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {values.map((v, i) => (
          <rect key={i} x={i * step - step / 2} y={0} width={step} height={h} fill="transparent">
            <title>{`${labels[i]}: ${num(v)}`}</title>
          </rect>
        ))}
      </svg>
      <figcaption className="mono flex justify-between text-[11px] text-muted">
        {[...new Set(ticks)].map((t) => <span key={t}>{labels[t]}</span>)}
      </figcaption>
    </figure>
  );
}

export function HBars({ rows, color = "#36D6E7", limit = 10 }: { rows: { label: string; n: number; href?: string }[]; color?: string; limit?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {rows.slice(0, limit).map((r) => (
        <li key={r.label} className="flex flex-col gap-1 text-[13px]">
          <span className="flex justify-between gap-3">
            {r.href ? <a href={r.href} className="truncate text-fg no-underline">{r.label}</a> : <span className="truncate">{r.label}</span>}
            <span className="mono text-fg2">{num(r.n)}</span>
          </span>
          <span className="h-1.5 rounded-full bg-white/5"><span className="block h-full rounded-full" style={{ width: `${(r.n / max) * 100}%`, background: color, opacity: 0.75 }} /></span>
        </li>
      ))}
    </ul>
  );
}

export function OrbitRings({ rows }: { rows: { satellite: string; n: number }[] }) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="relative size-[200px] self-center">
        <svg viewBox="0 0 200 200" width="200" height="200" aria-hidden="true" style={{ transform: "rotate(-90deg)" }}>
          <g fill="none" strokeLinecap="round" strokeWidth="7">
            {rows.slice(0, 5).map((r, i) => {
              const radius = 92 - i * 14;
              const c = 2 * Math.PI * radius;
              const share = total ? r.n / total : 0;
              return (
                <g key={r.satellite}>
                  <circle cx="100" cy="100" r={radius} stroke="rgba(255,255,255,.05)" />
                  <circle cx="100" cy="100" r={radius} stroke={SATELLITES[r.satellite]?.color ?? "#9DAAB5"} strokeOpacity=".7"
                    strokeDasharray={`${(share * c).toFixed(1)} ${c.toFixed(1)}`} />
                </g>
              );
            })}
          </g>
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center text-[11px] text-muted">
          <span className="mono text-lg text-fg">{num(total)}</span>всего
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
        {rows.map((r) => (
          <li key={r.satellite} className="flex items-center gap-2 text-fg2">
            <span className="size-2 rounded-sm" style={{ background: SATELLITES[r.satellite]?.color ?? "#9DAAB5" }} />
            {SATELLITES[r.satellite]?.label ?? r.satellite}
            <span className="mono ml-auto text-fg">{num(r.n)} · {total ? Math.round((r.n / total) * 100) : 0}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VBars({ rows, color = "#FF7A3D" }: { rows: { label: string; n: number }[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="flex h-48 items-end gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-1 flex-col items-center gap-1.5" title={`${r.label}: ${num(r.n)}`}>
          <span className="mono text-[11px] text-fg2">{num(r.n)}</span>
          <span className="w-full rounded-t-md" style={{ height: `${Math.max(2, (r.n / max) * 140)}px`, background: color, opacity: 0.75 }} />
          <span className="mono text-[10px] text-muted">{r.label}</span>
        </div>
      ))}
    </div>
  );
}
