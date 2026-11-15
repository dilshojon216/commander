import type { SessionSummaryDto, SummaryTrigger } from "@commander/contracts";
import { SUMMARY_LIMITS } from "@commander/contracts";

/** Sessiya xulosasi kartasi uchun ko'rinish modeli (sof). */

export const TRIGGER_LABEL: Record<SummaryTrigger, string> = {
  ended: "Sessiya tugagach",
  idle: "Sessiya bo'sh turganda",
};

export const SUMMARY_EMPTY_TITLE = "Xulosa hali yo'q";
export const SUMMARY_EMPTY_HINT = `Xulosa sessiya tugagach yoki bo'sh turganda yaratiladi. Juda qisqa sessiyalar (kamida ${SUMMARY_LIMITS.defaultMinPrompts} ta prompt va ${SUMMARY_LIMITS.defaultMinTokens.toLocaleString("en-US")} token) xulosalanmaydi; kunlik chegara yoki o'chirilgan mashina/loyiha ham xulosani to'xtatadi.`;

export interface SummaryCardView {
  empty: boolean;
  summary: string;
  done: string[];
  files: string[];
  openItems: string[];
  model: string;
  triggerLabel: string;
  createdAt: string | null;
  /** Ro'yxatlarning ko'rsatilmagan qismi. */
  hiddenFiles: number;
}

export const FILES_SHOWN = 12;

export function buildSummaryCard(dto: SessionSummaryDto | null): SummaryCardView {
  if (!dto) return { empty: true, summary: "", done: [], files: [], openItems: [], model: "", triggerLabel: "", createdAt: null, hiddenFiles: 0 };
  return {
    empty: false,
    summary: dto.summary,
    done: dto.done,
    files: dto.files.slice(0, FILES_SHOWN),
    openItems: dto.openItems,
    model: dto.model,
    triggerLabel: TRIGGER_LABEL[dto.trigger],
    createdAt: dto.createdAt,
    hiddenFiles: Math.max(0, dto.files.length - FILES_SHOWN),
  };
}
