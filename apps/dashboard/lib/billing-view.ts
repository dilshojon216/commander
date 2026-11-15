import { BILLING_LIMITS, CreateClientBodySchema } from "@commander/contracts";
import type { BillingCurrency, BillingProjectDto, ClientDto, CreateClientBody, TimesheetClient, TimesheetDto, TimesheetProject, TimesheetTotals } from "@commander/contracts";
import { formatCost, formatCount, formatTokens } from "./format";

/** Hisob-kitob (6.7) va mijoz hisoboti (6.8) uchun sof ko'rinish yordamchilari. */

const TASHKENT_OFFSET_MS = 5 * 3_600_000;
const MONTHS = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"];

export type PeriodMode = "month" | "range";
export interface PeriodForm {
  mode: PeriodMode;
  /** `YYYY-MM`. */
  month: string;
  from: string;
  to: string;
}

/** Toshkent vaqtidagi joriy oy (`YYYY-MM`). */
export function currentMonth(now: number = Date.now()): string {
  return new Date(now + TASHKENT_OFFSET_MS).toISOString().slice(0, 7);
}

export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : month;
}

/** Oxirgi `count` oy (joriy oydan boshlab), tanlov uchun. */
export function monthOptions(now: number = Date.now(), count = 12): Array<{ value: string; label: string }> {
  const cur = currentMonth(now);
  let y = Number(cur.slice(0, 4));
  let m = Number(cur.slice(5, 7));
  const out: Array<{ value: string; label: string }> = [];
  for (let i = 0; i < count; i++) {
    const value = `${y}-${String(m).padStart(2, "0")}`;
    out.push({ value, label: monthLabel(value) });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export function defaultPeriod(now: number = Date.now()): PeriodForm {
  const cur = currentMonth(now);
  const today = new Date(now + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
  return { mode: "month", month: cur, from: `${cur}-01`, to: today };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (d: string): boolean => DAY_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

/** Davrni tekshiradi; xato matni (o'zbekcha) yoki `null`. */
export function validatePeriod(p: PeriodForm): string | null {
  if (p.mode === "month") return /^\d{4}-(0[1-9]|1[0-2])$/.test(p.month) ? null : "Oyni tanlang";
  if (!isDay(p.from) || !isDay(p.to)) return "Sanalarni to'liq kiriting";
  if (p.to < p.from) return "Tugash sanasi boshlanishdan oldin bo'lmasin";
  const days = Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000) + 1;
  return days > BILLING_LIMITS.maxPeriodDays ? `Davr ${BILLING_LIMITS.maxPeriodDays} kundan oshmasin` : null;
}

export interface TimesheetFilters {
  period: PeriodForm;
  clientId: string | "";
  /** `""` = har mijoz o'z valyutasida. */
  currency: BillingCurrency | "";
  fx: string;
}

export const FX_RE = /^\d{1,12}(\.\d{1,4})?$/;

/** Timesheet/eksport so'rov qatori (`?` siz). Noto'g'ri davr bo'lsa `null`. */
export function timesheetQuery(f: TimesheetFilters, extra: Record<string, string> = {}): string | null {
  if (validatePeriod(f.period)) return null;
  const q = new URLSearchParams();
  if (f.period.mode === "month") q.set("month", f.period.month);
  else {
    q.set("from", f.period.from);
    q.set("to", f.period.to);
  }
  if (f.clientId) q.set("clientId", f.clientId);
  if (f.currency) q.set("currency", f.currency);
  if (f.currency && FX_RE.test(f.fx.trim())) q.set("fxUzsPerUsd", f.fx.trim());
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

/** Davr oynasi (mijoz hisoboti uchun `from/to`): oy bo'lsa oyning birinchi/oxirgi kuni. */
export function periodRange(p: PeriodForm): { from: string; to: string } | null {
  if (validatePeriod(p)) return null;
  if (p.mode === "range") return { from: p.from, to: p.to };
  const [y, m] = p.month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${p.month}-01`, to: `${p.month}-${String(last).padStart(2, "0")}` };
}

// --- ko'rsatish -----------------------------------------------------------------------------------

/** 5400 -> "1:30" (eng yaqin daqiqaga, eksport/summa bilan bir xil birlik). */
export function formatHm(seconds: number): string {
  const m = Math.floor((Math.max(0, seconds) + 30) / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** "150000.5" -> "150 000.5 UZS"; faqat matn bilan ishlaydi (float yo'q). */
export function formatMoney(amount: string | null, currency: BillingCurrency | null): string {
  if (amount === null) return "—";
  const [int = "0", frac] = amount.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${grouped}${frac ? `.${frac}` : ""}${currency ? ` ${currency}` : ""}`;
}

export function formatRate(client: Pick<TimesheetClient, "hourlyRate" | "rateCurrency">): string {
  return client.hourlyRate === null ? "—" : `${formatMoney(client.hourlyRate, client.rateCurrency)} / soat`;
}

/** Reja vs haqiqiy: faqat o'lchami bor vazifalar. Reja yo'q bo'lsa `null`. */
export function planVsActual(t: Pick<TimesheetTotals, "plannedSeconds" | "plannedActualSeconds">): { text: string; tone: "ok" | "warn" | "over" } | null {
  if (t.plannedSeconds <= 0) return null;
  const pct = Math.round((t.plannedActualSeconds / t.plannedSeconds - 1) * 100);
  const text = `reja ${formatHm(t.plannedSeconds)} / haqiqiy ${formatHm(t.plannedActualSeconds)} (${pct > 0 ? "+" : ""}${pct}%)`;
  return { text, tone: pct <= 10 ? "ok" : pct <= 50 ? "warn" : "over" };
}

export const tokenTotal = (t: TimesheetTotals["tokens"]): number => t.input + t.output + t.cacheRead + t.cacheCreation;

export interface TimesheetRowVm {
  id: string;
  level: "client" | "project" | "task";
  label: string;
  sub: string | null;
  hours: string;
  sessions: number;
  closed: number;
  commits: number;
  tokens: string;
  cost: string;
  amount: string | null;
  note: string | null;
  plan: { text: string; tone: "ok" | "warn" | "over" } | null;
}

const projectRow = (clientKey: string, p: TimesheetProject): TimesheetRowVm => ({
  id: `${clientKey}|${p.projectKey}`,
  level: "project",
  label: p.name,
  sub: p.unattributedSeconds > 0 ? `vazifasiz ${formatHm(p.unattributedSeconds)}` : null,
  hours: formatHm(p.totals.activeSeconds),
  sessions: p.totals.sessions,
  closed: p.totals.tasksClosed,
  commits: p.totals.commits,
  tokens: formatTokens(tokenTotal(p.totals.tokens)),
  cost: formatCost(p.totals.costUsd),
  amount: null,
  note: null,
  plan: planVsActual(p.totals),
});

/** Jadval qatorlari (mijoz -> loyiha -> vazifa). `expanded` = ochiq id'lar (mijoz yoki mijoz|loyiha). */
export function timesheetRows(dto: TimesheetDto, expanded: ReadonlySet<string>): TimesheetRowVm[] {
  const rows: TimesheetRowVm[] = [];
  for (const c of dto.clients) {
    const cKey = c.clientId ?? "unassigned";
    rows.push({
      id: cKey,
      level: "client",
      label: c.name,
      sub: c.overlapSeconds > 0 ? `parallel ishlash: loyihalar yig'indisi ${formatHm(c.overlapSeconds)} ortiq` : null,
      hours: formatHm(c.totals.activeSeconds),
      sessions: c.totals.sessions,
      closed: c.totals.tasksClosed,
      commits: c.totals.commits,
      tokens: formatTokens(tokenTotal(c.totals.tokens)),
      cost: formatCost(c.totals.costUsd),
      amount: c.amount === null ? null : formatMoney(c.amount, c.amountCurrency),
      note: c.amountNote,
      plan: planVsActual(c.totals),
    });
    if (!expanded.has(cKey)) continue;
    for (const p of c.projects) {
      rows.push(projectRow(cKey, p));
      if (!expanded.has(`${cKey}|${p.projectKey}`)) continue;
      for (const t of p.tasks) {
        rows.push({
          id: `${cKey}|${p.projectKey}|${t.key}`,
          level: "task",
          label: `${t.key}${t.title ? ` · ${t.title}` : ""}`,
          sub: t.closedInPeriod ? "davrda yopilgan" : null,
          hours: formatHm(t.activeSeconds),
          sessions: t.sessions,
          closed: t.closedInPeriod ? 1 : 0,
          commits: t.commits,
          tokens: formatTokens(t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheCreation),
          cost: formatCost(t.costUsd),
          amount: null,
          note: null,
          plan: t.plannedHours === null ? null : { text: `reja ${t.plannedHours} s`, tone: "ok" },
        });
      }
    }
  }
  return rows;
}

/** Davr/ma'lumot to'liq emasligi haqida ogohlantirishlar. */
export function timesheetWarnings(dto: TimesheetDto): string[] {
  const w: string[] = [];
  if (dto.taskTokensPartial) w.push("Davr 30 kundan uzoq: vazifa tokenlari faqat xom ma'lumot oynasi uchun; loyiha va mijoz jami to'liq (kunlik agregat).");
  if (dto.activeTimePartial) w.push("Davr 90 kundan uzoq: faol vaqt to'liq emas (sessiya hodisalari 90 kun saqlanadi).");
  return w;
}

export function timesheetSummaryLine(dto: TimesheetDto): string {
  const t = dto.total;
  return `${formatHm(t.activeSeconds)} soat · ${formatCount(t.sessions)} sessiya · ${t.tasksClosed} vazifa yopildi · ${t.commits} commit`;
}

// --- mijozlar -------------------------------------------------------------------------------------

export interface ClientForm {
  name: string;
  notes: string;
  hourlyRate: string;
  currency: BillingCurrency;
}

export const EMPTY_CLIENT_FORM: ClientForm = { name: "", notes: "", hourlyRate: "", currency: "UZS" };

export const formFromClient = (c: ClientDto): ClientForm => ({ name: c.name, notes: c.notes, hourlyRate: c.hourlyRate ?? "", currency: c.currency });

/** Forma -> so'rov tanasi yoki o'zbekcha xato. Stavka bo'sh = yo'q (`null`); vergul nuqtaga almashtiriladi. */
export function clientBody(f: ClientForm): { ok: true; body: CreateClientBody } | { ok: false; error: string } {
  const rate = f.hourlyRate.trim().replace(",", ".");
  if (f.name.trim() === "") return { ok: false, error: "Mijoz nomini kiriting" };
  if (rate !== "" && !FX_RE.test(rate)) return { ok: false, error: "Stavka musbat son bo'lsin (masalan 150000 yoki 12.5)" };
  const parsed = CreateClientBodySchema.safeParse({ name: f.name.trim(), notes: f.notes.trim(), hourlyRate: rate === "" ? null : rate, currency: f.currency });
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, error: "Ma'lumot noto'g'ri (nom <= 120, izoh <= 2000 belgi)" };
}

/** Loyiha guruhlarini mijoz bo'yicha taqsimlaydi: tanlangan mijozniki, boshqasiniki (ko'chadi), biriktirilmagan. */
export function projectChoices(projects: readonly BillingProjectDto[], clientId: string, clients: readonly ClientDto[]): Array<BillingProjectDto & { checked: boolean; otherClient: string | null }> {
  const names = new Map(clients.map((c) => [c.id, c.name] as const));
  return projects.map((p) => ({ ...p, checked: p.clientId === clientId, otherClient: p.clientId && p.clientId !== clientId ? (names.get(p.clientId) ?? null) : null }));
}

export function billingHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  if (status === 403 && code === "lockdown") return "Lockdown yoqiq: o'zgartirib bo'lmaydi";
  if (status === 403) return "Boshqaruv uchun token ruxsati yetarli emas";
  if (status === 409 && code === "client_exists") return "Bunday nomli mijoz allaqachon bor";
  if (status === 409 && code === "too_many_clients") return "Mijozlar soni chegarasiga yetdi";
  if (status === 404) return "Topilmadi (ro'yxatni yangilang)";
  if (status === 413) return "Hajm juda katta";
  if (status === 422 && code === "snapshot_leak_detected") return "Hisobotda maxfiy ma'lumot (yo'l, xesh, mashina nomi yoki sir) topildi: yaratish to'xtatildi. Vazifa sarlavhalarini tekshiring";
  if (status === 400) {
    if (code === "no_projects") return "Mijozga loyiha biriktirilmagan";
    if (code === "unknown_project") return "Noma'lum loyiha tanlangan";
    if (code === "period_too_long") return `Davr ${BILLING_LIMITS.maxPeriodDays} kundan oshmasin`;
    if (code === "invalid_period") return "Davr noto'g'ri";
    return "So'rov ma'lumoti noto'g'ri";
  }
  if (status === 503) return "Markaz hozir javob bermayapti (audit yoki sozlama)";
  return `Xatolik (${status || "tarmoq"})`;
}

// --- fayl yuklash ---------------------------------------------------------------------------------

/** base64 -> bayt (brauzer va test). */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Yuklab olish uchun xavfsiz fayl nomi (yo'l ajratgichlarsiz). */
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned === "" ? "fayl" : cleaned.slice(0, 120);
}

export function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export const REPORT_PRIVACY_NOTE = "Hisobotda faqat vazifa sarlavhalari, sonlar va sanalar bo'ladi. Fayl yo'llari, commit xeshlari, mashina nomlari, kod va sirlar kiritilmaydi. Faylni o'zingiz yuklab olib mijozga yuborasiz: markaz mijozga hech narsa yubormaydi.";
