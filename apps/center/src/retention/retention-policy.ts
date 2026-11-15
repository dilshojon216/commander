/**
 * Retention/compression siyosati: yagona hujjatlashtirilgan manba (PLAN.md 5.2 ADR). Migratsiya
 * (`1731404010000-RetentionCompression`) shu raqamlarni o'rnatadi; `checkRetentionInvariants` ularni DB'dagi haqiqiy
 * TimescaleDB job'lari bilan solishtiradi (boot logi, `retention status` CLI, db-spec).
 */

export interface HypertablePolicy {
  /** Raw qatorlarni saqlash muddati (kun). */
  dropAfterDays: number;
  /** Shundan keyin chunk siqiladi (kun); `null` = siqilmaydi. */
  compressAfterDays: number | null;
}

export const HYPERTABLE_POLICIES: Readonly<Record<string, HypertablePolicy>> = {
  session_events: { dropAfterDays: 90, compressAfterDays: 7 },
  token_usage: { dropAfterDays: 30, compressAfterDays: 7 },
  machine_health: { dropAfterDays: 14, compressAfterDays: 3 },
  limit_samples: { dropAfterDays: 180, compressAfterDays: null },
};

/** Continuous aggregate -> manba hypertable. Cagg'larga retention YO'Q (statistika doimiy); refresh oynasi manba retention'idan kichik bo'lishi shart. */
export const CAGG_SOURCES: Readonly<Record<string, string>> = {
  usage_5m: 'token_usage',
  usage_1h: 'token_usage',
  token_usage_daily_by_project: 'token_usage',
  machine_health_5m: 'machine_health',
};

/** Oddiy jadvallar (kunlik `commander_retention_sweep`): hujjat uchun, migratsiya protsedurasi shu qiymatlarni qo'llaydi. */
export const SWEEP_POLICIES = {
  approvals: '90 days (pending emas)',
  session_messages: '30 days',
  reports: '365 days (generated_at)',
  'commands.result': 'katta (> 2 KB) natija 90 kundan keyin {trimmed} bilan almashtiriladi',
  audit_log: 'hech qachon (append-only)',
} as const;

export const SWEEP_PROC = 'commander_retention_sweep';

export interface JobRow {
  proc_name: string;
  /** Hypertable yoki (refresh job'lari uchun) cagg nomi. */
  target: string | null;
  config: Record<string, unknown> | null;
}

/** `30 days`, `1 day`, `7 days 00:00:00`, `168:00:00` -> kun (kasr bo'lishi mumkin). Tanib bo'lmasa null. */
export function parseIntervalDays(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let days = 0;
  let matched = false;
  const d = /(\d+)\s*days?/.exec(s);
  if (d) {
    days += Number(d[1]);
    matched = true;
  }
  const mons = /(\d+)\s*mons?/.exec(s);
  if (mons) {
    days += Number(mons[1]) * 30;
    matched = true;
  }
  const hms = /(\d+):(\d{2}):(\d{2})/.exec(s);
  if (hms) {
    days += (Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) / 86_400;
    matched = true;
  }
  return matched ? days : null;
}

/** Bo'sh ro'yxat = hamma siyosat joyida va o'zaro mos. Har element odam o'qiydigan muammo. */
export function checkRetentionInvariants(jobs: readonly JobRow[]): string[] {
  const problems: string[] = [];
  const find = (proc: string, target: string): JobRow | undefined => jobs.find((j) => j.proc_name === proc && j.target === target);

  for (const [table, p] of Object.entries(HYPERTABLE_POLICIES)) {
    const ret = find('policy_retention', table);
    const drop = parseIntervalDays(ret?.config?.['drop_after']);
    if (drop === null) problems.push(`${table}: retention policy yo'q`);
    else if (drop !== p.dropAfterDays) problems.push(`${table}: retention ${drop} kun (kutilgan ${p.dropAfterDays})`);

    const comp = find('policy_compression', table);
    const compressAfter = parseIntervalDays(comp?.config?.['compress_after']);
    if (p.compressAfterDays === null) {
      if (comp) problems.push(`${table}: kutilmagan compression policy`);
    } else if (compressAfter === null) problems.push(`${table}: compression policy yo'q`);
    else if (compressAfter !== p.compressAfterDays) problems.push(`${table}: compress_after ${compressAfter} kun (kutilgan ${p.compressAfterDays})`);
    else if (drop !== null && compressAfter >= drop) problems.push(`${table}: compress_after (${compressAfter}) retention'dan (${drop}) kichik bo'lishi shart`);
  }

  for (const [cagg, source] of Object.entries(CAGG_SOURCES)) {
    if (find('policy_retention', cagg)) problems.push(`${cagg}: continuous aggregate'ga retention qo'yilmasligi kerak (statistika doimiy)`);
    const refresh = find('policy_refresh_continuous_aggregate', cagg);
    const start = parseIntervalDays(refresh?.config?.['start_offset']);
    if (start === null) {
      problems.push(`${cagg}: refresh policy yo'q`);
      continue;
    }
    const sourceDrop = HYPERTABLE_POLICIES[source]!.dropAfterDays;
    if (start >= sourceDrop) problems.push(`${cagg}: refresh start_offset (${start} kun) ${source} retention'idan (${sourceDrop} kun) kichik bo'lishi shart: aks holda materializatsiya qilingan kunlar yo'qoladi`);
  }

  if (!jobs.some((j) => j.proc_name === SWEEP_PROC)) problems.push(`${SWEEP_PROC} job yo'q (approvals/session_messages/reports/commands.result)`);
  return problems;
}
