"use client";

import { memo, useEffect, useRef } from "react";
import type { MouseEvent } from "react";
import type { LogLine } from "@/lib/logs-view";

export interface LogViewportProps {
  /** Ko'rinadigan (pauza va filtr qo'llangan) qatorlar. */
  lines: LogLine[];
  selectedIds: ReadonlySet<number>;
  onSelect: (id: number, shift: boolean) => void;
  /** Yangi qator kelganda pastga aylantirish (pauza bo'lsa o'chiq). */
  follow: boolean;
  emptyText: string;
}

const ERR_RE = /\b(error|err|fatal|panic|exception|critical|crit)\b/i;
const WARN_RE = /\b(warn|warning)\b/i;

function tone(text: string): string {
  if (ERR_RE.test(text)) return "text-red";
  if (WARN_RE.test(text)) return "text-org";
  return "text-tx";
}

const Row = memo(function Row({ line, selected, onSelect }: { line: LogLine; selected: boolean; onSelect: (id: number, shift: boolean) => void }) {
  const click = (e: MouseEvent) => onSelect(line.id, e.shiftKey);
  return (
    <div role="option" aria-selected={selected} data-testid="log-line" data-selected={selected} onClick={click} className={`cursor-pointer whitespace-pre-wrap break-all px-2 py-px ${selected ? "bg-blue-bg" : "hover:bg-s2"} ${tone(line.text)}`}>
      {line.text === "" ? " " : line.text}
    </div>
  );
});

/** Log qatorlari oynasi: bosish = tanlash, Shift+bosish = oraliq. Faqat ko'rinish (props orqali; testlanadi). */
export function LogViewport({ lines, selectedIds, onSelect, follow, emptyText }: LogViewportProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const last = lines.length > 0 ? (lines[lines.length - 1] as LogLine).id : -1;
  useEffect(() => {
    const el = ref.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [follow, last]);
  return (
    <div ref={ref} role="listbox" aria-multiselectable="true" aria-label="Log qatorlari" data-testid="log-viewport" className="mono h-[55vh] min-h-[240px] overflow-auto rounded-lg border border-bd bg-s1 py-1 text-[11.5px] leading-[1.5]">
      {lines.length === 0 ? <div className="px-3 py-2 text-mu">{emptyText}</div> : null}
      {lines.map((l) => (
        <Row key={l.id} line={l} selected={selectedIds.has(l.id)} onSelect={onSelect} />
      ))}
    </div>
  );
}
