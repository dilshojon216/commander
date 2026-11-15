#!/usr/bin/env node
// settings.json'dagi cc-hook buyrug'ini AYNAN Claude Code kabi ishga tushiradi: Node child_process orqali Git Bash `bash -c "<buyruq>"`,
// stdin'ga sintetik SessionStart payload. Chiqish: `hook_exit=<kod>`; stdout/stderr bo'sh bo'lishi kerak (fail-safe jimlik).
// Foydalanish: node verify-hook.mjs --bash <bash.exe> --session-id <id> [--event SessionStart] [--settings <fayl>]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { bash: { type: 'string' }, 'session-id': { type: 'string' }, event: { type: 'string' }, settings: { type: 'string' } } });
const bash = values.bash ?? '/bin/sh';
const event = values.event ?? 'SessionStart';
const settings = JSON.parse(readFileSync(values.settings ?? join(homedir(), '.claude', 'settings.json'), 'utf8').replace(/^﻿/, ''));
const cmd = (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command).find((c) => typeof c === 'string' && c.includes('cc-hook'));
if (!cmd) {
  console.error(`xato: ${event} hook'ida cc-hook yo'q`);
  process.exit(1);
}
if (!values['session-id']) {
  console.error('xato: --session-id majburiy');
  process.exit(2);
}
const payload = JSON.stringify({ hook_event_name: event, session_id: values['session-id'], cwd: homedir(), source: 'startup' });
const t0 = Date.now();
const r = spawnSync(bash, ['-c', cmd], { input: payload, encoding: 'utf8', timeout: 15_000 });
console.log(`hook_command=${cmd}`);
console.log(`hook_exit=${r.status}`);
console.log(`hook_ms=${Date.now() - t0}`);
console.log(`hook_stdout_empty=${r.stdout === ''} hook_stderr=${JSON.stringify(r.stderr)}`);
process.exit(r.status === 0 && r.stdout === '' ? 0 : 1);
