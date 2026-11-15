"use client";

import type { ProjectGitResponse } from "@commander/contracts";
import { useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { useTrackedCommand } from "@/components/control/useControl";
import { formatRelative } from "@/lib/format";
import { PR_STATE_TEXT, ciBadge, gitErrorText, pickCi, prBlockReason } from "@/lib/git-view";
import { useNow } from "@/lib/use-now";
import { OpenPrDialog } from "./OpenPrDialog";
import { useGitApi } from "./useGit";

/** Loyiha sahifasi: CI holati (nishon), ochiq PR'lar va "PR ochish". CI avto yangilanadi (5 daqiqa); "Yangilash" = hozir. */
export function GitSection({ projectId, branch, git }: { projectId: string; branch: string | null; git: ProjectGitResponse | null }) {
  const { canControl, lockdown } = useLiveData();
  const api = useGitApi();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const [cmdId, setCmdId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cmd = useTrackedCommand(cmdId);
  const block = prBlockReason({ canControl, lockdown, hasProject: true });
  const ci = git ? pickCi(git.ci, branch) : null;
  const badge = ci ? ciBadge(ci.state) : null;
  const checking = !!cmd && !["done", "failed", "expired", "rejected"].includes(cmd.status);
  const failedChecks = ci?.checks.filter((c) => c.bucket === "fail") ?? [];

  async function refresh() {
    setError(null);
    try {
      const c = await api.refreshCi(projectId, ci?.branch ?? branch ?? undefined);
      setCmdId(c.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xatolik");
    }
  }

  return (
    <section className="card flex flex-col gap-3 p-4" aria-label="Git va PR" data-testid="git-section">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 flex-1 text-sm font-semibold">PR va CI</h2>
        {badge && (
          <span className={`pill ${badge.cls}`} data-testid="ci-badge" data-state={ci?.state} title={ci ? `${ci.branch}${ci.run?.name ? ` · ${ci.run.name}` : ""}` : undefined}>
            {badge.label}
          </span>
        )}
        <button type="button" className="btn" disabled={!!block || api.busy || checking} title={block ?? "CI holatini hozir so'rash (gh, faqat o'qish)"} onClick={() => void refresh()} data-testid="ci-refresh">
          {checking ? "So'ralmoqda…" : "CI yangilash"}
        </button>
        <button type="button" className="btn btn-pri" disabled={!!block} title={block ?? "Joriy branch'dan PR ochish"} onClick={() => setOpen(true)} data-testid="open-pr">
          PR ochish
        </button>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
          {error}
        </div>
      )}
      {cmd && (cmd.status === "failed" || cmd.status === "rejected") && (
        <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="ci-error">
          {gitErrorText(cmd.errorCode)}
        </div>
      )}
      {ci ? (
        <div className="flex flex-col gap-1 text-xs text-mu">
          <span suppressHydrationWarning>
            <span className="mono">{ci.branch}</span> · yangilangan {now ? formatRelative(Date.parse(ci.checkedAt) / 1000, now) : "…"}
          </span>
          {failedChecks.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="Muvaffaqiyatsiz tekshiruvlar">
              {failedChecks.slice(0, 5).map((c) => (
                <li key={c.name} className="text-red">
                  {c.link ? (
                    <a href={c.link} target="_blank" rel="noopener noreferrer">
                      {c.name}
                    </a>
                  ) : (
                    c.name
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <span className="text-xs text-mu">CI holati hali yo&apos;q: PR ochilgach har 5 daqiqada yangilanadi (gh kerak).</span>
      )}
      {git && git.prs.length > 0 ? (
        <ul className="m-0 flex list-none flex-col p-0" aria-label="PR'lar" data-testid="pr-list">
          {git.prs.slice(0, 8).map((p) => (
            <li key={p.id} className="flex items-center gap-2.5 border-t border-bd py-2">
              <a href={p.url} target="_blank" rel="noopener noreferrer" className="mono">
                #{p.number}
              </a>
              <span className="min-w-0 flex-1 truncate">{p.title || p.branch}</span>
              <span className="mono text-xs text-mu">
                {p.branch} → {p.base}
              </span>
              {p.draft && <span className="pill bg-gray-bg text-mu">draft</span>}
              <span className={`pill ${p.state === "open" ? "bg-blue-bg text-blue" : p.state === "merged" ? "bg-grn-bg text-grn" : "bg-gray-bg text-mu"}`}>{PR_STATE_TEXT[p.state]}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-xs text-mu">Commander orqali ochilgan PR yo&apos;q.</span>
      )}
      {open && <OpenPrDialog projectId={projectId} onClose={() => setOpen(false)} />}
    </section>
  );
}
