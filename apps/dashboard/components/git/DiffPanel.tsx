"use client";

import type { DiffFile, DiffResponse } from "@commander/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { BASE_SOURCE_TEXT, FILE_STATUS_LABEL, HIDDEN_TEXT, diffSummaryText, parsePatchLines } from "@/lib/git-view";
import { useGitApi } from "./useGit";

/**
 * Sessiya "Diff" tabi: fayllar ro'yxati (+/−) va unified diff ko'rinishi. Diff mashinadan imzolangan `project.diff` bilan olinadi
 * (redakt qilingan, kesilgan; maxfiy/binar fayl matni yo'q). Matn faqat React matn tugunlari sifatida chiqariladi (HTML emas).
 */
export function DiffPanel({ sessionId, active, blockReason }: { sessionId: string; active: boolean; blockReason: string | null }) {
  const api = useGitApi();
  const [data, setData] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const started = useRef(false);

  // Faqat promise callback'larida holat o'zgaradi (effekt ichida sinxron setState yo'q)
  const fetchDiff = useCallback(
    () =>
      api
        .diffSession(sessionId)
        .then((r) => {
          setData(r);
          setError(null);
          setSelected((cur) => (cur && r.diff.files.some((f) => f.path === cur) ? cur : (r.diff.files[0]?.path ?? null)));
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Xatolik"))
        .finally(() => setRefreshing(false)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );

  // Tab birinchi marta ochilganda yuklanadi (avtomatik qayta so'ralmaydi: har so'rov audit qilinadigan masofaviy buyruq)
  useEffect(() => {
    if (!active || started.current || blockReason) return;
    started.current = true;
    void fetchDiff();
  }, [active, blockReason, fetchDiff]);

  const loading = refreshing || (active && !blockReason && !data && !error);
  const load = () => {
    setRefreshing(true);
    setError(null);
    void fetchDiff();
  };

  const file = data?.diff.files.find((f) => f.path === selected) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-3 p-4 md:p-6" data-testid="diff-panel">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-sm font-semibold">O&apos;zgarishlar</h2>
        {data && <span className="mono text-xs text-mu">{diffSummaryText(data.diff)}</span>}
        <span className="flex-1" />
        <button type="button" className="btn" disabled={loading || !!blockReason} title={blockReason ?? "Mashinadan yangi diff olish (audit qilinadi)"} onClick={load} data-testid="diff-refresh">
          {loading ? "Olinmoqda…" : "Yangilash"}
        </button>
      </div>
      {blockReason && !data && (
        <div role="note" className="rounded-lg bg-org-bg px-3 py-2 text-xs text-org">
          {blockReason}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="diff-error">
          {error}
        </div>
      )}
      {loading && !data && <div className="sk h-40" aria-busy="true" />}
      {data && (
        <>
          <span className="text-xs text-mu">
            {BASE_SOURCE_TEXT[data.baseSource]}
            {data.diff.branch ? ` · ${data.diff.branch}` : ""}
            {data.diff.truncated ? " · diff qisqartirilgan (hajm chegarasi)" : ""}
          </span>
          {data.diff.files.length === 0 ? (
            <div className="card p-5 text-center text-mu">O&apos;zgarish yo&apos;q.</div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-start gap-4">
              <ul className="card m-0 flex max-h-[560px] list-none flex-col overflow-y-auto p-1" aria-label="O'zgargan fayllar" style={{ gridColumn: "span 1" }}>
                {data.diff.files.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => setSelected(f.path)}
                      aria-current={f.path === selected}
                      className={`flex w-full items-baseline gap-2 rounded-md border-0 px-2 py-1.5 text-left text-xs ${f.path === selected ? "bg-s3" : "bg-transparent hover:bg-s2"}`}
                      style={{ cursor: "pointer", font: "inherit" }}
                      title={`${FILE_STATUS_LABEL[f.status]}${f.oldPath ? ` (${f.oldPath})` : ""}`}
                    >
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
                {file ? <FilePatch file={file} /> : <p className="m-0 p-4 text-mu">Faylni tanlang.</p>}
              </div>
            </div>
          )}
          {data.diff.untrackedTotal > 0 && (
            <div className="flex flex-col gap-1" data-testid="untracked">
              <span className="lbl">Kuzatilmayotgan fayllar ({data.diff.untrackedTotal}): faqat nomlari</span>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {data.diff.untracked.slice(0, 50).map((p) => (
                  <li key={p} className="mono text-xs text-mu">
                    {p}
                  </li>
                ))}
                {data.diff.untrackedTotal > 50 && <li className="text-xs text-mu">… yana {data.diff.untrackedTotal - 50} ta</li>}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const KIND_CLASS: Record<string, string> = {
  add: "bg-grn-bg text-grn",
  del: "bg-red-bg text-red",
  hunk: "bg-blue-bg text-blue",
  meta: "text-fa",
  ctx: "text-tx",
};

export function FilePatch({ file }: { file: DiffFile }) {
  if (file.patch === null) {
    return (
      <div className="flex flex-col gap-1 p-4" data-testid="patch-hidden" data-reason={file.hidden ?? ""}>
        <span className="mono text-xs">{file.path}</span>
        <span className="text-mu">{file.hidden ? HIDDEN_TEXT[file.hidden] : "Matn mavjud emas."}</span>
      </div>
    );
  }
  const { lines, truncated } = parsePatchLines(file.patch);
  return (
    <div className="flex flex-col" data-testid="patch">
      <div className="flex items-center gap-2 border-b border-bd px-3 py-2 text-xs">
        <span className="mono min-w-0 flex-1 truncate">{file.path}</span>
        {(file.truncated || truncated) && <span className="text-yel">qisqartirilgan</span>}
      </div>
      <pre className="mono m-0 max-h-[560px] overflow-auto text-[12px] leading-[1.5]" style={{ tabSize: 4 }}>
        {lines.map((l, i) => (
          <div key={i} className={`flex whitespace-pre px-2 ${KIND_CLASS[l.kind]}`} data-kind={l.kind}>
            <span className="inline-block w-10 shrink-0 select-none pr-2 text-right text-fa">{l.oldNo ?? ""}</span>
            <span className="inline-block w-10 shrink-0 select-none pr-2 text-right text-fa">{l.newNo ?? ""}</span>
            <span>{l.text || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
