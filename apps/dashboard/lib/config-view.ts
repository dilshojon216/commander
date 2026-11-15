import type { ConfigBackupInfo, ConfigMachineState, ConfigMachineStatus, ConfigMode, ConfigPlanAction, ConfigPlanEntry, ConfigPlanResult, ConfigProfileFile, ConfigProfileSummary } from "@commander/contracts";
import { ALLOW_CONFIG_CLI, ALLOW_CONFIG_HINT } from "./config-ui";

/** Sozlamalar sinxronlash sahifasi mantig'i (sof, testlanadi). */

export type Tone = "blue" | "yel" | "grn" | "red" | "gray";

export const DEFAULT_PROFILE_NAME = "default";

// --- profillar -------------------------------------------------------------------------------------------

export interface ProfileGroup {
  name: string;
  /** Eng yangisi birinchi. */
  versions: ConfigProfileSummary[];
}

/** Nomlar bo'yicha guruhlash: guruhlar eng yangi versiya vaqti bo'yicha (yangisi birinchi), ichida versiya kamayish tartibida. */
export function groupProfiles(items: ConfigProfileSummary[]): ProfileGroup[] {
  const map = new Map<string, ConfigProfileSummary[]>();
  for (const it of items) map.set(it.name, [...(map.get(it.name) ?? []), it]);
  const groups = [...map.entries()].map(([name, versions]) => ({ name, versions: [...versions].sort((a, b) => b.version - a.version) }));
  return groups.sort((a, b) => Date.parse(b.versions[0].createdAt) - Date.parse(a.versions[0].createdAt));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface TreeRow {
  /** To'liq nisbiy yo'l (papka uchun oxirida `/`siz prefiks). */
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
  file?: ConfigProfileFile;
}

/** Tekis fayl ro'yxatidan daraxt qatorlari (papkalar birinchi, alifbo tartibida; sof). */
export function buildFileTree(files: ConfigProfileFile[]): TreeRow[] {
  interface Node {
    name: string;
    path: string;
    dirs: Map<string, Node>;
    file?: ConfigProfileFile;
  }
  const root: Node = { name: "", path: "", dirs: new Map() };
  for (const f of files) {
    const segs = f.path.split("/");
    let cur = root;
    segs.forEach((seg, i) => {
      const path = segs.slice(0, i + 1).join("/");
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { name: seg, path, dirs: new Map() };
        cur.dirs.set(seg, next);
      }
      if (i === segs.length - 1) next.file = f;
      cur = next;
    });
  }
  const out: TreeRow[] = [];
  const walk = (n: Node, depth: number) => {
    const isLeaf = (x: Node) => x.dirs.size === 0;
    const kids = [...n.dirs.values()].sort((a, b) => Number(isLeaf(a)) - Number(isLeaf(b)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const k of kids) {
      const isDir = isLeaf(k) ? !k.file : true;
      out.push({ path: k.path, name: k.name, depth, isDir, file: isDir ? undefined : k.file });
      walk(k, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

export function settingsFragmentLines(s: { permissions: { allow: string[]; deny: string[] }; env: Record<string, string> } | null): { label: string; items: string[] }[] {
  if (!s) return [];
  const out: { label: string; items: string[] }[] = [];
  if (s.permissions.allow.length) out.push({ label: "permissions.allow", items: s.permissions.allow });
  if (s.permissions.deny.length) out.push({ label: "permissions.deny", items: s.permissions.deny });
  const env = Object.entries(s.env).map(([k, v]) => `${k}=${v}`);
  if (env.length) out.push({ label: "env", items: env });
  return out;
}

// --- mashina holati (matritsa) ---------------------------------------------------------------------------------

const STATUS_TEXT: Record<ConfigMachineStatus, { label: string; tone: Tone }> = {
  in_sync: { label: "Sinxron", tone: "grn" },
  drift: { label: "Farq bor", tone: "yel" },
  not_applied: { label: "Qo'llanmagan", tone: "gray" },
  unsupported: { label: "Agentd eski", tone: "red" },
  unknown: { label: "Noma'lum", tone: "gray" },
};

export function driftReasons(d: ConfigMachineState["drift"]): string[] {
  const out: string[] = [];
  if (d.outdated) out.push("eskirgan versiya");
  if (d.modified.length) out.push(`o'zgargan: ${d.modified.length}`);
  if (d.missing.length) out.push(`yo'qolgan: ${d.missing.length}`);
  if (d.settings) out.push("settings o'zgargan");
  return out;
}

export interface MachineStatusView {
  label: string;
  tone: Tone;
  /** Drift sabablari (faqat `drift` holatida). */
  reasons: string[];
  appliedText: string;
  outdatedHint: string | null;
}

export function describeMachineStatus(m: ConfigMachineState): MachineStatusView {
  const base = STATUS_TEXT[m.status];
  const reasons = m.status === "drift" ? driftReasons(m.drift) : [];
  const appliedText = m.applied ? `${m.applied.profileName} v${m.applied.profileVersion} (${m.applied.mode === "mirror" ? "mirror" : "merge"})` : "—";
  const outdatedHint = m.applied && m.latestVersion !== null && m.latestVersion > m.applied.profileVersion ? `Yangi versiya bor: v${m.latestVersion}` : null;
  return { ...base, reasons, appliedText, outdatedHint };
}

/** Drift tafsiloti (ochiladigan ro'yxat): fayl yo'llari. */
export function driftFiles(d: ConfigMachineState["drift"]): { modified: string[]; missing: string[] } {
  return { modified: d.modified, missing: d.missing };
}

export const MODE_LABEL: Record<ConfigMode, string> = { merge: "Birlashtirish (merge)", mirror: "Ko'zgu (mirror)" };
export const MIRROR_WARNING = "Mirror rejimi profilda yo'q fayllarni o'chiradi, lekin FAQAT Commander avval yuborgan fayllarni. Siz qo'lda yaratgan fayllarga tegilmaydi. Har bir o'zgarishdan oldin zaxira olinadi.";

// --- amallar yoqilganligi ------------------------------------------------------------------------------------------

export interface Gate {
  enabled: boolean;
  /** O'chiq bo'lsa sabab (tugma `title` i va matn). */
  reason: string | null;
}
const OK: Gate = { enabled: true, reason: null };
const no = (reason: string): Gate => ({ enabled: false, reason });

export interface ControlEnv {
  lockdown: boolean;
  canControl: boolean;
}

function envGate(env: ControlEnv): Gate | null {
  if (env.lockdown) return no("Lockdown yoqiq: boshqaruv o'chirilgan");
  if (!env.canControl) return no("COMMANDER_CONTROL_TOKEN sozlanmagan");
  return null;
}

function machineBase(m: Pick<ConfigMachineState, "online" | "supported">): Gate | null {
  if (!m.online) return no("Mashina oflayn");
  if (!m.supported) return no("Mashinadagi agentd eski: sozlamalar sinxronlashni qo'llamaydi");
  return null;
}

/** Ruxsat yopiq bo'lsa aniq CLI ko'rsatma (agentd'ni qo'llaydigan mashina uchun); aks holda `null`. */
export function cliHint(m: Pick<ConfigMachineState, "supported" | "allowRead" | "allowWrite">): string | null {
  if (!m.supported || (m.allowRead && m.allowWrite)) return null;
  const closed = !m.allowRead && !m.allowWrite ? "o'qish va yozish" : !m.allowRead ? "o'qish" : "yozish";
  return `Sozlamalar ${closed} ruxsati yopiq. Yoqish uchun mashinada: ${ALLOW_CONFIG_CLI}`;
}

/** Mashinadan profil olish (capture): `allowRead` kerak. */
export function captureGate(m: ConfigMachineState, env: ControlEnv): Gate {
  return envGate(env) ?? machineBase(m) ?? (m.allowRead ? OK : no(`Bu mashinada sozlamalarni o'qish taqiqlangan. ${ALLOW_CONFIG_HINT}.`));
}

/** Diff (dry-run) faqat o'qiydi, lekin agent siyosatida `allowRead` yoki `allowWrite` kerak bo'lishi mumkin: yozish yoqilgan bo'lsa ham ruxsat. */
export function diffGate(m: ConfigMachineState, env: ControlEnv): Gate {
  return envGate(env) ?? machineBase(m) ?? (m.allowRead || m.allowWrite ? OK : no(`Bu mashinada sozlamalar siyosati o'chiq. ${ALLOW_CONFIG_HINT}.`));
}

/** Yozuvchi amallar (apply/rollback): `allowWrite` shart. */
export function writeGate(m: ConfigMachineState, env: ControlEnv): Gate {
  return envGate(env) ?? machineBase(m) ?? (m.allowWrite ? OK : no(`Bu mashinada sozlamalarni yozish taqiqlangan. ${ALLOW_CONFIG_HINT}.`));
}

export function rollbackGate(m: ConfigMachineState, env: ControlEnv): Gate {
  const g = writeGate(m, env);
  if (!g.enabled) return g;
  return m.backups.length > 0 ? OK : no("Zaxira yo'q");
}

/** Oxirgi diff natijasi: aynan shu mashina/profil/rejim uchun ko'rilgan reja. */
export interface DiffRecord {
  machineId: string;
  profileId: string;
  mode: ConfigMode;
  planHash: string;
  summary: ConfigPlanResult["summary"];
  /** settings.json bo'lagida o'zgarish bor (fayl o'zgarishi bo'lmasa ham qo'llash mumkin). */
  settingsChanged: boolean;
}

export function planHasChanges(s: ConfigPlanResult["summary"]): boolean {
  return s.add + s.update + s.delete > 0;
}

/** "Qo'llash": faqat shu mashina/profil/rejim uchun diff ko'rilgan bo'lsa (va o'zgarish bo'lsa). */
export function applyGate(m: ConfigMachineState, env: ControlEnv, target: { profileId: string | null; mode: ConfigMode }, diff: DiffRecord | null): Gate {
  const base = writeGate(m, env);
  if (!base.enabled) return base;
  if (!target.profileId) return no("Avval profil versiyasini tanlang");
  if (!diff || diff.machineId !== m.machineId || diff.profileId !== target.profileId || diff.mode !== target.mode) return no("Avval shu profil va rejim uchun \"Farqni ko'rish\" ni bajaring");
  if (!planHasChanges(diff.summary) && !diff.settingsChanged) return no("O'zgarish yo'q: mashina profilga mos");
  return OK;
}

// --- reja (diff) ---------------------------------------------------------------------------------------------------

export const PLAN_ORDER: ConfigPlanAction[] = ["add", "update", "delete", "skip", "unchanged"];
export const PLAN_LABEL: Record<ConfigPlanAction, string> = {
  add: "Qo'shiladi",
  update: "Yangilanadi",
  delete: "O'chiriladi",
  unchanged: "O'zgarmaydi",
  skip: "O'tkazib yuboriladi",
};
export const PLAN_TONE: Record<ConfigPlanAction, Tone> = { add: "grn", update: "blue", delete: "red", unchanged: "gray", skip: "yel" };

export interface PlanGroup {
  action: ConfigPlanAction;
  label: string;
  tone: Tone;
  entries: ConfigPlanEntry[];
}

/** Yozuvlarni amal bo'yicha guruhlaydi (bo'sh guruhlar tushiriladi), ichida yo'l bo'yicha. */
export function groupPlanEntries(entries: ConfigPlanEntry[]): PlanGroup[] {
  return PLAN_ORDER.map((action) => ({
    action,
    label: PLAN_LABEL[action],
    tone: PLAN_TONE[action],
    entries: entries.filter((e) => e.action === action).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  })).filter((g) => g.entries.length > 0);
}

/** "3 qo'shiladi, 1 yangilanadi, ..." (nol bo'lganlar tushiriladi). */
export function planSummaryText(s: ConfigPlanResult["summary"]): string {
  const parts: string[] = [];
  if (s.add) parts.push(`${s.add} qo'shiladi`);
  if (s.update) parts.push(`${s.update} yangilanadi`);
  if (s.delete) parts.push(`${s.delete} o'chiriladi`);
  if (s.skip) parts.push(`${s.skip} o'tkaziladi`);
  if (s.unchanged) parts.push(`${s.unchanged} o'zgarmaydi`);
  return parts.length ? parts.join(", ") : "Bo'sh reja";
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Unified diff qatorini turlaydi: `+++`/`---`/`diff`/`index` sarlavha (meta), `@@` hunk, `+`/`-` o'zgarish. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export function parseDiff(diff: string): DiffLine[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((text) => ({ kind: classifyDiffLine(text), text }));
}

export const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-grn-bg text-grn",
  del: "bg-red-bg text-red",
  hunk: "text-blue",
  meta: "text-mu",
  ctx: "text-tx",
};

/** Settings rejasi: o'zgarish qatorlari (`+`/`-` belgisi bilan). */
export function settingsPlanLines(p: NonNullable<ConfigPlanResult["settings"]>): { kind: "add" | "del"; text: string }[] {
  return [
    ...p.allowAdd.map((t) => ({ kind: "add" as const, text: `allow: ${t}` })),
    ...p.allowRemove.map((t) => ({ kind: "del" as const, text: `allow: ${t}` })),
    ...p.denyAdd.map((t) => ({ kind: "add" as const, text: `deny: ${t}` })),
    ...p.denyRemove.map((t) => ({ kind: "del" as const, text: `deny: ${t}` })),
    ...p.envSet.map((t) => ({ kind: "add" as const, text: `env: ${t}` })),
    ...p.envRemove.map((t) => ({ kind: "del" as const, text: `env: ${t}` })),
  ];
}

// --- zaxiralar --------------------------------------------------------------------------------------------------------

export function backupLabel(b: ConfigBackupInfo): string {
  const p = b.profileName ? `${b.profileName}${b.profileVersion ? ` v${b.profileVersion}` : ""}` : "noma'lum profil";
  return `${p}${b.rolledBack ? " · qaytarilgan" : ""}`;
}

/** Eng yangisi birinchi. */
export function sortBackups(list: ConfigBackupInfo[]): ConfigBackupInfo[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

// --- capture uchun standart mashina ---------------------------------------------------------------------------------

/** Standart manba: ruxsat berilgan onlayn mashinalar ichida Mac (nomi/slug'i `mac`/`darwin` bo'lsa) birinchi, aks holda birinchisi. */
export function defaultCaptureMachine(machines: ConfigMachineState[], env: ControlEnv): string | null {
  const ok = machines.filter((m) => captureGate(m, env).enabled);
  const mac = ok.find((m) => /mac|darwin/i.test(`${m.slug} ${m.name}`));
  return (mac ?? ok[0])?.machineId ?? null;
}

/** Profil nomi: harf/raqam bilan boshlanadi, 64 gacha, `A-Za-z0-9 ._-` (contracts bilan bir xil). */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

/** Oflayn va shu muddatdan ortiq ko'rinmagan mashina "Oflayn (eski)" bo'limiga yig'iladi. */
export const OFFLINE_OLD_MS = 7 * 86_400_000;

/**
 * Sozlamalar mashinalarini bo'ladi: faol (ko'rinadigan) va "Oflayn (eski)". Ko'rinmaydigan mashinalar (yashirin/legacy,
 * markaz ro'yxatida yo'q = retired/merged) umuman chiqarib tashlanadi. `visibleIds = null` = filtrlamaydi.
 * Oxirgi ko'rinish: jonli mashina `lastSeenAt`i, bo'lmasa sozlamalar hisoboti vaqti; ikkalasi yo'q va oflayn = eski.
 */
export function partitionConfigMachines(
  machines: readonly ConfigMachineState[],
  visibleIds: ReadonlySet<string> | null,
  lastSeenById: ReadonlyMap<string, string | null>,
  now: number,
): { active: ConfigMachineState[]; stale: ConfigMachineState[] } {
  const active: ConfigMachineState[] = [];
  const stale: ConfigMachineState[] = [];
  for (const m of machines) {
    if (visibleIds !== null && !visibleIds.has(m.machineId)) continue;
    const seen = lastSeenById.get(m.machineId) ?? m.reportedAt;
    const old = now > 0 && !m.online && (seen === null || now - Date.parse(seen) > OFFLINE_OLD_MS);
    (old ? stale : active).push(m);
  }
  return { active, stale };
}
