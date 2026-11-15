/**
 * Audit `details`ga sir tushmasligi uchun: sezgir kalitlar qiymati va token/Bearer ko'rinishidagi
 * satrlar `[redacted]`ga almashtiriladi; uzun satrlar qisqartiriladi. Chuqurlik cheklangan.
 */
const SENSITIVE_KEY = /(^|_|-)(code|token|secret|signature|authorization|password|passphrase|private_key|cookie|nonce|api_key|apikey)(_|-|$)/i;
const SENSITIVE_VALUE = /(cmdr_[A-Za-z0-9_-]{16,}|Bearer\s+\S{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const MAX_STRING = 300;
const MAX_DEPTH = 4;

export const REDACTED = '[redacted]';

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value)) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  }
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeValue(v, depth + 1));
  if (typeof value === 'object') return sanitizeAuditDetails(value as Record<string, unknown>, depth + 1);
  return undefined; // function/symbol/bigint/undefined: tashlanadi
}

export function sanitizeAuditDetails(details: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    const clean = sanitizeValue(value, depth);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}
