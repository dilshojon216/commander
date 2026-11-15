"use client";

import type { HealthContainer } from "@commander/contracts";
import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { useShellUi } from "@/components/shell/ShellUi";
import { buildAskPrompt, buildDownloadText, buildNameSuggestions, buildStartBody, defaultLogsForm, downloadFileName, filterLines, limitForAsk, logNotes, pendingCount, selectLine, selectedLines, streamStateLabel, streamStateTone, visibleLines } from "@/lib/logs-view";
import type { LineSelection, LogsForm } from "@/lib/logs-view";
import { machineLabel } from "@/lib/machines";
import { useLogStream } from "@/lib/use-log-stream";
import { LogsStartForm, LogsToolbar } from "./LogsControls";
import { LogViewport } from "./LogViewport";

export interface LogsPanelProps {
  machineId: string;
  /** Oxirgi salomatlik snapshot'idagi konteynerlar (nom takliflari). */
  containers: Pick<HealthContainer, "name" | "state">[];
  failedUnits: string[];
}

/** Brauzerda matnni `.txt` fayl qilib saqlaydi (faqat ko'rinadigan, filtrlangan qatorlar). */
function saveTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Mashina sahifasi "Loglar" tabi: forma, jonli oqim, filtr, pauza, yuklab olish va "Claude'dan so'rash". */
export function LogsPanel({ machineId, containers, failedUnits }: LogsPanelProps) {
  const { canControl, lockdown, machines } = useLiveData();
  const { openNewSession } = useShellUi();
  const stream = useLogStream(machineId);
  const { view } = stream;
  const [form, setForm] = useState<LogsForm>(defaultLogsForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ source: LogsForm["source"]; name: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [pausedAtId, setPausedAtId] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selection, setSelection] = useState<LineSelection | null>(null);

  const machine = machines.find((m) => m.id === machineId);
  const blocked = lockdown ? "Lockdown yoqiq: loglarni ko'rib bo'lmaydi." : !canControl ? "COMMANDER_CONTROL_TOKEN sozlanmagan: log ko'rish o'chiq." : null;
  const suggestions = useMemo(() => buildNameSuggestions(form.source, containers, failedUnits), [form.source, containers, failedUnits]);

  const visible = useMemo(() => visibleLines(view.lines, pausedAtId), [view.lines, pausedAtId]);
  const shown = useMemo(() => filterLines(visible, filter), [visible, filter]);
  const selectedIds = useMemo(() => new Set(selectedLines(shown, selection).map((l) => l.id)), [shown, selection]);
  const picked = useMemo(() => selectedLines(shown, selection), [shown, selection]);
  const active = stream.running;

  function start() {
    const { body, error } = buildStartBody(form);
    setFormError(error);
    if (!body) return;
    setPausedAtId(null);
    setSelection(null);
    setStarted({ source: body.source, name: body.name });
    stream.start(body);
  }

  function download() {
    if (shown.length === 0) return;
    saveTextFile(downloadFileName(started?.source ?? form.source, started?.name ?? form.name, new Date()), buildDownloadText(shown));
  }

  function ask() {
    if (picked.length === 0 || !started) return;
    const sel = limitForAsk(picked.map((l) => l.text));
    const prompt = buildAskPrompt({ source: started.source, name: started.name, machineLabel: machine ? machineLabel(machine) : "mashina" }, sel);
    // Faqat oldindan to'ldirish: foydalanuvchi mavjud "Ochish" tugmasini bosadi (elevation + step-up qoidalari o'z kuchida)
    openNewSession({ machineId, cwd: "", prompt, permissionMode: "plan" });
  }

  const notes = logNotes(view);
  const askInfo = picked.length > 0 ? limitForAsk(picked.map((l) => l.text)) : null;

  return (
    <div className="flex flex-col gap-3" data-testid="logs-panel">
      <LogsStartForm form={form} onChange={setForm} suggestions={suggestions} active={active} starting={stream.starting} blocked={blocked} formError={formError ?? stream.error} onStart={start} onStop={stream.stop} />

      <section className="card flex flex-col gap-2.5 p-4" aria-label="Log chiqishi">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`pill ${streamStateTone(stream.starting ? "starting" : view.state)}`} data-testid="log-state">
            {streamStateLabel(stream.starting ? "starting" : view.state, view.reason)}
          </span>
          {started ? (
            <span className="mono text-xs text-mu">
              {started.source}: {started.name}
            </span>
          ) : null}
          {view.error ? (
            <span className="text-xs text-red" data-testid="log-agent-error">
              {view.error.message}
            </span>
          ) : null}
        </div>
        {notes.map((n) => (
          <div key={n} className="rounded-lg bg-org-bg px-3 py-1.5 text-xs text-org" data-testid="log-note">
            {n}
          </div>
        ))}
        <LogsToolbar
          filter={filter}
          onFilter={setFilter}
          paused={pausedAtId !== null}
          pending={pendingCount(view.lines, pausedAtId)}
          onTogglePause={() => setPausedAtId((p) => (p === null ? view.nextId : null))}
          autoScroll={autoScroll}
          onAutoScroll={setAutoScroll}
          onClear={() => {
            stream.clear();
            setSelection(null);
            setPausedAtId(null);
          }}
          onDownload={download}
          shown={shown.length}
          total={visible.length}
          canDownload={shown.length > 0}
        />
        <LogViewport lines={shown} selectedIds={selectedIds} onSelect={(id, shift) => setSelection((s) => selectLine(s, id, shift))} follow={autoScroll && pausedAtId === null} emptyText={started ? (stream.starting ? "Ulanmoqda…" : "Qator yo'q.") : "Manba va nomni tanlab \"Ko'rsatish\" ni bosing."} />
        {askInfo ? (
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="log-ask-bar">
            <span className="text-mu">
              Tanlangan: {picked.length} qator
              {askInfo.truncated ? ` (so'rovga oxirgi ${askInfo.lines.length} tasi ketadi: chegara 200 qator / 8000 belgi)` : ""}
            </span>
            <button type="button" className="btn btn-pri" onClick={ask} data-testid="log-ask">
              Claude&apos;dan so&apos;rash
            </button>
            <button type="button" className="btn" onClick={() => setSelection(null)}>
              Tanlovni bekor qilish
            </button>
          </div>
        ) : (
          <span className="text-xs text-mu">Qatorni bosing, oraliq uchun Shift bilan bosing: tanlanganlarni &quot;Claude&apos;dan so&apos;rash&quot; mumkin (yangi sessiya, plan rejimi; yuborishdan oldin matnni ko&apos;rasiz).</span>
        )}
      </section>
    </div>
  );
}
