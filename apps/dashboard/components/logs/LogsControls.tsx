"use client";

import type { LogSource } from "@commander/contracts";
import { LINES_OPTIONS, LOG_SOURCE_LABEL, LOG_SOURCE_PLACEHOLDER, SINCE_OPTIONS } from "@/lib/logs-view";
import type { LogsForm } from "@/lib/logs-view";

export interface LogsStartFormProps {
  form: LogsForm;
  onChange: (next: LogsForm) => void;
  suggestions: string[];
  active: boolean;
  starting: boolean;
  /** Boshlash taqiqlangan bo'lsa sabab (lockdown, token ...). */
  blocked: string | null;
  formError: string | null;
  onStart: () => void;
  onStop: () => void;
}

const SOURCES: LogSource[] = ["docker", "journal", "file"];

/** Manba tanlash, nom, qatorlar soni, "since" va "Jonli" — boshlash formasi (props orqali; testlanadi). */
export function LogsStartForm({ form, onChange, suggestions, active, starting, blocked, formError, onStart, onStop }: LogsStartFormProps) {
  const set = <K extends keyof LogsForm>(k: K, v: LogsForm[K]) => onChange({ ...form, [k]: v });
  return (
    <form
      className="card flex flex-col gap-3 p-4"
      aria-label="Log so'rovi"
      onSubmit={(e) => {
        e.preventDefault();
        if (!active && !starting && !blocked) onStart();
      }}
    >
      {blocked ? (
        <div role="alert" className="rounded-lg bg-org-bg px-3 py-2 text-xs text-org">
          {blocked}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5" role="group" aria-label="Manba">
          <span className="lbl">Manba</span>
          <div className="flex gap-1">
            {SOURCES.map((s) => (
              <button key={s} type="button" className={`pill ${form.source === s ? "bg-blue-bg text-blue" : "bg-gray-bg text-mu"}`} aria-pressed={form.source === s} data-testid={`log-source-${s}`} onClick={() => set("source", s)}>
                {LOG_SOURCE_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
        <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <span className="lbl">{form.source === "file" ? "Fayl yo'li" : "Nom"}</span>
          <input className="field" list="log-name-suggestions" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={LOG_SOURCE_PLACEHOLDER[form.source]} spellCheck={false} autoComplete="off" data-testid="log-name" />
          <datalist id="log-name-suggestions">
            {suggestions.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Qatorlar</span>
          <select className="field" value={form.lines} onChange={(e) => set("lines", Number(e.target.value))} data-testid="log-lines">
            {LINES_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Qachondan</span>
          <select className="field" value={form.since} onChange={(e) => set("since", e.target.value)} data-testid="log-since">
            {SINCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" checked={form.follow} onChange={(e) => set("follow", e.target.checked)} data-testid="log-follow" />
          <span>Jonli (follow)</span>
        </label>
        {active || starting ? (
          <button type="button" className="btn btn-stop" onClick={onStop} data-testid="log-stop">
            To&apos;xtatish
          </button>
        ) : (
          <button type="submit" className="btn btn-pri" disabled={!!blocked} data-testid="log-start">
            Ko&apos;rsatish
          </button>
        )}
      </div>
      {formError ? (
        <div role="alert" className="text-xs text-red" data-testid="log-form-error">
          {formError}
        </div>
      ) : null}
      <span className="text-xs text-mu">Faqat o&apos;qish. Chiqish agentda va markazda redakt qilinadi; log matni bazaga yozilmaydi. Jonli oqim eng ko&apos;pi 10 daqiqa.</span>
    </form>
  );
}

export interface LogsToolbarProps {
  filter: string;
  onFilter: (v: string) => void;
  paused: boolean;
  pending: number;
  onTogglePause: () => void;
  autoScroll: boolean;
  onAutoScroll: (v: boolean) => void;
  onClear: () => void;
  onDownload: () => void;
  shown: number;
  total: number;
  canDownload: boolean;
}

/** Filtr, pauza/davom, tozalash, yuklab olish (props orqali; testlanadi). */
export function LogsToolbar({ filter, onFilter, paused, pending, onTogglePause, autoScroll, onAutoScroll, onClear, onDownload, shown, total, canDownload }: LogsToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Log asboblari">
      <input className="field min-w-[180px] flex-1" value={filter} onChange={(e) => onFilter(e.target.value)} placeholder="Filtr (katta-kichik harf farqsiz)" aria-label="Filtr" spellCheck={false} data-testid="log-filter" />
      <span className="mono text-xs text-mu" data-testid="log-count">
        {filter.trim() !== "" ? `${shown} / ${total}` : total} qator
      </span>
      <button type="button" className="btn" onClick={onTogglePause} aria-pressed={paused} data-testid="log-pause">
        {paused ? `Davom etish${pending > 0 ? ` (+${pending})` : ""}` : "Pauza"}
      </button>
      <label className="flex items-center gap-1.5 text-xs">
        <input type="checkbox" checked={autoScroll && !paused} disabled={paused} onChange={(e) => onAutoScroll(e.target.checked)} data-testid="log-autoscroll" />
        Avto-pastga
      </label>
      <button type="button" className="btn" onClick={onClear} data-testid="log-clear">
        Tozalash
      </button>
      <button type="button" className="btn" onClick={onDownload} disabled={!canDownload} data-testid="log-download">
        Yuklab olish (.txt)
      </button>
    </div>
  );
}
