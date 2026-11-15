#!/usr/bin/env node
// Sessiyalararo xabar (task 2.10) uchun mashinani sozlaydi. Idempotent, mavjud sozlamani buzmaydi:
//   1) ~/.claude/settings.json: UserPromptSubmit `cc-hook --inbox` va Stop `cc-hook --inbox-stop` SINXRON hook'lari (timeout 5 s).
//      Buyruq asosi: settings'dagi mavjud cc-hook (status) buyrug'i (shu mashinada ishlaydigan node yo'li/qo'shtirnoqlari bilan aynan);
//      u yo'q bo'lsa --node-bin + ~/.commander/bin/cc-hook.mjs. Avval zaxira (.bak-messaging-<ts>), JSON tekshiruv, atomik rename.
//   2) Claude Code user-scope MCP: `claude mcp add --scope user commander -- <node> <cc-mcp.mjs>` (bor va bir xil bo'lsa tegmaydi,
//      boshqacha bo'lsa o'chirib qayta qo'shadi).
// Foydalanish: node commander-messaging-setup.mjs [--node-bin <yo'l>] [--claude-bin <yo'l>] [--settings <fayl>] [--commander-home <papka>] [--no-mcp] [--dry-run]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'node-bin': { type: 'string' },
    'claude-bin': { type: 'string' },
    settings: { type: 'string' },
    'commander-home': { type: 'string' },
    'no-mcp': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});
const win = process.platform === 'win32';
const fwd = (p) => p.replace(/\\/g, '/');
const cHome = values['commander-home'] ?? join(homedir(), '.commander');
const settingsFile = values.settings ?? join(homedir(), '.claude', 'settings.json');
const nodeBin = values['node-bin'] ?? process.execPath;
const dry = values['dry-run'];
const q = (p) => `"${p}"`;

// --- 1) hook'lar ---------------------------------------------------------------------------------
let settings = {};
let raw = null;
if (existsSync(settingsFile)) {
  raw = readFileSync(settingsFile, 'utf8');
  try {
    settings = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    console.error(`xato: ${settingsFile} yaroqsiz JSON, o'zgartirilmadi (${e.message})`);
    process.exit(1);
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    console.error("xato: settings.json obyekt emas, o'zgartirilmadi");
    process.exit(1);
  }
}
settings.hooks = { ...(settings.hooks ?? {}) };

const hookCmds = (name) => (Array.isArray(settings.hooks[name]) ? settings.hooks[name] : []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).map((h) => h?.command).filter((c) => typeof c === 'string');
const existingBase = Object.keys(settings.hooks)
  .flatMap(hookCmds)
  .find((c) => c.includes('cc-hook') && !/--(permission|inbox)/.test(c));
const base = existingBase ?? `${q(fwd(nodeBin))} ${q(fwd(join(cHome, 'bin', 'cc-hook.mjs')))}`;

let added = 0;
const ensure = (event, flag, re) => {
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  if (hookCmds(event).some((c) => c.includes('cc-hook') && re.test(c))) {
    settings.hooks[event] = groups;
    return;
  }
  groups.push({ hooks: [{ type: 'command', command: `${base} ${flag}`, timeout: 5 }] });
  settings.hooks[event] = groups;
  added++;
};
ensure('UserPromptSubmit', '--inbox', /--inbox(?!-)/);
ensure('Stop', '--inbox-stop', /--inbox-stop/);

// Foydalanuvchi qarori (2026-11-13): `commander_*` MCP vositalari (faqat xabar yuborish/o'qish, fayl va buyruqqa
// tegmaydi) ruxsat so'ramasdan ishlaydi. Xabarlashuv baribir har guruhda alohida yoqiladi va audit qilinadi.
const MCP_ALLOW = 'mcp__commander';
settings.permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
const allowList = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
if (!allowList.includes(MCP_ALLOW)) {
  allowList.push(MCP_ALLOW);
  added++;
}
settings.permissions.allow = allowList;

// --- OTLP token (M-20) -----------------------------------------------------------------------------
// agentd OTLP qabul qiluvchisi (127.0.0.1:4319) mashina tokenini `x-commander-token` sarlavhasida talab qiladi. Token
// `~/.commander/otlp-token` (0600; agentd ham xuddi shu faylni yaratadi/o'qiydi). Faqat Commander'ning OTLP endpoint'i sozlangan
// bo'lsa (`OTEL_EXPORTER_OTLP_ENDPOINT` -> :4319) sarlavha qo'shiladi; foydalanuvchining o'z OTLP sarlavhalari saqlanadi.
// Eslatma: settings.json'ni foydalanuvchining o'zi o'qiy oladi; maqsad boshqa lokal jarayon/veb sahifa soxta usage yubora olmasin.
const OTLP_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
function ensureOtlpToken() {
  const file = join(cHome, 'otlp-token');
  try {
    const t = readFileSync(file, 'utf8').trim();
    if (OTLP_TOKEN_RE.test(t)) return t;
  } catch {
    /* yo'q: yaratamiz */
  }
  if (dry) return 'dry-run-token-' + 'x'.repeat(32);
  mkdirSync(cHome, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  try {
    const fd = openSync(file, 'wx', 0o600);
    try {
      writeSync(fd, token + '\n');
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Windows */
    }
    return token;
  } catch (e) {
    if (e?.code === 'EEXIST') return readFileSync(file, 'utf8').trim();
    throw e;
  }
}
const otlpEndpoint = settings.env && typeof settings.env === 'object' ? settings.env.OTEL_EXPORTER_OTLP_ENDPOINT : undefined;
if (typeof otlpEndpoint === 'string' && /(127\.0\.0\.1|localhost):4319/.test(otlpEndpoint)) {
  const header = `x-commander-token=${ensureOtlpToken()}`;
  const curHeaders = typeof settings.env.OTEL_EXPORTER_OTLP_HEADERS === 'string' ? settings.env.OTEL_EXPORTER_OTLP_HEADERS : '';
  const rest = curHeaders.split(',').map((x) => x.trim()).filter((x) => x && !/^x-commander-token=/i.test(x));
  const next = [...rest, header].join(',');
  if (next !== curHeaders) {
    settings.env = { ...settings.env, OTEL_EXPORTER_OTLP_HEADERS: next };
    added++;
  }
} else {
  console.log("OTLP token: settings.json'da Commander OTLP endpoint'i (:4319) yo'q: sarlavha qo'shilmadi (avval add-machine/merge-claude-settings)");
}

const out = JSON.stringify(settings, null, 2) + '\n';
JSON.parse(out);
if (added === 0) {
  console.log(`hook'lar: o'zgarmadi (allaqachon bor): ${settingsFile}`);
} else if (dry) {
  console.log(`hook'lar: ${added} ta qo'shilar edi (dry-run): ${settingsFile}`);
} else {
  mkdirSync(dirname(settingsFile), { recursive: true });
  let backup = null;
  if (raw !== null) {
    // Nom ATAYLAB `.bak-commander-*` emas: remove-machine.sh "eng yangi .bak-commander-*" ni tiklaydi (u Commander'dan OLDINGI holat bo'lishi kerak).
    backup = `${settingsFile}.bak-messaging-${Math.floor(Date.now() / 1000)}`;
    copyFileSync(settingsFile, backup);
  }
  const tmp = `${settingsFile}.tmp-commander`;
  writeFileSync(tmp, out, { mode: 0o600 });
  renameSync(tmp, settingsFile);
  try {
    chmodSync(settingsFile, 0o600);
  } catch {
    /* Windows */
  }
  console.log(`hook'lar: ${added} ta qo'shildi: ${settingsFile} (zaxira: ${backup ?? "yo'q edi"})`);
}

// --- 2) MCP ----------------------------------------------------------------------------------------
if (values['no-mcp']) process.exit(0);
let claudeBin = values['claude-bin'];
if (!claudeBin) {
  try {
    claudeBin = JSON.parse(readFileSync(join(cHome, 'config.json'), 'utf8')).claudeBin;
  } catch {
    /* config yo'q */
  }
}
claudeBin ||= 'claude';
const mcpScript = fwd(join(cHome, 'bin', 'cc-mcp.mjs'));
const nodeFwd = fwd(nodeBin);

function claude(args) {
  // Windows'da `claude.cmd` shell talab qiladi: bo'sh joyli yo'llarni qo'shtirnoq bilan beramiz.
  const quote = (a) => (win && /\s/.test(a) ? `"${a}"` : a);
  const r = spawnSync(win ? quote(claudeBin) : claudeBin, win ? args.map(quote) : args, { encoding: 'utf8', shell: win, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

if (!existsSync(mcpScript)) {
  console.error(`MCP: ${mcpScript} yo'q (avval bundle'ni o'rnating)`);
  process.exit(1);
}
const cur = claude(['mcp', 'get', 'commander']);
const normalized = cur.out.replace(/\\/g, '/');
if (cur.code === 0 && normalized.includes(mcpScript) && normalized.includes(nodeFwd)) {
  console.log("MCP: 'commander' allaqachon ro'yxatdan o'tgan (user scope), o'zgarmadi");
  process.exit(0);
}
if (dry) {
  console.log("MCP: 'commander' qo'shilar edi (dry-run)");
  process.exit(0);
}
if (cur.code === 0) {
  const rm = claude(['mcp', 'remove', 'commander', '--scope', 'user']);
  if (rm.code !== 0) console.error(`MCP: eski 'commander' ni olib tashlab bo'lmadi (boshqa scope'dami?): ${rm.out.trim().slice(0, 200)}`);
}
const add = claude(['mcp', 'add', '--scope', 'user', 'commander', '--', nodeBin, mcpScript]);
if (add.code !== 0) {
  console.error(`MCP: qo'shib bo'lmadi: ${add.out.trim().slice(0, 300)}`);
  process.exit(1);
}
console.log("MCP: 'commander' user scope'ga qo'shildi");
