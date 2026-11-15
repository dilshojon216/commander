import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Inline tugma `callback_data` (Telegram chegarasi 64 bayt). Format: `<amal 1><approvalId 32 hex><imzo 16>[arg <= 4]` = 49..53 bayt (arg: savol javobi tugmalari, 6.13).
 * Imzo: HMAC-SHA256(amal | id | chatId), birinchi 12 bayt (base64url, 16 belgi). Kalit bot tokenidan hosil
 * qilinadi (yangi sir kerak emas, token faqat center env'ida). Imzo chatId'ni ham qamraydi: boshqa chatdan
 * ko'chirilgan tugma ishlamaydi. Callback ichidagi hech narsaga ishonilmaydi: approval holati serverda tekshiriladi.
 */
export type CallbackAction = 'ask' | 'deny' | 'confirm' | 'back' | 'cmdyes' | 'cmdno' | 'pick' | 'rule' | 'ruleyes' | 'fb' | 'qopt' | 'qsubmit' | 'qother';

const CODE: Record<CallbackAction, string> = { ask: 'a', deny: 'd', confirm: 'c', back: 'b', cmdyes: 'y', cmdno: 'n', pick: 'p', rule: 'r', ruleyes: 'u', fb: 'f', qopt: 'o', qsubmit: 's', qother: 'e' };
const ACTION_BY_CODE: Record<string, CallbackAction> = { a: 'ask', d: 'deny', c: 'confirm', b: 'back', y: 'cmdyes', n: 'cmdno', p: 'pick', r: 'rule', u: 'ruleyes', f: 'fb', o: 'qopt', s: 'qsubmit', e: 'qother' };
const DATA_RE = /^([adcbynpruf]|[ose])([0-9a-f]{32})([A-Za-z0-9_-]{16})([0-9a-z]{0,4})$/;
const SIG_BYTES = 12;

export function callbackKey(botToken: string): Buffer {
  return createHmac('sha256', botToken).update('commander-telegram-callback-v1').digest();
}

function sign(key: Buffer, code: string, id32: string, chatId: string, arg = ''): string {
  return createHmac('sha256', key).update(arg === '' ? `${code}|${id32}|${chatId}` : `${code}|${id32}|${chatId}|${arg}`).digest().subarray(0, SIG_BYTES).toString('base64url');
}

const uuidToHex = (uuid: string): string => uuid.replaceAll('-', '').toLowerCase();
const hexToUuid = (h: string): string => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

export function encodeCallback(key: Buffer, action: CallbackAction, approvalId: string, chatId: string | number, arg = ''): string {
  if (!/^[0-9a-z]{0,4}$/.test(arg)) throw new Error('callback arg must be <= 4 chars [0-9a-z]');
  const code = CODE[action];
  const id32 = uuidToHex(approvalId);
  if (!/^[0-9a-f]{32}$/.test(id32)) throw new Error('approvalId must be a uuid');
  return `${code}${id32}${sign(key, code, id32, String(chatId), arg)}${arg}`;
}

/**
 * `approvalId` maydoni: approval amallari uchun approval uuid'si, `cmdyes|cmdno` uchun BUYRUQ uuid'si,
 * `pick` (/new, /s tugmalari) uchun xotiradagi tugma havolasi (ref): qiymat serverda, callback ichida emas.
 */
export function decodeCallback(key: Buffer, data: string, chatId: string | number): { action: CallbackAction; approvalId: string; arg?: string } | null {
  const m = DATA_RE.exec(data);
  if (!m) return null;
  const [, code, id32, sig, arg] = m as unknown as [string, string, string, string, string];
  const expected = Buffer.from(sign(key, code, id32, String(chatId), arg));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const action = ACTION_BY_CODE[code];
  return action ? { action, approvalId: hexToUuid(id32), ...(arg !== '' ? { arg } : {}) } : null;
}
