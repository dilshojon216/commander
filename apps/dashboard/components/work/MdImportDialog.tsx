"use client";

import { MdFilesResponseSchema } from "@commander/contracts";
import type { MdExtractResponse, ProjectTaskDto } from "@commander/contracts";
import { useEffect, useMemo, useState } from "react";
import { CommandProgress } from "@/components/control/CommandProgress";
import { useCommandRunner, useTrackedCommand } from "@/components/control/useControl";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose } from "@/components/ui/icons";
import { getJson } from "@/lib/client-api";
import { commandProgress } from "@/lib/control-ui";
import { SIZE_CHOICES, buildAppendBody, initEdits, resuggestKeys, validateEdits } from "@/lib/work-view";
import type { CandidateEdit } from "@/lib/work-view";
import { useWorkApi } from "./useWorkApi";

const NEW_PHASE = "__new__";

/** ".md fayldan vazifalar": fayl -> nomzodlar (tahrirlanadi) -> TASKS.md'ga qo'shish (buyruq jarayoni bilan). */
export function MdImportDialog({ projectId, tasks, writeReason, onClose, onDone, onRefresh }: { projectId: string; tasks: ProjectTaskDto[]; writeReason: string | null; onClose: () => void; onDone: () => void; onRefresh: () => void }) {
  const api = useWorkApi(projectId);
  const runner = useCommandRunner();
  const [files, setFiles] = useState<string[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [resp, setResp] = useState<MdExtractResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<CandidateEdit[]>([]);
  const [phaseSel, setPhaseSel] = useState("");
  const [newPhase, setNewPhase] = useState("");
  const [cmdId, setCmdId] = useState<string | null>(null);
  const cmd = useTrackedCommand(cmdId);

  useEffect(() => {
    const ctl = new AbortController();
    getJson(`/projects/${projectId}/md-files`, MdFilesResponseSchema, ctl.signal)
      .then((r) => {
        setFiles(r.files);
        setPath((p) => p || (r.files.includes("docs/DESIGN-BRIEF.md") ? "docs/DESIGN-BRIEF.md" : (r.files[0] ?? "")));
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setFilesError(e instanceof Error ? e.message : "Xatolik");
      });
    return () => ctl.abort();
  }, [projectId]);

  const phase = phaseSel === NEW_PHASE ? newPhase : phaseSel;
  const existingKeys = useMemo(() => tasks.map((t) => t.key), [tasks]);
  const issues = useMemo(() => validateEdits(edits, existingKeys), [edits, existingKeys]);
  const body = useMemo(() => (phase.trim() ? buildAppendBody(phase, edits) : null), [phase, edits]);
  const selected = edits.filter((e) => e.include).length;
  const progress = cmd ? commandProgress(cmd) : null;
  const sending = api.busy || (cmd && progress?.phase !== "failed" && progress?.phase !== "done");

  useEffect(() => {
    if (cmd?.status === "done") onDone();
  }, [cmd?.status, onDone]);

  async function extract() {
    if (!path) return;
    setExtracting(true);
    setError(null);
    setResp(null);
    try {
      const r = await api.extract(path);
      setResp(r);
      const ph = r.suggestedPhase ?? r.phases[r.phases.length - 1] ?? "";
      setPhaseSel(ph || NEW_PHASE);
      const base = initEdits(r, []);
      setEdits(resuggestKeys(base, tasks, ph || null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xatolik");
    } finally {
      setExtracting(false);
    }
  }

  function changePhase(v: string) {
    setPhaseSel(v);
    setEdits((es) => resuggestKeys(es, tasks, v === NEW_PHASE ? null : v));
  }

  const patch = (i: number, p: Partial<CandidateEdit>) => setEdits((es) => es.map((e, k) => (k === i ? { ...e, ...p } : e)));

  async function submit() {
    if (!body) return;
    setError(null);
    try {
      const c = await api.append(body);
      setCmdId(c.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xatolik");
    }
  }

  const issueAt = (i: number) => issues.find((x) => x.index === i)?.message;
  const changed = cmd?.errorCode === "tasks_md_changed";

  return (
    <Dialog labelledBy="md-title" onClose={onClose} maxWidth={820} top={40}>
      <div className="flex items-center gap-2.5 border-b border-bd px-5 py-4">
        <h2 id="md-title" className="m-0 flex-1 text-base font-semibold">
          .md fayldan vazifalar yaratish
        </h2>
        <button type="button" onClick={onClose} aria-label="Yopish" className="flex border-0 bg-transparent p-1 text-mu" style={{ cursor: "pointer" }}>
          <IconClose size={18} />
        </button>
      </div>
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-5 py-4">
        {writeReason && (
          <div role="note" className="rounded-lg bg-org-bg px-3 py-2 text-xs text-org">
            {writeReason}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-mu">
            Manba fayl
            <select className="sel mono min-w-0 flex-1" value={path} onChange={(e) => setPath(e.target.value)} disabled={!files || files.length === 0} aria-label="Manba fayl">
              {(files ?? []).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={!path || extracting || !!writeReason} title={writeReason ?? undefined} onClick={() => void extract()}>
            {extracting ? "O'qilmoqda…" : "Tahlil qilish"}
          </button>
        </div>
        {filesError && <span className="text-xs text-red">{filesError}</span>}
        {files && files.length === 0 && <span className="text-mu">Mashina .md fayllar ro&apos;yxatini hali yubormagan: loyihani yangilang.</span>}
        {error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="md-error">
            {error}
          </div>
        )}

        {resp && (
          <>
            <span className="text-mu">
              {resp.candidates.length === 0 ? "Fayldan vazifa nomzodi topilmadi." : `Fayldan ${resp.candidates.length} ta nomzod topildi${resp.truncated ? " (fayl qisqartirilgan)" : ""}. Keraklisini belgilang va tahrirlang:`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-mu">
                Faza
                <select className="sel max-w-[360px]" value={phaseSel} onChange={(e) => changePhase(e.target.value)} aria-label="Faza">
                  {resp.phases.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                  <option value={NEW_PHASE}>Yangi faza…</option>
                </select>
              </label>
              {phaseSel === NEW_PHASE && <input className="field" style={{ height: 30, width: 280, fontFamily: "var(--font-sans)" }} placeholder="Faza nomi" value={newPhase} onChange={(e) => setNewPhase(e.target.value)} aria-label="Yangi faza nomi" maxLength={200} />}
            </div>
            <div className="flex flex-col">
              {edits.map((e, i) => {
                const issue = issueAt(i);
                return (
                  <div key={i} className="flex flex-col gap-1 border-t border-bd py-2" data-testid="candidate">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked={e.include} onChange={(ev) => patch(i, { include: ev.target.checked })} aria-label={`${e.title}: qo'shish`} />
                      <input className="field mono" style={{ height: 30, width: 84 }} value={e.key} onChange={(ev) => patch(i, { key: ev.target.value, keyTouched: true })} aria-label="Vazifa id" disabled={!e.include} />
                      <input className="field min-w-0 flex-1" style={{ height: 30, fontFamily: "var(--font-sans)" }} value={e.title} onChange={(ev) => patch(i, { title: ev.target.value })} aria-label="Sarlavha" disabled={!e.include} maxLength={200} />
                      <select className="sel" value={e.size} onChange={(ev) => patch(i, { size: ev.target.value })} aria-label="Hajm" disabled={!e.include}>
                        {SIZE_CHOICES.map((s) => (
                          <option key={s} value={s}>
                            {s || "hajm"}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-3 pl-6 text-[11px] text-fa">
                      {e.group && <span>guruh: {e.group}</span>}
                      <span>{e.source === "heading" ? "sarlavha" : e.source === "checklist" ? "ro'yxat" : "raqamli"}</span>
                      {e.alreadyInTasks && <span className="text-yel">TASKS.md&apos;da bor: {e.alreadyInTasks}</span>}
                      {e.include && issue && (
                        <span className="text-red" role="alert">
                          {issue}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {cmd && <CommandProgress command={cmd} />}
        {cmd && progress?.phase === "confirming" && (
          <div className="flex items-center gap-2 text-xs text-mu">
            Telegram&apos;da tasdiqlang (2 daqiqa).
            <button type="button" className="btn h-7 text-xs" onClick={() => cmdId && void runner.cancel(cmdId)}>
              Bekor qilish
            </button>
          </div>
        )}
        {changed && (
          <div className="flex items-center gap-2 rounded-lg bg-yel-bg px-3 py-2 text-xs text-yel" data-testid="changed-hint">
            TASKS.md o&apos;zgargan — yangilang va qayta urinib ko&apos;ring.
            <button
              type="button"
              className="btn h-7 text-xs"
              onClick={() => {
                onRefresh();
                setCmdId(null);
              }}
            >
              Yangilash
            </button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-bd px-5 py-3.5">
        <span className="min-w-0 flex-1 text-xs text-mu">{issues.length > 0 ? `${issues.length} ta xato tuzatilsin` : "Yozishdan oldin TASKS.md holati tekshiriladi."}</span>
        <button type="button" className="btn" onClick={onClose}>
          Bekor
        </button>
        <button type="button" className="btn btn-pri" disabled={!body || issues.length > 0 || !!sending || !!writeReason} title={writeReason ?? undefined} onClick={() => void submit()}>
          {selected} ta vazifani qo&apos;shish → TASKS.md
        </button>
      </div>
    </Dialog>
  );
}
