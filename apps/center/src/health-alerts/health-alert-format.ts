import type { IncidentKind, IncidentSeverity } from '@commander/contracts';
import { escapeHtml } from '../telegram/telegram-format.js';

const KIND_LABEL: Record<IncidentKind, string> = {
  disk: 'Disk',
  memory: 'Xotira',
  cpu: 'CPU',
  container: 'Konteyner',
  systemd: 'systemd',
  offline: 'Aloqa',
};

export interface IncidentText {
  machineName: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  summary: string;
}

/** Davomiylik: `3 daq`, `2 soat 5 daq`, `1 kun 4 soat`. */
export function formatDuration(ms: number): string {
  if (ms < 45_000) return '1 daqiqadan kam';
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} daq`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} soat${min % 60 ? ` ${min % 60} daq` : ''}`;
  return `${Math.floor(h / 24)} kun${h % 24 ? ` ${h % 24} soat` : ''}`;
}

/** Telegram HTML. Faqat nomlar va raqamlar (env, argument, label yo'q). */
export function formatIncidentOpened(i: IncidentText, escalated = false): string {
  const icon = i.severity === 'critical' ? '\u{1F534}' : '\u{1F7E0}';
  const head = escalated ? 'Jiddiylashdi' : i.kind === 'offline' ? 'Mashina aloqada emas' : 'Server ogohlantirishi';
  return `${icon} <b>${escapeHtml(head)}</b> [${escapeHtml(KIND_LABEL[i.kind])}]\n<b>${escapeHtml(i.machineName)}</b>\n${escapeHtml(i.summary)}`;
}

export function formatIncidentResolved(i: IncidentText, openedAt: Date, now: Date): string {
  const head = i.kind === 'offline' ? 'Mashina qayta aloqada' : 'Tiklandi';
  return `\u{1F7E2} <b>${escapeHtml(head)}</b> [${escapeHtml(KIND_LABEL[i.kind])}]\n<b>${escapeHtml(i.machineName)}</b>\n${escapeHtml(i.summary)}\nDavomiyligi: ${escapeHtml(formatDuration(now.getTime() - openedAt.getTime()))}`;
}
