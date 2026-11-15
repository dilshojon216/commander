import type { MachineDto } from "@commander/contracts";
import { formatDuration } from "./format";

export interface MachineSessionPart {
  key: "working" | "waiting" | "awaitingApproval" | "idle" | "done";
  n: number;
  label: string;
}

const LABELS: Record<MachineSessionPart["key"], string> = {
  working: "ishlamoqda",
  awaitingApproval: "ruxsat",
  waiting: "kutmoqda",
  idle: "bo'sh",
  done: "tugatdi",
};

/** Mashinadagi sessiyalar holat bo'yicha: [{working,1,"ishlamoqda"}, ...] (nollar tashlanadi). */
export function machineSessionParts(s: MachineDto["sessions"]): MachineSessionPart[] {
  const order: MachineSessionPart["key"][] = ["working", "awaitingApproval", "waiting", "idle", "done"];
  return order.filter((k) => s[k] > 0).map((k) => ({ key: k, n: s[k], label: LABELS[k] }));
}

/** Kartadagi qisqa satr: "1 ishlamoqda · 1 ruxsat" yoki oflayn: "Oflayn · 3 soat oldin ko'rilgan". */
export function machineSubtitle(m: Pick<MachineDto, "online" | "lastSeenAt" | "sessions">, now: number): { text: string; warn: boolean } {
  if (!m.online) {
    const seen = m.lastSeenAt ? Date.parse(m.lastSeenAt) : NaN;
    return { text: Number.isNaN(seen) || !now ? "Oflayn" : `Oflayn · ${formatDuration(Math.max(0, now - seen))} oldin ko'rilgan`, warn: false };
  }
  const parts = machineSessionParts(m.sessions);
  const text = parts.length === 0 ? "Ochiq sessiya yo'q" : parts.map((p) => `${p.n} ${p.label}`).join(" · ");
  return { text, warn: m.sessions.waiting > 0 || m.sessions.awaitingApproval > 0 };
}
