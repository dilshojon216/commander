import { buildPreview } from '../common/preview.js';
import type { LimitWindowView, QueueItemDto, QueueTrigger } from '@commander/contracts';
import { CRON_PRESETS } from '@commander/contracts';
import type { ForecastAlert } from '../limits/forecast-logic.js';

/** `/queue` va `/new` navbat oqimi uchun sof formatlash (HTML). Prompt HECH QACHON yo'q: faqat redakt qilingan ko'rinish. */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Toshkent (UTC+5) devor soati: `15:40`, bugundan boshqa kun bo'lsa `14-noy 02:00`. */
export function fmtTashkent(iso: string, now: Date): string {
  const t = new Date(Date.parse(iso) + 5 * 3_600_000);
  const n = new Date(now.getTime() + 5 * 3_600_000);
  const hm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  if (t.getUTCFullYear() === n.getUTCFullYear() && t.getUTCMonth() === n.getUTCMonth() && t.getUTCDate() === n.getUTCDate()) return hm;
  const months = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];
  return `${t.getUTCDate()}-${months[t.getUTCMonth()]} ${hm}`;
}

export function triggerLabel(t: QueueTrigger, nextRunAt: string | null, now: Date): string {
  switch (t.type) {
    case 'now':
      return 'hozir';
    case 'limit_reset':
      return `${t.window === '5h' ? '5 soatlik' : 'haftalik'} limit yangilanganda${nextRunAt ? ` (≈ ${fmtTashkent(nextRunAt, now)})` : ''}`;
    case 'at':
      return `${fmtTashkent(t.at, now)} da`;
    case 'cron': {
      const preset = CRON_PRESETS.find((p) => p.cron === t.cron);
      return `takroriy: ${preset ? preset.label : t.cron}`;
    }
    case 'machine_idle':
      return 'mashina bo\'sh bo\'lganda';
  }
}

const STATUS_LABEL: Record<QueueItemDto['status'], string> = {
  queued: 'navbatda',
  waiting_trigger: 'kutilmoqda',
  starting: 'ishga tushmoqda',
  started: 'boshlandi',
  failed: 'xato',
  cancelled: 'bekor qilindi',
};

export function formatQueueList(items: QueueItemDto[], now: Date): string {
  if (items.length === 0) return '🕒 Navbat bo\'sh.';
  const lines = ['🕒 <b>Navbat</b>'];
  items.forEach((it, i) => {
    const err = it.lastErrorCode && it.status !== 'started' ? ` · ${esc(it.lastErrorCode)}` : '';
    lines.push(`${i + 1}. <b>${esc(it.machineSlug)}</b> · ${esc(triggerLabel(it.trigger, it.nextRunAt, now))} · ${STATUS_LABEL[it.status]}${err}`);
    // M-16: kesilgan bo'lsa aniq belgi (+N belgi) va xavfli andoza ogohlantirishi; bidi/boshqaruv belgilari olib tashlanadi.
    const pv = buildPreview(it.promptPreview, 80, it.promptLength);
    lines.push(`   <code>${esc(it.cwd.length > 60 ? `…${it.cwd.slice(-59)}` : it.cwd)}</code> — ${esc(pv.shown)}${pv.truncationNote ? ` <i>${esc(pv.truncationNote)}</i>` : ''}`);
    if (pv.flags.length > 0) lines.push(`   ⚠ ${esc(pv.flags.map((f) => f.label).join('; '))}`);
  });
  return lines.join('\n');
}

export function formatQueued(it: QueueItemDto, now: Date): string {
  return [`🕒 <b>Navbatga qo'yildi</b>`, `Mashina: <b>${esc(it.machineSlug)}</b>`, `Qachon: ${esc(triggerLabel(it.trigger, it.nextRunAt, now))}`, 'Bekor qilish: /queue'].join('\n');
}

const resetLine = (v: LimitWindowView, now: Date): string => (v.resetsAt ? `Yangilanish: ${fmtTashkent(v.resetsAt, now)}` : 'Yangilanish vaqti noma\'lum');

/** 5 soatlik oyna ~30 daqiqada tugashi bashorati (taxmin: "≈"). */
export function formatForecastAlert(a: ForecastAlert, now: Date): string {
  return [
    `⏳ <b>5 soatlik limit ≈ ${fmtTashkent(a.forecast.exhaustsAt, now)} da tugaydi</b> (hozir ${Math.round(a.view.usedPct)}%)`,
    resetLine(a.view, now),
    `Tezlik ≈ ${a.forecast.ratePctPerHour}%/soat · ishonch: ${a.forecast.confidence === 'high' ? 'yuqori' : 'o\'rtacha'} · bu taxmin, rasmiy emas`,
  ].join('\n');
}

export function queueErrorTextUz(code: string): string {
  switch (code) {
    case 'step_up_required':
      return 'Tasdiq talab qilinadi';
    case 'policy_disabled':
      return 'Bu mashinada masofaviy ishga tushirish yoqilmagan';
    case 'queue_full':
      return 'Navbat to\'la';
    case 'too_many_recurring':
      return 'Takroriy vazifalar juda ko\'p';
    case 'at_in_past':
      return 'Vaqt o\'tib ketgan';
    default:
      return 'Navbatga qo\'yib bo\'lmadi';
  }
}
