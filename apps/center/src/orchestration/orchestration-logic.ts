import { ORCH_LIMITS, ORCH_SCOPE_MODES, STEP_ACTIVE_STATUSES } from '@commander/contracts';
import type { OrchCounts, OrchScope, OrchStatus, OrchStepDto, OrchestrationDto, PlanStepInput, StepStatus } from '@commander/contracts';

/** Sof mantiq (DB'siz): reja tekshiruvi, dispatch qoidalari, identity tekshiruvi, holat hisobi, matn formatlari. */

export class OrchError extends Error {
  constructor(
    readonly code: 'orch_not_found' | 'orch_forbidden' | 'orch_invalid' | 'orch_conflict' | 'orch_limit' | 'orch_blocked',
    message: string,
  ) {
    super(message);
  }
}

export interface PlannedStep {
  key: string;
  position: number;
  title: string;
  role: string;
  machine: string | null;
  cwd: string | null;
  dependsOn: string[];
}

/**
 * Reja tekshiruvi: <= maxSteps, kalitlar yagona (yo'q bo'lsa `s<N>`), bog'liqliklar mavjud qadamga ishora qiladi,
 * o'ziga bog'liqlik YO'Q, sikl YO'Q (Kahn algoritmi). Xato: `OrchError('orch_invalid')`.
 */
export function validatePlan(steps: readonly PlanStepInput[], maxSteps: number = ORCH_LIMITS.maxSteps): PlannedStep[] {
  if (steps.length === 0) throw new OrchError('orch_invalid', "Reja bo'sh");
  if (steps.length > maxSteps) throw new OrchError('orch_limit', `Qadamlar soni chegaradan oshdi: eng ko'pi ${maxSteps}`);
  const keys = new Set<string>();
  const planned: PlannedStep[] = steps.map((s, i) => {
    const key = s.key ?? `s${i + 1}`;
    const norm = key.toLowerCase();
    if (keys.has(norm)) throw new OrchError('orch_invalid', `Qadam kaliti takrorlandi: "${key}"`);
    keys.add(norm);
    return { key, position: i, title: s.title, role: s.role, machine: s.machine ?? null, cwd: s.cwd ?? null, dependsOn: [...new Set((s.depends_on ?? []).map((d) => d))] };
  });
  const byLower = new Map(planned.map((p) => [p.key.toLowerCase(), p]));
  for (const p of planned) {
    p.dependsOn = p.dependsOn.map((d) => {
      const hit = byLower.get(d.toLowerCase());
      if (!hit) throw new OrchError('orch_invalid', `"${p.key}" mavjud bo'lmagan qadamga bog'liq: "${d}"`);
      if (hit === p) throw new OrchError('orch_invalid', `"${p.key}" o'ziga bog'liq bo'la olmaydi`);
      return hit.key;
    });
  }
  // Kahn: qolgan (indegree > 0) qadamlar = sikl
  const indeg = new Map(planned.map((p) => [p.key, p.dependsOn.length]));
  const queue = planned.filter((p) => p.dependsOn.length === 0).map((p) => p.key);
  let seen = 0;
  while (queue.length > 0) {
    const k = queue.shift() as string;
    seen++;
    for (const p of planned) {
      if (!p.dependsOn.includes(k)) continue;
      const n = (indeg.get(p.key) ?? 0) - 1;
      indeg.set(p.key, n);
      if (n === 0) queue.push(p.key);
    }
  }
  if (seen !== planned.length) {
    const stuck = planned.filter((p) => (indeg.get(p.key) ?? 0) > 0).map((p) => p.key);
    throw new OrchError('orch_invalid', `Bog'liqliklarda sikl bor: ${stuck.slice(0, 6).join(', ')}`);
  }
  return planned;
}

export interface StepLite {
  key: string;
  status: StepStatus;
  dependsOn: readonly string[];
}

export interface DispatchCheckInput {
  orchestrationStatus: OrchStatus;
  lockdown: boolean;
  step: StepLite;
  allSteps: readonly StepLite[];
  maxConcurrent: number;
  tokensUsed: number;
  tokenBudget: number;
  budgetExceededFlag: boolean;
}

/** Dispatch qoidalari (tartib muhim: eng aniq sabab birinchi). Xato = `OrchError`; muvaffaqiyat = `void`. */
export function checkDispatch(i: DispatchCheckInput): void {
  if (i.lockdown) throw new OrchError('orch_blocked', "Lockdown yoqilgan: dispatch bloklangan");
  if (i.orchestrationStatus === 'cancelled') throw new OrchError('orch_blocked', "Orkestratsiya to'xtatilgan");
  if (i.orchestrationStatus === 'completed') throw new OrchError('orch_blocked', 'Orkestratsiya tugagan');
  if (i.orchestrationStatus === 'planning') throw new OrchError('orch_conflict', 'Reja hali tuzilmagan (commander_plan_create)');
  if (i.step.status !== 'pending' && i.step.status !== 'failed') throw new OrchError('orch_conflict', `Qadam "${i.step.key}" holati ${i.step.status}: topshirib bo'lmaydi`);
  const byKey = new Map(i.allSteps.map((s) => [s.key, s]));
  const unmet = i.step.dependsOn.filter((d) => byKey.get(d)?.status !== 'done');
  if (unmet.length > 0) throw new OrchError('orch_blocked', `Bog'liqliklar bajarilmagan: ${unmet.join(', ')}`);
  if (i.budgetExceededFlag || i.tokensUsed >= i.tokenBudget) {
    throw new OrchError('orch_blocked', `Token byudjeti tugadi (${i.tokensUsed} / ${i.tokenBudget}): yangi dispatch to'xtatilgan`);
  }
  const active = i.allSteps.filter((s) => STEP_ACTIVE_STATUSES.includes(s.status)).length;
  if (active >= i.maxConcurrent) throw new OrchError('orch_limit', `Bir vaqtda eng ko'pi ${i.maxConcurrent} ta faol qadam (hozir ${active}): biri tugashini kuting`);
}

/** Dispatch'ga tayyor qadamlar: pending/failed + hamma bog'liqlik `done`. */
export function readyStepKeys(steps: readonly StepLite[]): string[] {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  return steps.filter((s) => (s.status === 'pending' || s.status === 'failed') && s.dependsOn.every((d) => byKey.get(d)?.status === 'done')).map((s) => s.key);
}

export type UpdateStatusInput = 'in_progress' | 'done' | 'failed';

export interface UpdateCheckInput {
  callerSessionId: string;
  leadSessionId: string | null;
  assignedSessionId: string | null;
  orchestrationStatus: OrchStatus;
  stepStatus: StepStatus;
  newStatus: UpdateStatusInput;
}

/**
 * Qadam yangilash huquqi: FAQAT qadamga tayinlangan sessiya yoki orkestratsiya lead'i. Boshqa sessiya (hatto shu guruhdan) rad.
 * Yakuniy qadam (`done|failed|cancelled`) qayta o'zgarmaydi; to'xtatilgan/tugagan orkestratsiyada yangilash yo'q.
 * Qaytadi: yangi qadam holati.
 */
export function checkStepUpdate(i: UpdateCheckInput): StepStatus {
  const isAssigned = i.assignedSessionId !== null && i.assignedSessionId === i.callerSessionId;
  const isLead = i.leadSessionId !== null && i.leadSessionId === i.callerSessionId;
  if (!isAssigned && !isLead) throw new OrchError('orch_forbidden', "Bu qadamni faqat unga tayinlangan sessiya yoki bosh sessiya yangilay oladi");
  if (i.orchestrationStatus === 'cancelled') throw new OrchError('orch_blocked', "Orkestratsiya to'xtatilgan");
  if (i.orchestrationStatus === 'completed') throw new OrchError('orch_blocked', 'Orkestratsiya tugagan');
  if (i.stepStatus === 'done' || i.stepStatus === 'cancelled') throw new OrchError('orch_conflict', `Qadam yakunlangan (${i.stepStatus})`);
  // `failed` tiklanadi (masalan tizim ishchini adashib yo'qolgan deb belgilagan): vakolatli chaqiruvchi `in_progress|done` qila oladi
  if (i.stepStatus === 'failed' && i.newStatus === 'failed') throw new OrchError('orch_conflict', 'Qadam allaqachon "failed"');
  if (i.stepStatus === 'pending' && !isLead) throw new OrchError('orch_conflict', 'Qadam hali topshirilmagan');
  return i.newStatus === 'in_progress' ? 'running' : i.newStatus;
}

export function countSteps(steps: ReadonlyArray<{ status: StepStatus }>): OrchCounts {
  const c: OrchCounts = { pending: 0, dispatched: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const s of steps) c[s.status]++;
  return c;
}

/**
 * Orkestratsiya holati qadamlardan. `cancelled` va `completed` yakuniy. Faol qadam yo'q + `failed` qadam bor => `failed`
 * (lead qayta topshirsa yana `running`). Qadamsiz = `planning`.
 */
export function deriveStatus(current: OrchStatus, steps: ReadonlyArray<{ status: StepStatus }>): OrchStatus {
  if (current === 'cancelled' || current === 'completed') return current;
  if (steps.length === 0) return 'planning';
  const c = countSteps(steps);
  if (c.done === steps.length) return 'completed';
  const active = c.dispatched + c.running;
  if (active === 0 && c.failed > 0) return 'failed';
  return 'running';
}

export const isOverBudget = (used: number, budget: number): boolean => used >= budget;

/** `existing_session` nomzodi (guruh a'zosi). */
export interface Candidate {
  sessionId: string;
  claudeSessionId: string;
  role: string | null;
  kind: string;
  status: string;
  machineId: string;
  isLead: boolean;
  /** Boshqa faol qadamga tayinlanganmi. */
  busyWithStep: boolean;
}

const IDLE = new Set(['idle', 'waiting', 'done']);
const HEX = /^[0-9a-f][0-9a-f-]{7,}$/;

/**
 * Mavjud sessiyani tanlash: lead'ning o'zi emas, `bg` (boshqariladigan), bo'sh holat (`idle|waiting|done`), boshqa qadam bilan band emas.
 * `session` (qisqa/to'liq id) berilsa FAQAT guruh nomzodlari orasidan aniq moslik (noaniq = rad); aks holda `role` bo'yicha birinchisi.
 */
export function pickCandidate(candidates: readonly Candidate[], i: { session?: string | undefined; role: string }): Candidate {
  const eligible = (c: Candidate): boolean => !c.isLead && c.kind === 'bg' && IDLE.has(c.status) && !c.busyWithStep;
  if (i.session) {
    const q = i.session.trim().toLowerCase();
    if (!HEX.test(q)) throw new OrchError('orch_invalid', 'session: sessiya qisqa id\'si (commander_peers) bo\'lishi kerak');
    const matches = candidates.filter((c) => c.claudeSessionId.toLowerCase().startsWith(q));
    if (matches.length === 0) throw new OrchError('orch_invalid', `Guruhda "${i.session.slice(0, 20)}" id'li sessiya yo'q`);
    if (matches.length > 1) throw new OrchError('orch_invalid', "Sessiya id'si bir nechta sessiyaga mos: uzunroq yozing");
    const m = matches[0] as Candidate;
    if (m.isLead) throw new OrchError('orch_invalid', "Bosh sessiyaning o'ziga topshirib bo'lmaydi");
    if (!eligible(m)) throw new OrchError('orch_conflict', `Sessiya band yoki boshqarib bo'lmaydi (holat: ${m.status}, tur: ${m.kind})`);
    return m;
  }
  const byRole = candidates.filter((c) => c.role === i.role);
  if (byRole.length === 0) throw new OrchError('orch_invalid', `Guruhda "${i.role}" rolli sessiya yo'q (new_session yoki queue rejimini tanlang)`);
  const hit = byRole.find(eligible);
  if (!hit) throw new OrchError('orch_conflict', `"${i.role}" rolli sessiyalar band yoki boshqarib bo'lmaydi (new_session yoki queue rejimini tanlang)`);
  return hit;
}

// --- formatlar -------------------------------------------------------------------------------------

const STEP_MARK: Record<StepStatus, string> = { pending: '[ ]', dispatched: '[>]', running: '[~]', done: '[x]', failed: '[!]', cancelled: '[-]' };

/** Lead/ishchi uchun matn (Uzbek). Qadam id'si to'liq (vositalarga beriladi). Natija matni qisqartiriladi. */
export function formatStatusText(o: OrchestrationDto, viewerStepId?: string): string {
  const c = o.counts;
  const head = `Orkestratsiya #${o.id.slice(0, 8)} | holat: ${o.status} | maqsad: ${o.goal.replace(/\s+/g, ' ').slice(0, 160)}`;
  const prog = `Qadamlar: ${c.done}/${o.steps.length} bajarildi, ${c.running + c.dispatched} faol, ${c.pending} kutmoqda, ${c.failed} xato, ${c.cancelled} bekor | tokenlar: ${o.tokensUsed}/${o.tokenBudget}${o.budgetExceeded ? ' (BYUDJET TUGADI)' : ''} | parallel: ${o.maxConcurrent}`;
  const rows = o.steps.map((s) => {
    const dep = s.dependsOn.length > 0 ? ` <- ${s.dependsOn.join(',')}` : '';
    const who = s.assignedLabel ? ` @${s.assignedLabel}` : '';
    const res = s.resultSummary ? ` | ${s.resultSummary.replace(/\s+/g, ' ').slice(0, 120)}` : '';
    const err = s.lastError && s.status !== 'done' ? ` | xato: ${s.lastError.slice(0, 80)}` : '';
    const me = viewerStepId === s.id ? ' (SIZNING QADAMINGIZ)' : '';
    return `${STEP_MARK[s.status]} ${s.key} (${s.role}) ${s.title.slice(0, 80)}${dep}${who} | id ${s.id}${res}${err}${me}`;
  });
  return [head, prog, ...rows].join('\n');
}

export function orchSummaryLine(o: Pick<OrchestrationDto, 'id' | 'status' | 'goal' | 'counts' | 'steps'>): string {
  return `#${o.id.slice(0, 8)} ${o.status} ${o.counts.done}/${o.steps.length} · ${o.goal.replace(/\s+/g, ' ').slice(0, 60)}`;
}

export const stepKeyMatches = (s: Pick<OrchStepDto, 'id' | 'key'>, ref: string): boolean => {
  const r = ref.trim().toLowerCase();
  return s.id.toLowerCase() === r || s.key.toLowerCase() === r || (r.length >= 8 && s.id.toLowerCase().startsWith(r));
};

/**
 * `cwd` guruh loyihalaridan birining ichidami (yo'l bo'laklari bo'yicha; `..` rad; Windows `\` ni `/` ga keltiradi).
 * Yangi sessiya faqat guruh loyihalari ichiga ochiladi: lead (prompt-injection yuzasi) ixtiyoriy katalogga sessiya och olmasin.
 */
export function cwdWithinProjects(cwd: string, projectPaths: readonly string[]): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const c = norm(cwd);
  if (c.length === 0 || c.split('/').includes('..') || c.includes('\0')) return false;
  return projectPaths.some((raw) => {
    const p = norm(raw);
    return p.length > 0 && (c === p || c.startsWith(`${p}/`));
  });
}

/** Telegram (HTML, faqat raqam va nomlar; maqsad qisqartirilgan va allaqachon redakt qilingan). */
export type OrchNoticeKind = 'started' | 'completed' | 'failed' | 'cancelled' | 'budget';

// --- H-05: tasdiq qamrovi ----------------------------------------------------------------------------

export type ScopeMiss = 'no_scope' | 'machine' | 'cwd' | 'mode' | 'max_sessions';

/**
 * Qamrovni hisoblaydi (tasdiq paytida): guruh loyihalari joylashgan mashinalar, ularning ANIQ papkalari, faqat default/plan
 * rejimlari va yangi sessiyalar soni. Egasi shuni kartada ko'radi va aynan shu doira ijro etiladi.
 */
export function buildScope(rows: ReadonlyArray<{ machineId: string; machineName: string; path: string }>, maxNewSessions: number): OrchScope {
  const machines = new Map<string, string>();
  const roots: Array<{ machineId: string; path: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    machines.set(r.machineId, r.machineName);
    const k = `${r.machineId}\0${r.path}`;
    if (!seen.has(k)) {
      seen.add(k);
      roots.push({ machineId: r.machineId, path: r.path });
    }
  }
  return {
    machines: [...machines].map(([id, name]) => ({ id, name })),
    cwdRoots: roots,
    modes: [...ORCH_SCOPE_MODES],
    maxNewSessions: Math.max(0, Math.min(ORCH_LIMITS.maxNewSessionsCap, maxNewSessions)),
  };
}

/** Dispatch tasdiq qamroviga kiradimi. Kirmasa sabab: shunda dispatch YANGI Telegram tasdig'i talab qiladi (yoki rad). */
export function checkScope(
  scope: OrchScope | null,
  i: { confirmed: boolean; machineId: string; cwd: string; permissionMode: string; newSessionsUsed: number },
): { covered: true } | { covered: false; reason: ScopeMiss } {
  if (!scope || !i.confirmed) return { covered: false, reason: 'no_scope' };
  if (!scope.machines.some((m) => m.id === i.machineId)) return { covered: false, reason: 'machine' };
  if (!(ORCH_SCOPE_MODES as readonly string[]).includes(i.permissionMode) || !scope.modes.includes(i.permissionMode as 'default' | 'plan')) return { covered: false, reason: 'mode' };
  if (!cwdWithinProjects(i.cwd, scope.cwdRoots.filter((r) => r.machineId === i.machineId).map((r) => r.path))) return { covered: false, reason: 'cwd' };
  if (i.newSessionsUsed >= scope.maxNewSessions) return { covered: false, reason: 'max_sessions' };
  return { covered: true };
}

/** Tasdiq kartasi/dashboard uchun qamrov qatorlari (oddiy matn). */
export function formatScopeLines(scope: OrchScope): string[] {
  const roots = scope.cwdRoots.map((r) => `${scope.machines.find((m) => m.id === r.machineId)?.name ?? r.machineId.slice(0, 8)}:${r.path}`);
  return [
    "Bu tasdiq faqat quyidagi doirani qoplaydi (qolgan har bir topshiriq alohida tasdiq so'raydi):",
    `Mashinalar: ${scope.machines.map((m) => m.name).join(', ') || "yo'q"}`,
    `Papkalar: ${roots.slice(0, 8).join('; ')}${roots.length > 8 ? ` (+${roots.length - 8})` : ''}`,
    `Rejimlar: ${scope.modes.join(', ')} (acceptEdits har safar alohida tasdiqlanadi)`,
    `Yangi sessiyalar: ko'pi bilan ${scope.maxNewSessions} ta`,
  ];
}

export const SCOPE_MISS_TEXT: Record<ScopeMiss, string> = {
  no_scope: 'orkestratsiya tasdiqlanmagan yoki qamrovi yo\'q',
  machine: 'mashina tasdiq qamrovida emas',
  cwd: 'papka tasdiq paytidagi loyiha papkalaridan tashqarida',
  mode: 'rejim tasdiq qamrovida emas (faqat default/plan)',
  max_sessions: 'tasdiqlangan yangi sessiyalar soni tugadi',
};
