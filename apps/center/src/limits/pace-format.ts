import type { PaceStatus, WeeklyPace } from '@commander/contracts';

/**
 * Haftalik limit tezligi matnlari (Telegram, HTML). Faqat raqam va vaqt (foydalanuvchi matni yo'q). CLAUDE.md #6: taxmin
 * ("≈" + "taxmin, rasmiy emas") rasmiy raqamdek ko'rsatilmaydi. `telegram-format.ts` dan mustaqil (modul sikli yo'q).
 */

const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const when = (iso: string): string => dateTimeFmt.format(new Date(iso));

/** O'nli vergul (o'zbekcha): `9,8`. */
export const comma1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');

export const PACE_STATUS_TEXT: Record<PaceStatus, string> = { on_track: 'rejada', fast: 'tez ketmoqda', exceeded: 'ulush tugadi' };
const STATUS_ICON: Record<PaceStatus, string> = { on_track: '🟢', fast: '🟠', exceeded: '🔴' };

const approx = (p: WeeklyPace): string => (p.source === 'estimate' ? '≈' : '');

/** "Bugungi ulush: 9,8% / 18,0% (54%)". */
export function paceShareText(p: WeeklyPace): string {
  const a = approx(p);
  return `${a}${comma1(p.usedTodayPct)}% / ${a}${comma1(p.allowancePct)}% (${Math.round(p.pctOfAllowance)}%)`;
}

/** "Shu tezlikda 16.11 02:59 da tugaydi; yangilanish 15.11 18:00" yoki "hafta oxirigacha yetadi". */
export function paceForecastText(p: WeeklyPace): string | null {
  if (p.exhaustAt === null || p.exhaustBeforeReset === null) return null;
  if (!p.exhaustBeforeReset) return `shu tezlikda hafta oxirigacha yetadi; yangilanish ${when(p.resetsAt)}`;
  return `shu tezlikda ${when(p.exhaustAt)} da tugaydi; yangilanish ${when(p.resetsAt)}`;
}

/** `/limits` uchun qatorlar. */
export function formatPaceLines(p: WeeklyPace): string[] {
  const lines = [`${STATUS_ICON[p.status]} Bugungi ulush: <b>${paceShareText(p)}</b> · ${PACE_STATUS_TEXT[p.status]}`];
  lines.push(`  Bir tekis tezlik: ${approx(p)}${comma1(p.expectedPct)}%, hozir ${approx(p)}${comma1(p.currentPct)}%`);
  const f = paceForecastText(p);
  if (f) lines.push(`  ${f.charAt(0).toUpperCase()}${f.slice(1)}`);
  if (p.source === 'estimate') lines.push("  Manba: taxmin (rasmiy emas)");
  else if (p.stale) lines.push("  Rasmiy kuzatuv eskirgan");
  if (p.overriddenToday) lines.push("  Bugun uchun ruxsat berilgan");
  else if (p.blocked) lines.push("  Yangi sessiyalar kechiktirilmoqda (weekly_pace_exceeded)");
  return lines;
}

/** Ogohlantirish xabari (80% / 100%). */
export function formatPaceAlert(p: WeeklyPace, level: 'soft' | 'hard'): string {
  const icon = level === 'hard' ? '🚨' : '⚠️';
  const threshold = level === 'hard' ? p.hardPct : p.softPct;
  const lines = [
    `${icon} <b>Haftalik limitning bugungi ulushi: ${Math.round(p.pctOfAllowance)}%</b> (chegara ${Math.round(threshold)}%)`,
    `Bugungi ulush: ${paceShareText(p)}`,
    `Hafta: ${approx(p)}${comma1(p.currentPct)}%, bir tekis tezlikda ${approx(p)}${comma1(p.expectedPct)}%`,
  ];
  const f = paceForecastText(p);
  lines.push(f ? `${f.charAt(0).toUpperCase()}${f.slice(1)}` : `Yangilanish ${when(p.resetsAt)}`);
  lines.push(p.source === 'estimate' ? 'Manba: taxmin (rasmiy emas)' : 'Manba: rasmiy');
  if (level === 'hard' && p.enforce && !p.overriddenToday) lines.push('Yangi sessiya va navbat kechiktiriladi (bugun uchun ruxsat berish mumkin).');
  return lines.join('\n');
}
