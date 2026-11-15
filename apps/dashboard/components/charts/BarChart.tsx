import { formatTokens } from "@/lib/format";

export interface BarColumn {
  /** Tooltip (title). */
  title: string;
  /** Pastdan yuqoriga qatlamlar. */
  parts: { value: number; color: string }[];
}

/** 1, 2, 5, 10 qadamli "chiroyli" yuqori chegara. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
}

/**
 * Ustunli grafik (dizayn): CSS ustunlar, ikki chiziqli to'r, y-o'q yorliqlari, x-o'q yorliqlari.
 * Ustun ustiga olib borilsa `title` tooltip. Ekran o'qiydiganlar uchun `label` xulosasi.
 */
export function BarChart({ columns, height = 180, xLabels, label, yWidth = 36 }: { columns: BarColumn[]; height?: number; xLabels: string[]; label: string; yWidth?: number }) {
  const sums = columns.map((c) => c.parts.reduce((a, p) => a + p.value, 0));
  const max = niceMax(Math.max(0, ...sums));
  const gap = columns.length > 24 ? 2 : columns.length > 14 ? 4 : 6;
  return (
    <div className="flex gap-2.5" role="img" aria-label={label}>
      <div className="mono flex flex-col justify-between text-right text-[10px] text-fa" style={{ height, width: yWidth }} aria-hidden="true">
        <span>{formatTokens(max)}</span>
        <span>{formatTokens(max / 2)}</span>
        <span>0</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div
          className="flex items-end border-b border-bd"
          style={{ height, gap, backgroundImage: "linear-gradient(var(--bd) 1px, transparent 1px)", backgroundSize: `100% ${height / 2}px` }}
        >
          {columns.map((c, i) => (
            <div key={i} title={c.title} className="flex h-full min-w-0 flex-1 flex-col-reverse justify-start gap-px hover:opacity-80">
              {c.parts.map((p, k) =>
                p.value > 0 ? <div key={k} style={{ height: `${Math.max(1, (p.value / max) * height)}px`, background: p.color, flex: "none", borderRadius: k === c.parts.length - 1 ? "3px 3px 0 0" : 0 }} /> : null,
              )}
            </div>
          ))}
        </div>
        <div className="mono flex justify-between text-[10px] text-fa" aria-hidden="true">
          {xLabels.map((x, i) => (
            <span key={i}>{x}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
