import { INVESTIGATION_LIMITS } from '@commander/contracts';
import type { AlertKind, HealthContainer, HealthSnapshot, IncidentKind, IncidentSeverity } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';

/**
 * Tekshiruv promptini yig'ish (6.4, SOF funksiyalar). Prompt markazda yaratiladi, mijozdan kelmaydi. Faqat nomlar va raqamlar:
 * hodisa turi/ob'ekti, o'lchovlar, so'nggi konteyner holat qatorlari. Env, argument, label, log matni YO'Q; tashqi nomlar
 * (konteyner, unit, jarayon) xavfsiz belgilarga tozalanadi (prompt-injection yuzasi kichik) va hammasi `redactAndCap` dan o'tadi.
 */

export type IncidentFacts =
  | { kind: 'health'; incidentKind: IncidentKind; subject: string; severity: IncidentSeverity; summary: string; openedAt: string; resolved: boolean }
  | {
      kind: 'watchdog';
      alertKind: AlertKind;
      title: string;
      detail: string;
      metrics: Record<string, number | string | null>;
      projectName: string | null;
      sessionName: string | null;
      openedAt: string;
      resolved: boolean;
    };

export interface PromptInput {
  machineName: string;
  facts: IncidentFacts;
  snapshot: HealthSnapshot | null;
}

const KIND_UZ: Record<IncidentKind, string> = { disk: 'Disk', memory: 'Xotira', cpu: 'CPU', container: 'Konteyner', systemd: 'systemd', offline: 'Aloqa (offline)' };
const ALERT_UZ: Record<AlertKind, string> = { waiting: 'sessiya uzoq kutmoqda', burn: 'token sarfi ortiqcha', error_loop: 'sessiya xatoni takrorlayapti' };

/** Tashqi nom: faqat xavfsiz belgilar (boshqalari `_`), chegaralangan. */
export const safeName = (s: string, max = 64): string => s.replace(/[^A-Za-z0-9_.:@/-]/g, '_').slice(0, max);

/** Erkin matn (hodisa xulosasi/sarlavhasi): backtick, `$`, `|`, `;`, `&`, boshqaruv belgilari olib tashlanadi (xavfli-andoza va in'ektsiya yuzasi). */
export const safeText = (s: string, max = 300): string => s.replace(/[`$|;&<>\\\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const pct = (n: number): string => `${Math.round(n)}%`;
const gb = (b: number): string => `${(b / 1024 ** 3).toFixed(1)} GB`;

/** Konteyner holat qatori: `nom — state — status — qayta ishga tushish: N [— unhealthy]`. */
export function containerLine(c: HealthContainer): string {
  return `${safeName(c.name)} — ${safeName(c.state, 16)} — ${safeName(c.status, 80).replace(/_/g, ' ')} — restart: ${c.restartCount}${c.health === 'unhealthy' ? ' — UNHEALTHY' : ''}`;
}

/** Hodisaga aloqador konteynerlar: `container` hodisasida shu konteyner, aks holda muammoli (exited/restarting/unhealthy/dead). Eng ko'pi `maxContainerLines`. */
export function relevantContainers(snapshot: HealthSnapshot | null, incident: IncidentFacts): HealthContainer[] {
  const all = snapshot?.docker?.containers ?? [];
  if (all.length === 0) return [];
  if (incident.kind === 'health' && incident.incidentKind === 'container' && incident.subject) {
    const hit = all.filter((c) => c.name === incident.subject);
    if (hit.length > 0) return hit.slice(0, INVESTIGATION_LIMITS.maxContainerLines);
  }
  const bad = all.filter((c) => c.health === 'unhealthy' || ['exited', 'restarting', 'dead', 'paused'].includes(c.state) || c.restartCount >= 3);
  return (bad.length > 0 ? bad : all).slice(0, INVESTIGATION_LIMITS.maxContainerLines);
}

function metricLines(snapshot: HealthSnapshot | null, incident: IncidentFacts): string[] {
  if (!snapshot) return ['(joriy o\'lchovlar mavjud emas)'];
  const out: string[] = [];
  const memPct = snapshot.memory.totalBytes > 0 ? (snapshot.memory.usedBytes / snapshot.memory.totalBytes) * 100 : 0;
  out.push(`CPU: ${snapshot.cpu.pct === null ? "noma'lum" : pct(snapshot.cpu.pct)}, load1=${snapshot.cpu.load1 ?? '-'}, yadrolar=${snapshot.cpu.cores}`);
  out.push(`Xotira: ${pct(memPct)} (${gb(snapshot.memory.usedBytes)} / ${gb(snapshot.memory.totalBytes)}), swap: ${gb(snapshot.memory.swapUsedBytes)} / ${gb(snapshot.memory.swapTotalBytes)}`);
  const disks = incident.kind === 'health' && incident.incidentKind === 'disk' && incident.subject ? snapshot.disks.filter((d) => d.mount === incident.subject) : snapshot.disks;
  for (const d of (disks.length > 0 ? disks : snapshot.disks).slice(0, 6)) out.push(`Disk ${safeName(d.mount, 80)}: ${pct(d.pct)} (${gb(d.usedBytes)} / ${gb(d.totalBytes)})`);
  const cpuTop = snapshot.topProcesses.byCpu.slice(0, 3).map((p) => `${safeName(p.name, 32)} ${p.cpuPct.toFixed(0)}%`);
  const memTop = snapshot.topProcesses.byMem.slice(0, 3).map((p) => `${safeName(p.name, 32)} ${p.memPct.toFixed(0)}%`);
  if (cpuTop.length > 0) out.push(`Top CPU jarayonlar: ${cpuTop.join(', ')}`);
  if (memTop.length > 0) out.push(`Top xotira jarayonlar: ${memTop.join(', ')}`);
  const failed = snapshot.systemd?.failed ?? [];
  if (failed.length > 0) out.push(`Muvaffaqiyatsiz systemd birliklari: ${failed.slice(0, 12).map((u) => safeName(u, 64)).join(', ')}`);
  return out;
}

/**
 * DIQQAT: ko'rsatmada xavfli-andoza qoidalariga (`DANGER_RULES`: backtick, `$(...)`, systemctl, sudo, curl, ssh, env ...) tushadigan
 * matn bo'lmasligi shart: aks holda karta "dashboard'da to'liq ko'rib chiqing" talab qiladi va Telegram inline tasdig'i ishlamaydi.
 * Shu sabab aniq buyruqlar emas, tavsif beriladi (testlar buni tekshiradi).
 */
const INSTRUCTIONS = [
  "Vazifang: bu hodisaning SABABINI aniqla va yechimlarni TAKLIF QIL.",
  "Qoidalar:",
  "- Hech narsani O'ZGARTIRMA: fayl yozma, servisni qayta ishga tushirma, konteynerni to'xtatma, paket o'rnatma, fayl o'chirma. Faqat o'qish va tashxis.",
  "- Faqat o'qiydigan amallardan foydalan: disk va jarayon holati, konteyner ro'yxati va ularning so'nggi loglari, servis holati va jurnali. Ruxsat so'rasang egasi hal qiladi.",
  "- Sirlarni (token, parol, .env qiymatlari) o'qima va javobingga yozma.",
  "- Oxirida qisqa xulosa ber: 1) ehtimoliy sabab, 2) dalillar, 3) taklif qilinadigan tuzatishlar (aniq amallar bilan, lekin ularni ISHGA TUSHIRMA), 4) xavf va qaytarish yo'li.",
  "- Har qanday o'zgartirish alohida egasi tasdig'ini talab qiladi: u haqda faqat taklif yoz.",
];

/** Yakuniy prompt (redakt qilingan, chegaralangan). */
export function buildInvestigationPrompt(i: PromptInput): string {
  const f = i.facts;
  const head: string[] = [`# Hodisa tekshiruvi — ${safeName(i.machineName, 64)}`, ''];
  if (f.kind === 'health') {
    head.push(`Tur: server hodisasi [${KIND_UZ[f.incidentKind]}], jiddiylik: ${f.severity === 'critical' ? 'KRITIK' : 'ogohlantirish'}`);
    if (f.subject) head.push(`Ob'ekt: ${safeName(f.subject, 128)}`);
    head.push(`Xulosa: ${safeText(f.summary)}`);
    head.push(`Ochilgan: ${f.openedAt}${f.resolved ? ' (hozir tiklangan)' : ''}`);
  } else {
    head.push(`Tur: watchdog ogohlantirishi — ${ALERT_UZ[f.alertKind]}`);
    head.push(`Sarlavha: ${safeText(f.title, 160)}`);
    head.push(`Tafsilot: ${safeText(f.detail)}`);
    const ctx = [f.projectName ? `loyiha: ${safeName(f.projectName, 64)}` : null, f.sessionName ? `sessiya: ${safeName(f.sessionName, 64)}` : null].filter(Boolean);
    if (ctx.length > 0) head.push(`Kontekst: ${ctx.join(', ')}`);
    const m = Object.entries(f.metrics).filter(([, v]) => v !== null).slice(0, 10).map(([k, v]) => `${safeName(k, 24)}=${typeof v === 'number' ? v : safeName(String(v), 40)}`);
    if (m.length > 0) head.push(`O'lchovlar: ${m.join(', ')}`);
    head.push(`Ochilgan: ${f.openedAt}${f.resolved ? ' (hozir yopilgan)' : ''}`);
  }
  const lines = [...head, '', '## Mashinaning joriy holati (markaz o\'lchovlari)', ...metricLines(i.snapshot, f).map((l) => `- ${l}`)];
  const cs = relevantContainers(i.snapshot, f);
  if (cs.length > 0) lines.push('', '## Konteyner holat qatorlari', ...cs.map((c) => `- ${containerLine(c)}`));
  lines.push('', '## Ko\'rsatma', ...INSTRUCTIONS, '', '(Ma\'lumotlar markaz tomonidan redakt qilingan; log matni, env va argumentlar kiritilmagan.)');
  return redactAndCap(lines.join('\n'), INVESTIGATION_LIMITS.promptMaxChars);
}

/** Sessiya nomi (`-n`): `incident-<tur>-<id boshi>` (SESSION_NAME_RE ga mos). */
export function investigationSessionName(kind: 'health' | 'watchdog', label: string, id: string): string {
  const base = `incident-${kind === 'health' ? label : 'watchdog'}-${id.replace(/-/g, '').slice(0, 6)}`.replace(/[^A-Za-z0-9._-]/g, '-');
  return base.slice(0, 60);
}
