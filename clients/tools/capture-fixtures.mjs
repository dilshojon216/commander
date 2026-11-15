#!/usr/bin/env node
// Jonli center'dan o'qish-faqat GET'lar orqali namunalar olib, tozalab clients/fixtures/ ga yozadi.
// Ishlatish: node clients/tools/capture-fixtures.mjs [http://127.0.0.1:4318/api/c]
// Sanitizatsiya: uuid'lar barqaror soxta uuid'ga, uzun matnlar qisqa matnga, yo'llar/hostnomlar umumiy qiymatga.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';

const base = process.argv[2] ?? 'http://127.0.0.1:4318/api/c';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
mkdirSync(out, { recursive: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const uuidMap = new Map();
function fakeUuid(real) {
  const k = real.toLowerCase();
  if (!uuidMap.has(k)) {
    const h = createHash('sha1').update(`commander-fixture:${k}`).digest('hex');
    uuidMap.set(k, `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`);
  }
  return uuidMap.get(k);
}
// Lokal foydalanuvchi nomi (hostname/slug ichida ham) — fixture'ga tushmasin
const USER_RE = new RegExp(userInfo().username.replace(/[^a-z0-9]/gi, '').slice(0, 8) + '\\w*', 'gi');

function cleanString(s) {
  if (UUID.test(s)) return fakeUuid(s);
  if (ISO.test(s)) return s;
  let t = s.replace(/\/Users\/[^/\s]+/g, '/Users/dev').replace(/\/home\/[^/\s]+/g, '/home/dev').replace(USER_RE, 'dev');
  t = t.replace(/[0-9a-f]{32,}/gi, (m) => createHash('sha1').update(m).digest('hex').slice(0, 12));
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'user@example.com');
  t = t.replace(/\b(sk-ant-|ghp_|cmdr_)[\w-]+/g, '$1REDACTED');
  if (t.length > 60) t = `${t.slice(0, 20).replace(/\s+\S*$/, '')} (sanitized sample text)`;
  return t;
}
function clean(v, key = '') {
  if (typeof v === 'string') return cleanString(v);
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => clean(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[cleanString(k) === k ? k : k] = clean(x, k);
    return o;
  }
  return v;
}

async function get(path) {
  const r = await fetch(`${base}/${path}`, { headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  return r.json();
}
const first = (r) => (r && Array.isArray(r.items) && r.items[0]) || null;

const machines = await get('machines');
const sessions = await get('sessions?limit=5');
const projects = await get('projects');
const sess = first(sessions);
const proj = first(projects);
const mach = first(machines);
const approvals = await get('approvals');
const oneApproval = approvals && (approvals.pending?.[0] ?? approvals.recent?.[0]);

const plan = [
  ['machines', machines],
  ['sessions', sessions],
  ['session-events', sess && (await get(`sessions/${sess.id}/events?limit=5`))],
  ['projects', projects],
  ['project-detail', proj && (await get(`projects/${proj.id}`))],
  ['project-tasks', proj && (await get(`projects/${proj.id}/tasks`))],
  ['project-commits', proj && (await get(`projects/${proj.id}/commits`))],
  ['usage-summary', await get('usage/summary')],
  ['usage-series', await get('usage?bucket=1h&from=' + encodeURIComponent(new Date(Date.now() - 6 * 3600e3).toISOString()))],
  ['limits', await get('limits')],
  ['approvals', approvals],
  ['approval', oneApproval ? await get(`approvals/${oneApproval.id}`) : null],
  ['queue', await get('queue')],
  ['alerts', await get('alerts')],
  ['health-summary', await get('health/summary')],
  ['machine-health', mach && (await get(`machines/${mach.id}/health`))],
  ['templates', await get('templates')],
  ['orchestrations', await get('orchestrations')],
  ['tasks', await get('tasks')],
];
for (const [name, data] of plan) {
  if (data == null) {
    console.log(`skip ${name}`);
    continue;
  }
  writeFileSync(join(out, `${name}.json`), JSON.stringify(clean(data), null, 2) + '\n');
  console.log(`ok   ${name}`);
}
