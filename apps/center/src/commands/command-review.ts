import type { CommandReview } from '@commander/contracts';
import { buildPreview } from '../common/preview.js';
import { redactAndCap } from '../common/redact-text.js';

/** Telegram kartasida ko'rinadigan prompt belgilari (`toCommandDto` PREVIEW_CHARS bilan mos). */
export const CARD_PROMPT_CHARS = 500;

/**
 * H-04/M-16: prompt matnini egasi tasdiqlashdan oldin ko'rib chiqish kerakmi. Xavfli andozalar KESILGAN qismda ham
 * qidiriladi (markaz to'liq matnni bu paytda biladi); karta faqat bosh qismini ko'rsatadi.
 * `undefined` = hech qanday ogohlantirish yo'q.
 */
export function reviewForPrompt(prompt: string): CommandReview | undefined {
  // Butun (redakt qilingan, 40k gacha) matn skanerlanadi: kartada ko'rinmaydigan dumdagi xavfli andoza ham topiladi.
  const pv = buildPreview(redactAndCap(prompt, 40_000), CARD_PROMPT_CHARS, prompt.length);
  const reasons = [...pv.reasons];
  if (pv.hiddenChars > 0) reasons.push(`Prompt ${pv.totalChars} belgi: kartada faqat boshi ko'rsatilgan`);
  if (reasons.length === 0) return undefined;
  return { required: pv.requireDashboard, reasons: reasons.slice(0, 16).map((r) => r.slice(0, 300)) };
}
