import { z } from 'zod';

/**
 * Telegram step-up istisnosi (6.17b): `settings['commands.stepup_exempt_device_ids']` ni egasi dashboard'dan boshqaradi.
 *
 * Mijoz FAQAT mantiqiy bayroq yuboradi (`exempt`); qurilma id'larini markaz o'zi topadi: `devices` jadvalida
 * `kind = 'web'`, `name = 'dashboard-control'`, bekor qilinmagan (revoked_at IS NULL) va muddati o'tmagan qurilmalar.
 * Ro'yxatdagi boshqa id'lar (masalan qo'lda qo'shilgan) tegilmaydi.
 * Deploy/rollback va `auto` rejim istisnoga HECH QACHON kirmaydi (har doim Telegram tasdig'i; markaz qoidasi).
 */
export const StepUpExemptionResponseSchema = z.object({
  /** Dashboard boshqaruv qurilmasi mavjudmi (yo'q bo'lsa yoqib bo'lmaydi). */
  available: z.boolean(),
  /** Barcha dashboard qurilmalari istisnoda (kamida bittasi bor). */
  exempt: z.boolean(),
  /** Faol dashboard qurilmalari soni. */
  dashboardDevices: z.number().int().min(0),
  /** Ro'yxatdagi dashboard bo'lmagan id'lar soni (ma'lumot uchun; bu endpoint ularga tegmaydi). */
  otherExemptDevices: z.number().int().min(0),
});
export type StepUpExemptionResponse = z.infer<typeof StepUpExemptionResponseSchema>;

export const PutStepUpExemptionBodySchema = z.object({ exempt: z.boolean() }).strict();
export type PutStepUpExemptionBody = z.infer<typeof PutStepUpExemptionBodySchema>;
