#!/usr/bin/env node
// ~/.claude/settings.json ga Commander hook/OTel/statusLine bloklarini QO'SHADI (mavjudini buzmaydi).
// Xavfsizlik: avval zaxira (.bak-commander-<ts>), natija JSON sifatida tekshiriladi, so'ng vaqtinchalik fayl -> atomik rename.
// Idempotent: qayta ishga tushirsa dublikat qo'shmaydi.
// Foydalanish: node merge-claude-settings.mjs --machine-name <nom> [--node-bin <yo'l>] [--settings <fayl>] [--commander-home <papka>]
// Hook buyrug'i Claude Code'da Git Bash orqali bajariladi (Windows'da tekshirilgan), shuning uchun yo'llar `/` bilan va qo'shtirnoqda:
//   "C:/Program Files/nodejs/node.exe" "C:/Users/<u>/.commander/bin/cc-hook.mjs"
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'machine-name': { type: 'string' },
    'node-bin': { type: 'string' },
    settings: { type: 'string' },
    'commander-home': { type: 'string' },
  },
});
const machineName = values['machine-name'];
if (!machineName || !/^[A-Za-z0-9._-]{1,64}$/.test(machineName)) {
  console.error('xato: --machine-name majburiy ([A-Za-z0-9._-], <=64)');
  process.exit(2);
}
const fwd = (p) => p.replace(/\\/g, '/');
const nodeBin = fwd(values['node-bin'] ?? process.execPath);
const cHome = values['commander-home'] ?? join(homedir(), '.commander');
const settingsFile = values.settings ?? join(homedir(), '.claude', 'settings.json');
const hookScript = fwd(join(cHome, 'bin', 'cc-hook.mjs'));
const statuslineScript = fwd(join(cHome, 'bin', 'cc-statusline.mjs'));
const q = (p) => `"${p}"`;
const hookCommand = `${q(nodeBin)} ${q(hookScript)}`;
const statuslineCommand = `${q(nodeBin)} ${q(statuslineScript)}`;

mkdirSync(dirname(settingsFile), { recursive: true });
let settings = {};
let backup = null;
let rawOriginal = null;
if (existsSync(settingsFile)) {
  const raw = readFileSync(settingsFile, 'utf8');
  try {
    settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`xato: ${settingsFile} yaroqsiz JSON, o'zgartirilmadi (${e.message})`);
    process.exit(1);
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    console.error('xato: settings.json obyekt emas, o\'zgartirilmadi');
    process.exit(1);
  }
  rawOriginal = raw;
}

settings.env = { ...(settings.env ?? {}) };
Object.assign(settings.env, {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4319',
  OTEL_LOGS_EXPORT_INTERVAL: '5000',
  OTEL_RESOURCE_ATTRIBUTES: `host.name=${machineName}`,
});

settings.hooks = { ...(settings.hooks ?? {}) };
const hookConfig = { type: 'command', command: hookCommand, timeout: 10, async: true };
let added = 0;
for (const name of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop']) {
  const groups = Array.isArray(settings.hooks[name]) ? settings.hooks[name] : [];
  const found = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('cc-hook')));
  if (!found) {
    groups.push({ hooks: [hookConfig] });
    added++;
  }
  settings.hooks[name] = groups;
}

// Masofadan tasdiqlash (1.7): sinxron hook, xato/javobsiz holatda lokal so'rovga qaytadi
{
  const groups = Array.isArray(settings.hooks.PermissionRequest) ? settings.hooks.PermissionRequest : [];
  const found = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('cc-hook')));
  if (!found) {
    groups.push({ hooks: [{ type: 'command', command: `${hookCommand} --permission`, timeout: 330 }] });
    added++;
  }
  settings.hooks.PermissionRequest = groups;
}

// statusLine: mavjud buyruq saqlanadi. Uni argv'ga yopishtirmaymiz (| ; kabilar o'ramani buzadi), balki
// ~/.commander/config.json `statuslineCommand` ga yozamiz; cc-statusline uni AYNAN shu stdin bilan, shu shell'da ishga tushiradi.
let statusNote = 'statusLine: o\'zgartirilmadi (Commander allaqachon ulangan)';
const cur = settings.statusLine;
const configFile = join(cHome, 'config.json');
if (!cur || typeof cur.command !== 'string') {
  if (!cur) {
    settings.statusLine = { type: 'command', command: statuslineCommand };
    statusNote = 'statusLine: qo\'shildi (avval yo\'q edi)';
  } else {
    statusNote = 'statusLine: buyruq turida emas, tegilmadi';
  }
} else if (!cur.command.includes('cc-statusline')) {
  if (!existsSync(configFile)) {
    console.error(`xato: mavjud statusLine bor, lekin ${configFile} yo'q (avval enroll qiling)`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
  cfg.statuslineCommand = cur.command;
  writeFileSync(`${configFile}.tmp`, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${configFile}.tmp`, configFile);
  settings.statusLine = { ...cur, type: 'command', command: statuslineCommand };
  statusNote = 'statusLine: eski buyruq config.json statuslineCommand ga ko\'chirildi, o\'rami qo\'yildi';
}

const out = JSON.stringify(settings, null, 2) + '\n';
JSON.parse(out); // yakuniy tekshiruv
if (rawOriginal !== null && rawOriginal.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') === out) {
  console.log(`settings o'zgarmadi (allaqachon ulangan): ${settingsFile}`);
  console.log(`hook buyrug'i: ${hookCommand}`);
  process.exit(0);
}
if (rawOriginal !== null) {
  backup = `${settingsFile}.bak-commander-${Math.floor(Date.now() / 1000)}`;
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
console.log(`settings yangilandi: ${settingsFile}`);
console.log(`hook bloklari qo'shildi: ${added}/6; ${statusNote}`);
console.log(`zaxira: ${backup ?? '(yo\'q edi, yangi fayl)'}`);
console.log(`hook buyrug'i: ${hookCommand}`);
