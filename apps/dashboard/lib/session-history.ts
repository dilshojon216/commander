import type { SessionDto, SessionEventDto } from "@commander/contracts";
import { formatClock, formatDuration } from "./format";
import { isStatus } from "./types";
import type { DisplayStatus } from "./status";
import { STATUS_META } from "./status";

export interface HistoryStep {
  key: string;
  label: string;
  status: DisplayStatus | null;
  /** "09:43 – 09:47" yoki "09:47 · hozir". */
  time: string;
  /** Qisqa izoh: davomiylik, turlar soni ("6 daq · 3 tur"). */
  detail?: string;
}

/** Ish turlari orasidagi shundan qisqa tanaffus bitta blokka birlashtiriladi (ketma-ket kichik javoblar shovqin bo'lmasin). */
export const MERGE_GAP_MS = 2 * 60_000;

interface Seg {
  status: string;
  from: number;
  to: number | null;
  id: string;
}

const REST = new Set(["done", "idle"]);

function range(from: number, to: number | null, open: boolean): string {
  if (open) return `${formatClock(from)} · hozir`;
  if (to === null || formatClock(to) === formatClock(from)) return formatClock(from);
  return `${formatClock(from)} – ${formatClock(to)}`;
}

function label(status: string): { label: string; status: DisplayStatus | null } {
  const st = isStatus(status) ? status : null;
  return { label: st ? STATUS_META[st].label : status, status: st };
}

/**
 * Holat tarixi (vaqt chizig'i), yangisi birinchi, oxirida "Boshlandi". Shovqinsiz ko'rinish (2026-11-14 egasi fikri):
 *  - "Ishlamoqda" -> "Tugatdi"/"Bo'sh" juftlari bitta "Ishladi" qatori (davomiylik bilan); 2 daqiqadan qisqa tanaffus bilan
 *    ajralgan turlar bitta blokka birlashadi ("3 tur").
 *  - Orada qolgan "Tugatdi"/"Bo'sh" qatorlari ko'rsatilmaydi; faqat joriy holat (oxirgisi) "· hozir" bilan.
 *  - Javob/ruxsat kutish o'z qatori (davomiylik bilan). Yopilgandan keyin hodisa kelsa: "Yopildi" + "Davom ettirildi".
 */
export function buildHistory(session: Pick<SessionDto, "startedAt" | "endedAt" | "status">, events: SessionEventDto[], max = 12): HistoryStep[] {
  const asc = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const segs: Seg[] = [];
  for (const ev of asc) {
    const t = Date.parse(ev.ts);
    if (Number.isNaN(t)) continue;
    const last = segs[segs.length - 1];
    if (last && last.status === ev.status) continue;
    if (last) last.to = t;
    segs.push({ status: ev.status, from: t, to: null, id: ev.id });
  }
  const endedAt = session.endedAt ? Date.parse(session.endedAt) : null;
  if (segs.length > 0) segs[segs.length - 1].to = endedAt;

  const steps: HistoryStep[] = []; // eskisidan yangisiga
  let i = 0;
  while (i < segs.length) {
    const s = segs[i];
    const isLast = i === segs.length - 1;
    if (s.status === "working") {
      // Ish bloki: working [rest<gap working]* — oxirgi working tugashigacha
      let j = i;
      let turns = 1;
      while (j + 2 < segs.length && REST.has(segs[j + 1].status) && segs[j + 2].status === "working") {
        const rest = segs[j + 1];
        if (rest.to === null || rest.to - rest.from >= MERGE_GAP_MS) break;
        j += 2;
        turns += 1;
      }
      const end = segs[j].to;
      const open = j === segs.length - 1 && endedAt === null;
      const dur = end !== null ? formatDuration(end - s.from) : null;
      steps.push({
        key: s.id,
        label: open ? "Ishlamoqda" : "Ishladi",
        status: "working",
        time: range(s.from, end, open),
        detail: [!open && dur ? dur : null, turns > 1 ? `${turns} tur` : null].filter(Boolean).join(" · ") || undefined,
      });
      i = j + 1;
      continue;
    }
    if (REST.has(s.status)) {
      // Oraliq dam olish qatorlari yashiriladi; faqat joriy holat ko'rinadi
      if (isLast) steps.push({ key: s.id, ...label(s.status), time: range(s.from, s.to, endedAt === null) });
      i += 1;
      continue;
    }
    if (s.status === "ended" && !isLast) {
      steps.push({ key: s.id, label: "Yopildi", status: "ended", time: formatClock(s.from) });
      const next = segs[i + 1];
      steps.push({ key: `${s.id}-resume`, label: "Davom ettirildi", status: null, time: formatClock(next.from) });
      i += 1;
      continue;
    }
    const open = isLast && endedAt === null;
    const dur = !open && s.to !== null && s.to - s.from >= 60_000 ? formatDuration(s.to - s.from) : undefined;
    steps.push({ key: s.id, ...label(s.status), time: range(s.from, s.to, open), detail: dur });
    i += 1;
  }

  const started = Date.parse(session.startedAt);
  const result = steps.reverse().slice(0, max);
  result.push({ key: "__start", label: "Boshlandi", status: null, time: Number.isNaN(started) ? "—" : formatClock(started) });
  return result;
}
