import Link from "next/link";
import { partProgressRows } from "@/lib/parts-view";
import type { ProjectPartDto } from "@commander/contracts";

/** Ko'p qismli loyiha: qismlar bo'yicha ixcham progress ro'yxati (nom, bajarilgan/jami, foiz, ish maydonidagi tab'ga havola). */
export function PartsProgressCard({ projectId, parts }: { projectId: string; parts: readonly ProjectPartDto[] }) {
  const rows = partProgressRows(parts);
  const done = rows.reduce((a, r) => a + r.done, 0);
  const total = rows.reduce((a, r) => a + r.total, 0);
  return (
    <section className="card flex flex-col overflow-hidden" aria-label="Reja (qismlar)" data-testid="parts-progress">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <h2 className="m-0 flex-1 text-sm font-semibold">Reja · {rows.length} qism</h2>
        <span className="text-xs text-mu">
          {done} / {total} bajarildi
        </span>
        <Link href={`/projects/${projectId}/work`} className="text-xs">
          Ish maydoni →
        </Link>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((r) => (
          <li key={r.part || "__root"} className="border-t border-bd">
            <Link href={`/projects/${projectId}/work${r.hrefSuffix}`} className="flex items-center gap-3 px-4 py-2 text-tx hover:bg-s2 hover:no-underline" data-testid="parts-progress-row">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.name}</span>
              <span className="mono w-[84px] text-right text-xs text-mu">{r.total === 0 ? "—" : `${r.done}/${r.total}`}</span>
              <span className="h-1.5 w-24 overflow-hidden rounded bg-s3" aria-hidden="true">
                <span className="block h-full bg-grn" style={{ width: `${r.pct ?? 0}%` }} />
              </span>
              <span className="mono w-10 text-right text-xs text-mu">{r.pct === null ? "—" : `${r.pct}%`}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
