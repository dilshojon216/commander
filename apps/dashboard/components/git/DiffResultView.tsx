"use client";

import type { DiffResponse } from "@commander/contracts";
import { useState } from "react";
import { FILE_STATUS_LABEL, diffSummaryText } from "@/lib/git-view";
import { FilePatch } from "./DiffPanel";

/**
 * Tayyor `DiffResponse` ko'rinishi (fayllar ro'yxati + patch): loyiha diff'i uchun (checkpoint bilan solishtirish).
 * `DiffPanel` sessiya diff'ini o'zi oladi; bu esa faqat chizadi. Matn FAQAT React matn tuguni sifatida (`FilePatch`).
 */
export function DiffResultView({ data }: { data: DiffResponse }) {
  const [selected, setSelected] = useState<string | null>(null);
  const files = data.diff.files;
  const cur = files.find((f) => f.path === selected) ?? files[0] ?? null;
  return (
    <div className="flex flex-col gap-2" data-testid="diff-result">
      <span className="mono text-xs text-mu">
        {diffSummaryText(data.diff)}
        {data.diff.truncated ? " · diff qisqartirilgan (hajm chegarasi)" : ""}
      </span>
      {files.length === 0 ? (
        <div className="card p-4 text-center text-mu">Checkpointdan beri kuzatiladigan fayllarda o&apos;zgarish yo&apos;q.</div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-start gap-4">
          <ul className="card m-0 flex max-h-[420px] list-none flex-col overflow-y-auto p-1" aria-label="O'zgargan fayllar">
            {files.map((f) => (
              <li key={f.path}>
                <button type="button" onClick={() => setSelected(f.path)} aria-current={f.path === cur?.path} className={`flex w-full items-baseline gap-2 rounded-md border-0 px-2 py-1.5 text-left text-xs ${f.path === cur?.path ? "bg-s3" : "bg-transparent hover:bg-s2"}`} style={{ cursor: "pointer", font: "inherit" }} title={`${FILE_STATUS_LABEL[f.status]}${f.oldPath ? ` (${f.oldPath})` : ""}`}>
                  <span className="mono min-w-0 flex-1 truncate" dir="rtl">
                    {f.path}
                  </span>
                  {f.binary ? (
                    <span className="text-mu">binar</span>
                  ) : (
                    <>
                      <span className="mono text-grn">+{f.additions ?? 0}</span>
                      <span className="mono text-red">−{f.deletions ?? 0}</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="card min-w-0 overflow-hidden" style={{ gridColumn: "span 2" }}>
            {cur ? <FilePatch file={cur} /> : null}
          </div>
        </div>
      )}
    </div>
  );
}
