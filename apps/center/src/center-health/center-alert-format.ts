import type { CenterCheckKind } from '@commander/contracts';
import { formatDuration } from '../health-alerts/health-alert-format.js';
import { escapeHtml } from '../telegram/telegram-format.js';

const KIND_LABEL: Record<CenterCheckKind, string> = {
  db_disk: 'DB disk',
  backup: 'Zaxira',
  dashboard: 'Dashboard',
  tailscale: 'Tailscale serve',
  runtime: 'Markaz jarayoni',
  telegram: 'Telegram polling',
};

export interface CenterIncidentText {
  kind: CenterCheckKind;
  severity: 'warn' | 'critical';
  summary: string;
}

export function formatCenterOpened(i: CenterIncidentText, escalated = false): string {
  const icon = i.severity === 'critical' ? '\u{1F534}' : '\u{1F7E0}';
  return `${icon} <b>${escalated ? 'Jiddiylashdi' : 'Markaz ogohlantirishi'}</b> [${escapeHtml(KIND_LABEL[i.kind])}]\n${escapeHtml(i.summary)}`;
}

export function formatCenterResolved(i: CenterIncidentText, openedAt: Date, now: Date): string {
  return `\u{1F7E2} <b>Tiklandi</b> [${escapeHtml(KIND_LABEL[i.kind])}]\n${escapeHtml(i.summary)}\nDavomiyligi: ${escapeHtml(formatDuration(now.getTime() - openedAt.getTime()))}`;
}
