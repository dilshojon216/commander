#!/usr/bin/env node
// Web dashboard'ning elevation ("yangi tasdiq") qoidalarini (apps/dashboard/lib/proxy-rules.ts `elevationFor`) native'ga o'tkazadi:
//  1) Sources/DashboardCore/Security/ElevationRules+Generated.swift — regex matnlari (qo'lda nusxa yo'q).
//  2) Tests/DashboardCoreTests/Fixtures/elevation-corpus.json — web'ning HAQIQIY natijalari (yo'l x metod x tana); Swift testi
//     o'z hisobini shu bilan solishtiradi, shuning uchun ikki tomon ajralib ketsa test yiqiladi.
// Foydalanish: node scripts/gen-elevation-rules.mjs [--check]   (--check: fayllar eskirgan bo'lsa exit 1)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWebModule, repoRoot } from './lib/load-web-module.mjs';

const swiftTarget = join(repoRoot, 'apps/menubar/Sources/DashboardCore/Security/ElevationRules+Generated.swift');
const corpusTarget = join(repoRoot, 'apps/menubar/Tests/DashboardCoreTests/Fixtures/elevation-corpus.json');
const check = process.argv.includes('--check');

const web = await loadWebModule('proxy-rules');
const sources = web.ELEVATION_RULE_SOURCES;
const UUID = '00000000-0000-4000-8000-000000000001';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// --- regex matnidan namunaviy yo'llar yasash (oddiy qismlar: UUID, sana, harfli guruhlar) ---------------------------------

function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '|' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function expand(s) {
  let results = [''];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '(') {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      const alts = splitTop(s.slice(i + 1, j).replace(/^\?:/, '')).flatMap(expand);
      const optional = s[j + 1] === '?';
      const options = optional ? ['', ...alts] : alts;
      results = results.flatMap((r) => options.map((o) => r + o));
      i = j + 1 + (optional ? 1 : 0);
    } else {
      results = results.map((r) => r + s[i]);
      i++;
    }
  }
  return results;
}

function instantiate(source) {
  const s = source
    .replace(/^\^/, '').replace(/\$$/, '')
    .replace(/\\\//g, '/').replace(/\\\./g, '.')
    .replace(/\[0-9a-fA-F-\]\{36\}/g, UUID)
    .replace(/\[0-9\]\{1,18\}/g, '12')
    .replace(/\\d\{4\}-\\d\{2\}-\\d\{2\}/g, '2025-11-14');
  return expand(s).filter((p) => !/[\[\]{}*+?\\^$()|]/.test(p));
}

// Murakkab regex'lar (kanban kaliti) va oddiy yo'llar qo'lda: qamrov to'liq bo'lsin.
const manual = [
  'commands', `commands/${UUID}/cancel`, `commands/${UUID}/confirm`, `approvals/${UUID}/decision`, 'approvals', 'sessions', 'machines',
  `projects/${UUID}/tasks/1.2/board`, `projects/${UUID}/tasks/part~x%3A1.2/board`, `projects/${UUID}/tasks/part~x:1.2/board`,
  'queue', `queue/${UUID}`, `queue/${UUID}/run-now`, `queue/${UUID}/cancel`,
  'templates', `templates/${UUID}`, `templates/${UUID}/render`, `templates/${UUID}/send-prompt`,
  'orchestrations', `orchestrations/${UUID}/cancel`, 'approval-rules', 'approval-rules/12', 'noma-lum/yol', 'assistant/ask',
];

const fromRules = [
  sources.decision, sources.queueItem, sources.templateItem,
  ...sources.exempt, ...sources.workPosts, ...sources.writes.map((w) => w.source),
].flatMap(instantiate);
const paths = [...new Set([...manual, ...fromRules])].sort();

// --- corpus ----------------------------------------------------------------------------------------------------------------

const corpus = [];
for (const path of paths) {
  const segments = path.split('/');
  for (const method of METHODS) {
    const elevation = web.elevationFor(method, segments);
    const decision = web.classifyProxyRequest(method, segments);
    const bodies = elevation === 'decision' ? [{ behavior: 'allow' }, { behavior: 'deny' }]
      : elevation === 'command' ? [{ type: 'session.start' }, { type: 'session.stop' }] : [null];
    for (const body of bodies) {
      corpus.push({
        method, path, body, elevation,
        required: web.elevationRequired(elevation, body ?? undefined),
        allowed: decision.ok,
        scope: decision.ok ? decision.scope : null,
      });
    }
  }
}

// --- Swift ------------------------------------------------------------------------------------------------------------------

const raw = (s) => `#"${s}"#`;
const swift = `// ESKIRMASIN: bu fayl scripts/gen-elevation-rules.mjs bilan generatsiya qilinadi (manba: apps/dashboard/lib/proxy-rules.ts).
// Qo'lda tahrirlamang; qoidani web'da o'zgartirib, skriptni qayta ishga tushiring.

enum GeneratedElevationRules {
    /// \`POST /approvals/:id/decision\` — ruxsat qarori (\`decision\` elevation).
    static let decision = ${raw(sources.decision)}
    static let queueItem = ${raw(sources.queueItem)}
    static let templateItem = ${raw(sources.templateItem)}
    /// Elevation talab QILMAYDIGAN o'zgartiruvchi yo'llar (${sources.exempt.length} ta); qolgan hammasi fail-closed \`required\`.
    static let exempt: [String] = [
${sources.exempt.map((s) => `        ${raw(s)},`).join('\n')}
    ]
}
`;
const corpusJSON = JSON.stringify(corpus, null, 1) + '\n';

function emit(path, content, label) {
  if (check) {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { /* yo'q */ }
    if (current !== content) {
      console.error(`XATO: ${label} eskirgan. Ishga tushiring: node apps/menubar/scripts/gen-elevation-rules.mjs`);
      process.exit(1);
    }
  } else {
    writeFileSync(path, content);
  }
}
emit(swiftTarget, swift, 'ElevationRules+Generated.swift');
emit(corpusTarget, corpusJSON, 'elevation-corpus.json');
console.log(`${check ? 'gen-elevation-rules: yangi' : 'yozildi'}: ${paths.length} yo'l, ${corpus.length} holat, ${sources.exempt.length} istisno`);
