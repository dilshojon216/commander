/**
 * Deploy (6.5) va git checkpoint (6.9) proksi qoidalari.
 * `proxy-rules.ts` shu yerdan import qiladi (sof, testlanadi).
 *
 * Elevation (FAIL-CLOSED: ro'yxatda yo'q o'zgartiruvchi yo'l elevation talab qiladi):
 *  - deploy/inspect: faqat o'qiydi, elevation YO'Q;
 *  - deploy/run va deploy/rollback: kod ijro etadi, elevation HAR DOIM (istisno yo'q);
 *  - checkpoints (yaratish) va checkpoints/list: ishchi daraxtga tegmaydi, elevation YO'Q;
 *  - checkpoints/restore: ishchi daraxtni qayta yozadi, elevation HAR DOIM;
 *  - PUT checkpoints/settings: avto-checkpoint o'zgartirish, elevation (default).
 */

const UUID = "[0-9a-fA-F-]{36}";

/** O'qish (`read` token): deploy tarixi, deploy chiqishi (kursor), avto-checkpoint sozlamalari. */
export const DEPLOY_GET_RULES: RegExp[] = [new RegExp(`^projects/${UUID}/deploy/runs$`), new RegExp(`^deploy/runs/${UUID}/output$`), /^checkpoints\/settings$/];

export const DEPLOY_INSPECT_RULE = new RegExp(`^projects/${UUID}/deploy/inspect$`);
export const DEPLOY_RUN_RULE = new RegExp(`^projects/${UUID}/deploy/(run|rollback)$`);
export const CHECKPOINT_CREATE_RULE = new RegExp(`^projects/${UUID}/checkpoints$`);
export const CHECKPOINT_LIST_RULE = new RegExp(`^projects/${UUID}/checkpoints/list$`);
export const CHECKPOINT_RESTORE_RULE = new RegExp(`^projects/${UUID}/checkpoints/restore$`);

/** Yozuvlar (`control` token). */
export const DEPLOY_WRITE_RULES: { method: "POST" | "PUT" | "PATCH" | "DELETE"; re: RegExp }[] = [
  { method: "POST", re: DEPLOY_INSPECT_RULE },
  { method: "POST", re: DEPLOY_RUN_RULE },
  { method: "POST", re: CHECKPOINT_CREATE_RULE },
  { method: "POST", re: CHECKPOINT_LIST_RULE },
  { method: "POST", re: CHECKPOINT_RESTORE_RULE },
  { method: "PUT", re: /^checkpoints\/settings$/ },
];

/** Faqat o'qiydigan / ishchi daraxtga tegmaydigan amallar: elevation talab qilmaydi. */
export const DEPLOY_ELEVATION_EXEMPT: RegExp[] = [DEPLOY_INSPECT_RULE, CHECKPOINT_CREATE_RULE, CHECKPOINT_LIST_RULE];

/** `Idempotency-Key` yo'q bo'lsa serverda yaratiladigan yo'llar: buyruq yaratuvchilar (run, rollback, restore). */
export const DEPLOY_IDEMPOTENT_RULES: RegExp[] = [DEPLOY_RUN_RULE, CHECKPOINT_RESTORE_RULE];

/** Agent natijasini sinxron kutadigan yo'llar (inspect ~45 s, checkpoint yaratish/ro'yxat): proksi muddati uzaytiriladi. */
export const DEPLOY_SLOW_RULES: RegExp[] = [DEPLOY_INSPECT_RULE, CHECKPOINT_CREATE_RULE, CHECKPOINT_LIST_RULE];
