import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { CORE_SCHEMA, load } from 'js-yaml';
import {
  DEPLOY_LIMITS,
  DEPLOY_PLACEHOLDERS,
  DeployRecipeSchema,
  ENV_NAME_RE,
  MACHINE_NAME_RE,
  STEP_NAME_RE,
  TARGET_NAME_RE,
  canonicalJson,
} from '@commander/contracts';
import type { DeployHealth, DeployRecipe, DeployStep, DeployTarget } from '@commander/contracts';
import { redact } from './redact.js';

/**
 * Deploy retsepti (`.commander/deploy.yml`) parseri va validatori (task 6.5). SOF (fayl/git/tarmoq yo'q): matn -> normallashtirilgan
 * retsept + xesh + muammolar ro'yxati. Retsept kod kabi ko'rib chiqiladi, lekin baribir ishonchsiz kirish deb hisoblanadi:
 *  - YAML FAQAT core schema (teg yo'q, `<<` merge yo'q); alias/ankerlar tugun hisobi bilan cheklanadi (alias bombasi);
 *  - qadamlar `run:` MASSIVI (argv) — qator berilsa rad etiladi; `shell:` alohida kalit (opt-in), shell'ga o'tuvchi `bash -c` kabi
 *    qadamlar ham `usesShell` hisoblanadi (siyosat `allowDeployShell` kerak);
 *  - noma'lum kalit rad etiladi (imlo xatosi jim o'tmasin); sirga o'xshash qiymat rad etiladi (sirni repo'ga yozmang);
 *  - env: faqat `^[A-Z_][A-Z0-9_]*$`, dinamik yuklovchi/PATH/git/node o'zgaruvchilari taqiqlangan.
 */

const MAX_NODES = 20_000;
const MAX_ISSUES = 40;
/** Retsept env'ida o'rnatib bo'lmaydigan nomlar/prefikslar (kod yuklash yoki vositani almashtirish vektori). */
const ENV_DENY_EXACT = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'IFS', 'ENV', 'BASH_ENV', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB', 'SSH_AUTH_SOCK', 'TMPDIR']);
const ENV_DENY_PREFIX = ['LD_', 'DYLD_', 'GIT_', 'NODE_', 'NPM_', 'COMMANDER_', 'AGENTD_', 'BASH_FUNC_'];

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const WRAPPER_NAMES = new Set(['env', 'sudo', 'doas', 'nice', 'nohup', 'time', 'timeout', 'xargs', 'exec', 'command', 'setsid', 'stdbuf', 'ionice', 'caffeinate']);

export interface RecipeParse {
  /** Normallashtirilgan retsept (muammo bo'lsa `null`). */
  recipe: DeployRecipe | null;
  recipeHash: string | null;
  usesShell: boolean;
  /** Xatolar (retsept yaroqsiz) — `recipe=null` bo'lganda to'ldiriladi. */
  issues: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `sha256(canonicalJson(recipe))`: YAML bo'shliq/izohlari xeshga ta'sir qilmaydi. */
export function hashRecipe(recipe: DeployRecipe): string {
  return createHash('sha256').update(canonicalJson(recipe), 'utf8').digest('hex');
}

/** Alias bombasi himoyasi: daraxtni (aliaslar takror sanaladi) `MAX_NODES` gacha yuradi. */
function withinNodeBudget(v: unknown): boolean {
  let n = 0;
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    if (++n > MAX_NODES) return false;
    const cur = stack.pop();
    if (Array.isArray(cur)) stack.push(...cur);
    else if (isObj(cur)) stack.push(...Object.values(cur));
  }
  return true;
}

class Issues {
  readonly list: string[] = [];
  add(path: string, msg: string): void {
    if (this.list.length < MAX_ISSUES) this.list.push(`${path}: ${msg}`.slice(0, 300));
  }
}

/** Placeholder'lar: faqat `{{commit}}`, `{{short_commit}}`, `{{target}}`. */
export function placeholderIssues(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const name = (m[1] ?? '').trim();
    if (!(DEPLOY_PLACEHOLDERS as readonly string[]).includes(name)) bad.push(name.slice(0, 30));
  }
  return bad;
}

export interface PlaceholderCtx {
  commit: string;
  target: string;
}

/** `{{commit}}` va h.k. ni almashtiradi (qiymatlar tekshirilgan: sha va maqsad nomi). */
export function substitute(text: string, ctx: PlaceholderCtx): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, name: string) => {
    if (name === 'commit') return ctx.commit;
    if (name === 'short_commit') return ctx.commit.slice(0, 8);
    if (name === 'target') return ctx.target;
    return all;
  });
}

function scalarString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

function checkText(iss: Issues, path: string, text: string, max: number): boolean {
  if (text.includes('\0')) {
    iss.add(path, 'NUL belgi taqiqlangan');
    return false;
  }
  if (text.length > max) {
    iss.add(path, `juda uzun (> ${max} belgi)`);
    return false;
  }
  if (redact(text) !== text) {
    iss.add(path, "sirga o'xshash qiymat (token/kalit/parol): sirlarni repo'ga yozmang, mashinadagi muhitdan oling");
    return false;
  }
  const bad = placeholderIssues(text);
  if (bad.length > 0) {
    iss.add(path, `noma'lum o'rinbosar {{${bad[0]}}} (ruxsat: ${DEPLOY_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')})`);
    return false;
  }
  return true;
}

function baseName(cmd: string): string {
  return (cmd.split(/[\\/]/).pop() ?? cmd).toLowerCase();
}

/** `bash -c`, `env sh`, `sudo bash` ... argv shell'ga o'tadimi (best-effort; haqiqiy himoya: egasi ko'rib tasdiqlaydi). */
export function argvInvokesShell(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  if (SHELL_NAMES.has(baseName(argv[0]!))) return true;
  if (!WRAPPER_NAMES.has(baseName(argv[0]!))) return false;
  // `sudo -u app bash x.sh`, `env FOO=1 sh`, `nice -n 10 zsh`: o'rovchining ketma-ket argumentlari orasida shell nomi bormi
  return argv.slice(1, 9).some((a) => SHELL_NAMES.has(baseName(a)));
}

function readArgv(iss: Issues, path: string, v: unknown): string[] | null {
  if (typeof v === 'string') {
    iss.add(path, "`run` MASSIV bo'lishi shart (argv), qator emas; shell kerak bo'lsa `shell:` kaliti (siyosat allowDeployShell bilan)");
    return null;
  }
  if (!Array.isArray(v) || v.length === 0) {
    iss.add(path, "`run` bo'sh bo'lmagan massiv bo'lishi kerak");
    return null;
  }
  if (v.length > DEPLOY_LIMITS.argvMaxItems) {
    iss.add(path, `argv juda uzun (> ${DEPLOY_LIMITS.argvMaxItems})`);
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const s = scalarString(v[i]);
    if (s === null || s.length === 0) {
      iss.add(`${path}[${i}]`, "matn/son bo'lishi shart (bo'sh emas)");
      return null;
    }
    if (!checkText(iss, `${path}[${i}]`, s, DEPLOY_LIMITS.argvItemMaxChars)) return null;
    out.push(s);
  }
  const cmd = out[0]!;
  if (cmd.startsWith('-')) {
    iss.add(`${path}[0]`, "buyruq '-' bilan boshlanmasligi kerak");
    return null;
  }
  if (/\s/.test(cmd)) {
    iss.add(`${path}[0]`, "birinchi element buyruq NOMI/yo'li (bo'shliqsiz); argumentlarni alohida elementlarga ajrating");
    return null;
  }
  return out;
}

function readRelDir(iss: Issues, path: string, v: unknown): string | null {
  const s = scalarString(v);
  if (s === null || s.length === 0) {
    iss.add(path, "yo'l matni bo'lishi kerak");
    return null;
  }
  if (!checkText(iss, path, s, DEPLOY_LIMITS.pathMaxChars)) return null;
  if (posix.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('~')) {
    iss.add(path, "qadam cwd'si nisbiy bo'lishi kerak (target cwd ichida)");
    return null;
  }
  if (s.split(/[\\/]/).includes('..')) {
    iss.add(path, "'..' segmenti taqiqlangan");
    return null;
  }
  return s;
}

function readTimeout(iss: Issues, path: string, v: unknown, def: number, max: number): number {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    iss.add(path, `1..${max} oralig'idagi butun son (soniya)`);
    return def;
  }
  return v;
}

function readEnv(iss: Issues, path: string, v: unknown): Record<string, string> {
  if (v === undefined) return {};
  if (!isObj(v)) {
    iss.add(path, "xarita (NOM: qiymat) bo'lishi kerak");
    return {};
  }
  const keys = Object.keys(v);
  if (keys.length > DEPLOY_LIMITS.envMaxItems) iss.add(path, `juda ko'p o'zgaruvchi (> ${DEPLOY_LIMITS.envMaxItems})`);
  const out: Record<string, string> = {};
  for (const k of keys.slice(0, DEPLOY_LIMITS.envMaxItems)) {
    if (!ENV_NAME_RE.test(k) || ENV_DENY_EXACT.has(k) || ENV_DENY_PREFIX.some((p) => k.startsWith(p))) {
      iss.add(`${path}.${k.slice(0, 40)}`, "bu o'zgaruvchi nomi ruxsat etilmagan (faqat A-Z0-9_; PATH/LD_*/GIT_*/NODE_* va h.k. taqiqlangan)");
      continue;
    }
    const s = scalarString(v[k]);
    if (s === null) {
      iss.add(`${path}.${k}`, "matn/son bo'lishi kerak");
      continue;
    }
    // nom bilan birga tekshiriladi: `APP_SECRET=hunter2` qiymatning o'zida sirga o'xshamaydi
    if (redact(`${k}=${s}`) !== `${k}=${s}`) {
      iss.add(`${path}.${k}`, "sirga o'xshash qiymat (token/kalit/parol): sirlarni repo'ga yozmang, mashinadagi muhitdan oling");
      continue;
    }
    if (checkText(iss, `${path}.${k}`, s, DEPLOY_LIMITS.envValueMaxChars)) out[k] = s;
  }
  return out;
}

const STEP_KEYS = new Set(['name', 'run', 'shell', 'cwd', 'env', 'timeout']);

function readStep(iss: Issues, path: string, raw: unknown, index: number, phase: string): DeployStep | null {
  // Qisqa shakl: `- [npm, test]`
  const o: Record<string, unknown> = Array.isArray(raw) ? { run: raw } : isObj(raw) ? raw : {};
  if (!Array.isArray(raw) && !isObj(raw)) {
    iss.add(path, "qadam xarita yoki argv massivi bo'lishi kerak");
    return null;
  }
  for (const k of Object.keys(o)) if (!STEP_KEYS.has(k)) iss.add(`${path}.${k.slice(0, 40)}`, `noma'lum kalit (ruxsat: ${[...STEP_KEYS].join(', ')})`);
  const nameRaw = o['name'];
  const name = nameRaw === undefined ? `${phase} ${index + 1}` : scalarString(nameRaw);
  if (name === null || !STEP_NAME_RE.test(name)) {
    iss.add(`${path}.name`, "nom: harf/raqam bilan boshlanadi, <= 60 belgi, [A-Za-z0-9 ._:/()+-]");
    return null;
  }
  const hasRun = o['run'] !== undefined;
  const hasShell = o['shell'] !== undefined;
  if (hasRun === hasShell) {
    iss.add(path, 'aynan bittasi kerak: `run` (argv massivi) yoki `shell` (qator)');
    return null;
  }
  const cwd = o['cwd'] === undefined ? null : readRelDir(iss, `${path}.cwd`, o['cwd']);
  const env = readEnv(iss, `${path}.env`, o['env']);
  const timeoutSec = readTimeout(iss, `${path}.timeout`, o['timeout'], DEPLOY_LIMITS.stepTimeoutDefaultSec, DEPLOY_LIMITS.stepTimeoutMaxSec);
  if (hasRun) {
    const argv = readArgv(iss, `${path}.run`, o['run']);
    if (!argv) return null;
    return { name, kind: 'argv', argv, shell: null, cwd, env, timeoutSec };
  }
  const sh = o['shell'];
  if (typeof sh !== 'string' || sh.trim().length === 0) {
    iss.add(`${path}.shell`, "bo'sh bo'lmagan qator bo'lishi kerak");
    return null;
  }
  if (!checkText(iss, `${path}.shell`, sh, DEPLOY_LIMITS.shellMaxChars)) return null;
  return { name, kind: 'shell', argv: [], shell: sh, cwd, env, timeoutSec };
}

function readSteps(iss: Issues, path: string, raw: unknown, phase: string, required: boolean): DeployStep[] {
  if (raw === undefined) {
    if (required) iss.add(path, "kamida bitta qadam kerak");
    return [];
  }
  if (!Array.isArray(raw)) {
    iss.add(path, "massiv bo'lishi kerak");
    return [];
  }
  if (required && raw.length === 0) iss.add(path, 'kamida bitta qadam kerak');
  if (raw.length > DEPLOY_LIMITS.maxStepsPerPhase) {
    iss.add(path, `juda ko'p qadam (> ${DEPLOY_LIMITS.maxStepsPerPhase})`);
    return [];
  }
  const out: DeployStep[] = [];
  const names = new Set<string>();
  raw.forEach((r, i) => {
    const s = readStep(iss, `${path}[${i}]`, r, i, phase);
    if (!s) return;
    if (names.has(s.name)) iss.add(`${path}[${i}].name`, `takroriy qadam nomi "${s.name}"`);
    names.add(s.name);
    out.push(s);
  });
  return out;
}

const HEALTH_KEYS = new Set(['url', 'run', 'expect', 'timeout', 'retries', 'interval']);

function readHealth(iss: Issues, path: string, raw: unknown): DeployHealth | null {
  if (raw === undefined) return null;
  if (!isObj(raw)) {
    iss.add(path, "xarita bo'lishi kerak");
    return null;
  }
  for (const k of Object.keys(raw)) if (!HEALTH_KEYS.has(k)) iss.add(`${path}.${k.slice(0, 40)}`, `noma'lum kalit (ruxsat: ${[...HEALTH_KEYS].join(', ')})`);
  const hasUrl = raw['url'] !== undefined;
  const hasRun = raw['run'] !== undefined;
  if (hasUrl === hasRun) {
    iss.add(path, 'aynan bittasi kerak: `url` (HTTP GET) yoki `run` (argv massivi)');
    return null;
  }
  const timeoutSec = readTimeout(iss, `${path}.timeout`, raw['timeout'], 5, DEPLOY_LIMITS.healthAttemptTimeoutMaxSec);
  let retries = 5;
  if (raw['retries'] !== undefined) {
    const r = raw['retries'];
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > DEPLOY_LIMITS.healthRetriesMax) iss.add(`${path}.retries`, `0..${DEPLOY_LIMITS.healthRetriesMax} butun son`);
    else retries = r;
  }
  const intervalSec = readTimeout(iss, `${path}.interval`, raw['interval'], 3, DEPLOY_LIMITS.healthIntervalMaxSec);
  let expectStatus = [200];
  if (raw['expect'] !== undefined) {
    const e = Array.isArray(raw['expect']) ? raw['expect'] : [raw['expect']];
    const ok = e.length >= 1 && e.length <= 8 && e.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 100 && x <= 599);
    if (!ok) iss.add(`${path}.expect`, "100..599 oralig'idagi HTTP status (yoki <= 8 ta massiv)");
    else expectStatus = (e as number[]).slice();
  }
  if (hasUrl) {
    const u = scalarString(raw['url']);
    if (u === null || !checkText(iss, `${path}.url`, u, DEPLOY_LIMITS.healthUrlMaxChars)) return null;
    // placeholder bo'lsa tekshiruv almashtirishdan keyin ham bajariladi; sintaksis uchun probalab ko'ramiz
    const probe = substitute(u, { commit: '0'.repeat(40), target: 'target' });
    let parsed: URL;
    try {
      parsed = new URL(probe);
    } catch {
      iss.add(`${path}.url`, "yaroqsiz URL");
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      iss.add(`${path}.url`, 'faqat http/https');
      return null;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      iss.add(`${path}.url`, "URL ichida login/parol taqiqlangan");
      return null;
    }
    return { kind: 'http', url: u, argv: [], expectStatus, timeoutSec, retries, intervalSec };
  }
  const argv = readArgv(iss, `${path}.run`, raw['run']);
  if (!argv) return null;
  return { kind: 'command', url: null, argv, expectStatus, timeoutSec, retries, intervalSec };
}

const TARGET_KEYS = new Set(['machine', 'cwd', 'timeout', 'preflight', 'steps', 'health', 'rollback']);

function readTarget(iss: Issues, name: string, raw: unknown): DeployTarget | null {
  const path = `targets.${name.slice(0, 40)}`;
  if (!TARGET_NAME_RE.test(name)) {
    iss.add(path, "maqsad nomi: kichik harf/raqam bilan boshlanadi, [a-z0-9._-], <= 40");
    return null;
  }
  if (!isObj(raw)) {
    iss.add(path, "xarita bo'lishi kerak");
    return null;
  }
  for (const k of Object.keys(raw)) if (!TARGET_KEYS.has(k)) iss.add(`${path}.${k.slice(0, 40)}`, `noma'lum kalit (ruxsat: ${[...TARGET_KEYS].join(', ')})`);
  const machine = scalarString(raw['machine']);
  if (machine === null || !MACHINE_NAME_RE.test(machine)) iss.add(`${path}.machine`, "mashina nomi (markazdagi slug) kerak: [A-Za-z0-9._-]");
  let cwd = '.';
  if (raw['cwd'] !== undefined) {
    const c = scalarString(raw['cwd']);
    if (c === null || c.length === 0 || !checkText(iss, `${path}.cwd`, c, DEPLOY_LIMITS.pathMaxChars)) iss.add(`${path}.cwd`, "yo'l matni kerak");
    else if (!(posix.isAbsolute(c) || /^[A-Za-z]:[\\/]/.test(c)) && c.split(/[\\/]/).includes('..')) iss.add(`${path}.cwd`, "nisbiy yo'lda '..' taqiqlangan");
    else if (c.startsWith('~')) iss.add(`${path}.cwd`, "'~' qo'llab-quvvatlanmaydi: mutlaq yoki repo'ga nisbiy yo'l bering");
    else cwd = c;
  }
  const timeoutSec = readTimeout(iss, `${path}.timeout`, raw['timeout'], DEPLOY_LIMITS.targetTimeoutDefaultSec, DEPLOY_LIMITS.targetTimeoutMaxSec);
  const preflight = readSteps(iss, `${path}.preflight`, raw['preflight'], 'preflight', false);
  const steps = readSteps(iss, `${path}.steps`, raw['steps'], 'step', true);
  const rollback = readSteps(iss, `${path}.rollback`, raw['rollback'], 'rollback', false);
  const health = readHealth(iss, `${path}.health`, raw['health']);
  if (machine === null || !MACHINE_NAME_RE.test(machine)) return null;
  const all = [...preflight, ...steps, ...rollback];
  const usesShell = all.some((s) => s.kind === 'shell' || argvInvokesShell(s.argv)) || (health?.kind === 'command' && argvInvokesShell(health.argv));
  return { name, machine, cwd, timeoutSec, preflight, steps, health, rollback, usesShell };
}

/** Matn -> normallashtirilgan retsept. Xatolar `issues`da (retsept `null`). Hech qachon throw qilmaydi. */
export function parseRecipe(text: string): RecipeParse {
  const iss = new Issues();
  const fail = (): RecipeParse => ({ recipe: null, recipeHash: null, usesShell: false, issues: iss.list });
  if (Buffer.byteLength(text, 'utf8') > DEPLOY_LIMITS.recipeMaxBytes) {
    iss.add('deploy.yml', `fayl juda katta (> ${DEPLOY_LIMITS.recipeMaxBytes} bayt)`);
    return fail();
  }
  if (text.includes('\0')) {
    iss.add('deploy.yml', 'NUL belgi');
    return fail();
  }
  let doc: unknown;
  try {
    doc = load(text, { schema: CORE_SCHEMA });
  } catch (err) {
    iss.add('deploy.yml', `YAML xatosi: ${(err instanceof Error ? err.message : 'noma\'lum').split('\n')[0]!.slice(0, 200)}`);
    return fail();
  }
  if (!withinNodeBudget(doc)) {
    iss.add('deploy.yml', "juda ko'p tugun (alias/anker bombasi?)");
    return fail();
  }
  if (!isObj(doc)) {
    iss.add('deploy.yml', "ildiz xarita bo'lishi kerak");
    return fail();
  }
  for (const k of Object.keys(doc)) if (k !== 'version' && k !== 'targets') iss.add(k.slice(0, 40), "noma'lum kalit (ruxsat: version, targets)");
  if (doc['version'] !== 1) iss.add('version', '`version: 1` kerak');
  const targetsRaw = doc['targets'];
  if (!isObj(targetsRaw) || Object.keys(targetsRaw).length === 0) {
    iss.add('targets', "kamida bitta maqsad kerak (xarita: nom -> maqsad)");
    return fail();
  }
  const names = Object.keys(targetsRaw);
  if (names.length > DEPLOY_LIMITS.maxTargets) {
    iss.add('targets', `juda ko'p maqsad (> ${DEPLOY_LIMITS.maxTargets})`);
    return fail();
  }
  const targets: DeployTarget[] = [];
  for (const n of names) {
    const t = readTarget(iss, n, targetsRaw[n]);
    if (t) targets.push(t);
  }
  if (iss.list.length > 0 || targets.length !== names.length) return fail();
  const parsed = DeployRecipeSchema.safeParse({ version: 1, targets: targets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) });
  if (!parsed.success) {
    iss.add('deploy.yml', 'normallashtirilgan retsept sxemaga mos emas');
    return fail();
  }
  return { recipe: parsed.data, recipeHash: hashRecipe(parsed.data), usesShell: parsed.data.targets.some((t) => t.usesShell), issues: [] };
}
