import { z } from 'zod';
import { SHA_RE } from './git-ops.js';

/**
 * Git checkpoint'lar (task 6.9): katta vazifadan oldin ishchi daraxt holatini xavfsiz saqlash va bir bosishda qaytarish.
 * Uch imzolangan buyruq (mavjud konveyer: `commands` + audit + imzo + lokal siyosat):
 *  - `git.checkpoint {root, label}`: ishchi daraxtga TEGMASDAN `refs/commander/checkpoints/<ts>-<label>` yaratadi;
 *  - `git.checkpoint_list {root}`: faqat o'qish;
 *  - `git.checkpoint_restore {root, ref}`: ishchi daraxt/indeksni checkpoint holatiga qaytaradi (step-up). Avval AVTOMATIK
 *    "pre-restore" checkpoint olinadi (ixtiyoriy: HAR DOIM), shuning uchun qaytarishning o'zi qaytariladigan.
 * Branch o'chirilmaydi, push/force YO'Q. ref FAQAT `refs/commander/checkpoints/` ostida va Commander markeri bor commit'ga.
 */

export const CHECKPOINT_COMMAND_TYPES = ['git.checkpoint', 'git.checkpoint_list', 'git.checkpoint_restore'] as const;
export type CheckpointCommandType = (typeof CHECKPOINT_COMMAND_TYPES)[number];
export const isCheckpointCommandType = (t: string): t is CheckpointCommandType => (CHECKPOINT_COMMAND_TYPES as readonly string[]).includes(t);

export const CHECKPOINT_REF_PREFIX = 'refs/commander/checkpoints/';
/** `refs/commander/checkpoints/20261114T101500Z-label` (label: kichik harf/raqam/tire; to'qnashuvda `-2`, `-3`). */
export const CHECKPOINT_REF_RE = /^refs\/commander\/checkpoints\/[0-9]{8}T[0-9]{6}Z-[a-z0-9][a-z0-9-]{0,47}$/;
export const isCheckpointRef = (v: string): boolean => CHECKPOINT_REF_RE.test(v);
export const CheckpointRefSchema = z.string().regex(CHECKPOINT_REF_RE);

/** Foydalanuvchi yorlig'i (UI/Telegram): bitta qator, xavfsiz belgilar. Ref uchun `checkpointSlug` bilan tozalanadi. */
export const CHECKPOINT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
export const CheckpointLabelSchema = z.string().regex(CHECKPOINT_LABEL_RE);

export const CHECKPOINT_LIMITS = {
  /** Ro'yxatda qaytadigan eng ko'p checkpoint (eng yangilari). */
  listMax: 50,
  /** Kuzatilmayotgan fayllardan olinadigan eng ko'p soni va bittasining eng katta hajmi (bayt). */
  untrackedMaxFiles: 2000,
  untrackedMaxBytes: 5 * 1024 * 1024,
  labelMaxChars: 60,
  slugMaxChars: 48,
  /** REST kutish muddati (ms). */
  waitMs: 45_000,
} as const;

/** Yorliq -> ref qismi: kichik harf, harf/raqam/tire, <= 48; bo'sh qolsa `checkpoint`. Sof. */
export function checkpointSlug(label: string): string {
  const s = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CHECKPOINT_LIMITS.slugMaxChars)
    .replace(/-+$/g, '');
  return s.length > 0 ? s : 'checkpoint';
}

/** `YYYYMMDDTHHMMSSZ` (UTC). Sof. */
export function checkpointStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const Root = z.string().min(1).max(4096);

export const CheckpointPayloadSchema = z.object({ root: Root, label: CheckpointLabelSchema, /** Avtomatik (sessiya/orkestratsiya oldidan): ro'yxatda belgilanadi. */ auto: z.boolean().optional() }).strict();
export type CheckpointPayload = z.infer<typeof CheckpointPayloadSchema>;
export const CheckpointListPayloadSchema = z.object({ root: Root }).strict();
export type CheckpointListPayload = z.infer<typeof CheckpointListPayloadSchema>;
export const CheckpointRestorePayloadSchema = z.object({ root: Root, ref: CheckpointRefSchema }).strict();
export type CheckpointRestorePayload = z.infer<typeof CheckpointRestorePayloadSchema>;

export const CheckpointInfoSchema = z.object({
  ref: CheckpointRefSchema,
  /** Checkpoint commit'i (stash-ga o'xshash: tree = ishchi daraxt, ota-onalar: HEAD va indeks commit'i). */
  sha: z.string().regex(SHA_RE),
  label: z.string().max(CHECKPOINT_LIMITS.labelMaxChars),
  createdAt: z.string(),
  /** Checkpoint paytidagi HEAD (commit) va branch. */
  headSha: z.string().regex(SHA_RE),
  branch: z.string().max(200).nullable(),
  auto: z.boolean(),
  /** Saqlangan kuzatilmayotgan fayllar soni (maxfiy/katta fayllar tashlanadi). */
  untracked: z.number().int().min(0),
});
export type CheckpointInfo = z.infer<typeof CheckpointInfoSchema>;

export const CheckpointResultSchema = z.object({
  checkpoint: CheckpointInfoSchema,
  /** Ishchi daraxt toza edi (tree = HEAD tree). */
  clean: z.boolean(),
  untrackedSkipped: z.number().int().min(0),
});
export type CheckpointResult = z.infer<typeof CheckpointResultSchema>;

export const CheckpointListResultSchema = z.object({ items: z.array(CheckpointInfoSchema).max(CHECKPOINT_LIMITS.listMax), total: z.number().int().min(0) });
export type CheckpointListResult = z.infer<typeof CheckpointListResultSchema>;

export const CheckpointRestoreResultSchema = z.object({
  restored: CheckpointRefSchema,
  /** Qaytarishdan OLDIN avtomatik olingan checkpoint (qaytarishni bekor qilish uchun). */
  preRestore: CheckpointInfoSchema,
  headSha: z.string().regex(SHA_RE),
  /** HEAD checkpoint'dagi commit'ga qaytarildi (branch orqaga surildi; eski commitlar pre-restore orqali saqlanadi). */
  headMoved: z.boolean(),
  branch: z.string().max(200).nullable(),
});
export type CheckpointRestoreResult = z.infer<typeof CheckpointRestoreResultSchema>;

// --- REST --------------------------------------------------------------------------------------

export const CreateCheckpointBodySchema = z.object({ label: CheckpointLabelSchema }).strict();
export type CreateCheckpointBody = z.infer<typeof CreateCheckpointBodySchema>;
export const RestoreCheckpointBodySchema = z.object({ ref: CheckpointRefSchema }).strict();
export type RestoreCheckpointBody = z.infer<typeof RestoreCheckpointBodySchema>;

/** Avtomatik checkpoint sozlamalari (`settings['checkpoints.auto']`). Default: ikkalasi o'chiq. */
export const CheckpointAutoSettingsSchema = z.object({ bigTask: z.boolean(), orchestration: z.boolean() }).strict();
export type CheckpointAutoSettings = z.infer<typeof CheckpointAutoSettingsSchema>;
export const DEFAULT_CHECKPOINT_AUTO: CheckpointAutoSettings = { bigTask: false, orchestration: false };
