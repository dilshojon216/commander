import { CHECKPOINT_LABEL_RE, CHECKPOINT_LIMITS, CheckpointRestoreResultSchema } from "@commander/contracts";
import type { CheckpointAutoSettings, CheckpointInfo, CheckpointResult, CheckpointRestoreResult } from "@commander/contracts";
import { formatRelative } from "./format";

/** Git checkpoint (6.9) ko'rinish mantig'i: sof funksiyalar (testlanadi). */

/** Yorliq xatosi (bo'sh = yaroqli). Qoida: `CHECKPOINT_LABEL_RE` (harf/raqam bilan boshlanadi, harf/raqam/bo'shliq/./_/-, <= 60). */
export function validateLabel(raw: string): string | null {
  const label = raw.trim();
  if (label === "") return "Yorliq kiriting";
  if (label.length > CHECKPOINT_LIMITS.labelMaxChars) return `Yorliq ${CHECKPOINT_LIMITS.labelMaxChars} belgidan oshmasin`;
  if (!/^[A-Za-z0-9]/.test(label)) return "Yorliq harf yoki raqam bilan boshlansin";
  if (!CHECKPOINT_LABEL_RE.test(label)) return "Yorliqda faqat lotin harf, raqam, bo'sh joy, nuqta, tire va pastki chiziq bo'lsin";
  return null;
}

export const normalizeLabel = (raw: string): string => raw.trim();

export interface CheckpointRow {
  ref: string;
  sha: string;
  head8: string;
  label: string;
  time: string;
  branch: string | null;
  auto: boolean;
  untracked: number;
  untrackedText: string;
}

export const checkpointTime = (iso: string, now: number): string => formatRelative(Date.parse(iso) / 1000, now);

/** Ro'yxat qatorlari (yangi birinchi). */
export function checkpointRows(items: CheckpointInfo[], now: number): CheckpointRow[] {
  return [...items]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((c) => ({
      ref: c.ref,
      sha: c.sha,
      head8: c.headSha.slice(0, 8),
      label: c.label,
      time: checkpointTime(c.createdAt, now),
      branch: c.branch,
      auto: c.auto,
      untracked: c.untracked,
      untrackedText: c.untracked > 0 ? `${c.untracked} ta kuzatilmagan fayl saqlangan` : "kuzatilmagan fayl yo'q",
    }));
}

/** Yaratilgandan keyingi xabar (toza/ifloslik, tashlab yuborilgan fayllar). */
export function createdNote(r: CheckpointResult): string {
  const parts = [r.clean ? "Ishchi daraxt toza edi (checkpoint HEAD bilan bir xil)" : "Ishchi daraxt holati saqlandi"];
  if (r.untrackedSkipped > 0) parts.push(`${r.untrackedSkipped} ta kuzatilmagan fayl tashlandi (maxfiy yoki katta)`);
  return `Checkpoint «${r.checkpoint.label}» yaratildi. ${parts.join("; ")}.`;
}

/** Qaytarish dialogidagi tushuntirish (har biri alohida qator). */
export function restoreExplanation(c: Pick<CheckpointInfo, "label" | "branch" | "headSha">): string[] {
  return [
    "Ishchi daraxt va indeks checkpoint holatiga qaytariladi: shundan keyingi tahrirlaringiz yo'qoladi.",
    "Avval avtomatik «pre-restore» checkpoint olinadi: qaytarishning o'zini ham ortga qaytarish mumkin.",
    `Branch orqaga surilishi mumkin${c.branch ? ` (${c.branch})` : ""}: HEAD ${c.headSha.slice(0, 8)} ga qaytadi; eski commit'lar pre-restore orqali saqlanadi.`,
    "Checkpointdan keyin yaratilgan yangi (kuzatilmagan) fayllarga tegilmaydi.",
  ];
}

export const DIFF_UNTRACKED_NOTE = "Diff joriy ishchi daraxtni checkpoint commit'i bilan solishtiradi. Kuzatilmagan (yangi) fayllar diffga kirmaydi va qaytarishda ham o'zgarmaydi.";

export const AUTO_LABELS: { key: keyof CheckpointAutoSettings; label: string; help: string }[] = [
  { key: "bigTask", label: "Katta vazifa shablonidan oldin", help: "«Katta vazifa» shabloni bilan sessiya ochishdan oldin avtomatik checkpoint olinadi" },
  { key: "orchestration", label: "Orkestratsiya oldidan", help: "Orkestratsiya (ko'p qadamli reja) boshlanishidan oldin avtomatik checkpoint olinadi" },
];

/** `command.result.checkpoint` (restore) -> tekshirilgan natija (yaroqsiz bo'lsa `null`). */
export function parseRestoreResult(result: unknown): CheckpointRestoreResult | null {
  const d = typeof result === "object" && result !== null && "checkpoint" in result ? (result as { checkpoint: unknown }).checkpoint : null;
  const r = CheckpointRestoreResultSchema.safeParse(d);
  return r.success ? r.data : null;
}

/** Qaytarish natijasi matni. */
export function restoreResultText(r: CheckpointRestoreResult): string {
  return `Qaytarildi: HEAD ${r.headSha.slice(0, 8)}${r.branch ? ` (${r.branch})` : ""}${r.headMoved ? ", branch orqaga surildi" : ""}. Oldingi holat «${r.preRestore.label}» checkpointida saqlandi.`;
}
