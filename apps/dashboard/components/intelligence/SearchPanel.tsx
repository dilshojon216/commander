"use client";

import { SummarySearchResponseSchema } from "@commander/contracts";
import type { SummarySearchHit } from "@commander/contracts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { HeadlineText } from "@/components/intelligence/HeadlineText";
import { useLiveData } from "@/components/LiveData";
import { EmptyState } from "@/components/ui/States";
import { ApiCallError, getJson } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { machineLabel } from "@/lib/machines";
import { MIN_QUERY_CHARS, SEARCH_DEBOUNCE_MS, buildHitView, buildSearchPath, normalizeQuery, searchErrorText } from "@/lib/search-view";

/** Xulosalar bo'yicha qidiruv: debounce (350 ms), kamida 2 belgi, loyiha/mashina filtri. */
export function SearchPanel() {
  const { projects, machines } = useLiveData();
  const [raw, setRaw] = useState("");
  const [project, setProject] = useState("");
  const [machine, setMachine] = useState("");
  const [hits, setHits] = useState<SummarySearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = normalizeQuery(raw);

  useEffect(() => {
    if (q === null) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      getJson(buildSearchPath(q, { project, machine }), SummarySearchResponseSchema, ctl.signal)
        .then((r) => {
          setHits(r.items);
          setError(null);
        })
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return;
          setError(e instanceof ApiCallError ? searchErrorText(e.status) : searchErrorText(0));
        })
        .finally(() => {
          if (!ctl.signal.aborted) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, project, machine]);

  const views = useMemo(() => (q === null || !hits ? [] : hits.map((h) => ({ hit: h, view: buildHitView(h) }))), [q, hits]);

  return (
    <section className="flex flex-col gap-3" aria-label="Qidiruv">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          className="field min-w-[220px] flex-1"
          placeholder="Sessiya xulosalaridan qidiring…"
          aria-label="Xulosalardan qidirish"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          maxLength={200}
          data-testid="search-input"
        />
        <select className="field" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Loyiha filtri">
          <option value="">Barcha loyihalar</option>
          {(projects?.items ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className="field" value={machine} onChange={(e) => setMachine(e.target.value)} aria-label="Mashina filtri">
          <option value="">Barcha mashinalar</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {machineLabel(m)}
            </option>
          ))}
        </select>
      </div>

      {q === null && <span className="text-xs text-mu">Kamida {MIN_QUERY_CHARS} belgi kiriting.</span>}
      {q !== null && error && (
        <span role="alert" className="text-xs text-red">
          {error}
        </span>
      )}
      {q !== null && loading && <span className="text-xs text-mu">Qidirilmoqda…</span>}
      {q !== null && !loading && !error && hits !== null && views.length === 0 && <EmptyState title="Hech narsa topilmadi">Boshqa so&apos;z yoki filtrni sinab ko&apos;ring.</EmptyState>}

      {views.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="search-results">
          {views.map(({ view }) => (
            <li key={view.key} className="card flex flex-col gap-1.5 p-3.5">
              <Link href={view.href} className="text-sm text-tx hover:no-underline" data-testid="search-hit">
                <HeadlineText segments={view.segments} />
              </Link>
              <div className="flex flex-wrap items-center gap-1.5">
                {view.chips.map((c, i) => (
                  <span key={`${i}:${c}`} className="pill bg-s3 text-mu">
                    {c}
                  </span>
                ))}
                <span className="mono text-[11px] text-fa" suppressHydrationWarning>
                  {formatDateTime(view.createdAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
