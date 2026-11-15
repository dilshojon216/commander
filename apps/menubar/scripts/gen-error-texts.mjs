#!/usr/bin/env node
// Web dashboard'dagi buyruq xato matnlari jadvalini (apps/dashboard/lib/control-ui.ts `ERROR_TEXT`, deploy/git/config/log
// jadvallari bilan birga) Swift'ga o'tkazadi, shunda native va web matnlari bir xil qoladi (qo'lda nusxa YO'Q).
// Foydalanish: node scripts/gen-error-texts.mjs [--check]   (--check: fayl eskirgan bo'lsa exit 1)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWebModule, repoRoot } from './lib/load-web-module.mjs';

const target = join(repoRoot, 'apps/menubar/Sources/DashboardCore/API/ErrorTexts+Generated.swift');
const check = process.argv.includes('--check');

const { ERROR_TEXT } = await loadWebModule('control-ui');

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const rows = Object.entries(ERROR_TEXT).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `        "${esc(k)}": "${esc(v)}",`);
const out = `// ESKIRMASIN: bu fayl scripts/gen-error-texts.mjs bilan generatsiya qilinadi (manba: apps/dashboard/lib/control-ui.ts).
// Qo'lda tahrirlamang; matnni web'da o'zgartirib, skriptni qayta ishga tushiring.

enum GeneratedErrorTexts {
    /// Buyruq xato kodi -> o'zbekcha matn (${rows.length} ta).
    static let commands: [String: String] = [
${rows.join('\n')}
    ]
}
`;

if (check) {
  let current = '';
  try { current = readFileSync(target, 'utf8'); } catch { /* yo'q */ }
  if (current !== out) {
    console.error('XATO: ErrorTexts+Generated.swift eskirgan. Ishga tushiring: node apps/menubar/scripts/gen-error-texts.mjs');
    process.exit(1);
  }
  console.log(`gen-error-texts: yangi (${rows.length} ta)`);
} else {
  writeFileSync(target, out);
  console.log(`yozildi: ${rows.length} ta kod -> ${target}`);
}
