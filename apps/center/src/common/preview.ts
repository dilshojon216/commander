/**
 * Egaga ko'rsatiladigan buyruq/prompt ko'rinishi (H-04, M-16). Mantiq `@commander/contracts` (`preview-safety.ts`) da:
 * center (Telegram) va dashboard bir xil qoidalardan foydalanadi. Bu fayl faqat qulay qayta eksport.
 */
export { DANGER_RULES, MIN_VISIBLE_ALNUM, MOSTLY_HIDDEN_SHARE, SCAN_MAX, buildPreview, detectDanger, isMostlyHidden, redactionStats, stripHiddenChars, truncationNote } from '@commander/contracts';
export type { DangerRule, PreviewResult } from '@commander/contracts';
