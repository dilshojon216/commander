import type { ClientReportModel } from '@commander/contracts';

/**
 * Mijoz hisoboti HTML (6.8): bitta o'z-o'zini qamragan fayl. Xavfsizlik:
 *  - har bir dinamik qiymat `esc()` dan o'tadi (matn); sonlar `Number` bilan majburlanadi;
 *  - CSP `<meta>`: `default-src 'none'` (skript, tashqi resurs, forma, iframe YO'Q), faqat inline uslub;
 *  - tashqi resurs yo'q: `<script>`, `<link>`, `<img src>`, `url()`, `@import`, havola (`href`) yo'q; grafik = inline SVG;
 *  - `noindex`, `referrer=no-referrer`.
 */

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

export function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** `2026-11-14` -> "14 noyabr 2026" (noto'g'ri format o'zgarishsiz, lekin baribir escape qilinadi). */
export function uzDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${Number(m[3])} ${name} ${m[1]}` : day;
}

export const uzPeriod = (from: string, to: string): string => (from === to ? uzDay(from) : `${uzDay(from)} – ${uzDay(to)}`);

export function uzHours(seconds: number): string {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)} soat ${String(m % 60).padStart(2, '0')} daqiqa`;
}

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const STYLE = `
:root{color-scheme:light dark;--bg:#fafaf8;--card:#fff;--ink:#1c1c1a;--mut:#6b6b66;--line:#e4e4de;--done:#2f9e63;--doing:#e0a020;--todo:#c9c9c2;--acc:#ff7a45}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#ecece6;--mut:#a0a09a;--line:#34342f;--done:#3fbf7a;--doing:#e8b341;--todo:#4a4a44}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 48px}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}h3{font-size:14px;margin:18px 0 6px}
.sub{color:var(--mut);margin:0 0 20px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0}
.kpis{display:flex;flex-wrap:wrap;gap:12px}.kpi{flex:1 1 120px}.kpi b{display:block;font-size:24px}.kpi span{color:var(--mut);font-size:13px}
ul{margin:6px 0;padding-left:20px}li{margin:3px 0}.mut{color:var(--mut)}.tag{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;color:#fff}
.tag.done{background:var(--done)}.tag.doing{background:var(--doing)}.tag.todo{background:var(--todo);color:var(--ink)}
svg{display:block;width:100%;height:auto}footer{margin-top:32px;color:var(--mut);font-size:12px}
@media print{body{background:#fff;color:#000}.card{break-inside:avoid;border-color:#ccc}}
`;

function progressSvg(m: ClientReportModel): string {
  const { done, inProgress, remaining, total } = m.progress;
  const W = 600;
  const seg = (n: number): number => (total === 0 ? 0 : (Number(n) / total) * W);
  const wd = seg(done);
  const wp = seg(inProgress);
  const wr = Math.max(0, W - wd - wp);
  const label = `Bajarilgan ${Number(done)}, jarayonda ${Number(inProgress)}, qolgan ${Number(remaining)}`;
  return `<svg viewBox="0 0 ${W} 28" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>
<rect x="0" y="0" width="${W}" height="28" rx="8" fill="var(--todo)" opacity="${total === 0 ? 1 : 0.35}"/>
${total === 0 ? '' : `<rect x="0" y="0" width="${wd.toFixed(2)}" height="28" fill="var(--done)"/><rect x="${wd.toFixed(2)}" y="0" width="${wp.toFixed(2)}" height="28" fill="var(--doing)"/><rect x="${(wd + wp).toFixed(2)}" y="0" width="${wr.toFixed(2)}" height="28" fill="var(--todo)"/>`}
</svg>`;
}

function weeklySvg(m: ClientReportModel): string {
  const rows = m.weekly;
  if (rows.length === 0) return '';
  const max = Math.max(1, ...rows.map((r) => Number(r.closed)));
  const W = 600;
  const H = 120;
  const slot = W / rows.length;
  const bw = Math.min(40, slot * 0.6);
  const bars = rows
    .map((r, i) => {
      const h = Math.round((Number(r.closed) / max) * (H - 34));
      const x = (i * slot + (slot - bw) / 2).toFixed(1);
      const lbl = `${uzDay(r.weekStart)}: ${Number(r.closed)} ta`;
      return `<g><title>${esc(lbl)}</title><rect x="${x}" y="${H - 20 - h}" width="${bw.toFixed(1)}" height="${h}" rx="3" fill="var(--acc)"/><text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 22 - h}" text-anchor="middle" font-size="11" fill="var(--ink)">${Number(r.closed)}</text><text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="10" fill="var(--mut)">${esc(r.weekStart.slice(5))}</text></g>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Haftalar bo'yicha yopilgan vazifalar">${bars}</svg>`;
}

const list = (items: ReadonlyArray<{ title: string }>): string => (items.length === 0 ? '<p class="mut">—</p>' : `<ul>${items.map((t) => `<li>${esc(t.title)}</li>`).join('')}</ul>`);

export function renderClientReportHtml(m: ClientReportModel): string {
  const p = m.progress;
  const groups = m.groups
    .map(
      (g) => `<section class="card"><h2>${esc(g.name)}</h2>
${g.closedInPeriod.length > 0 ? `<h3>Davr ichida bajarilgan</h3>${list(g.closedInPeriod)}` : ''}
<h3><span class="tag doing">Jarayonda</span></h3>${list(g.inProgress)}
<h3><span class="tag todo">Qolgan</span></h3>${list(g.remaining)}
<h3><span class="tag done">Bajarilgan (jami)</span></h3>${list(g.done)}
</section>`,
    )
    .join('\n');
  const summaries = m.summaries.length === 0 ? '' : `<h2>Haftalik xulosa</h2>${m.summaries.map((s) => `<section class="card"><h3>${esc(uzDay(s.weekStart))} haftasi</h3>${list(s.lines.map((l) => ({ title: l })))}</section>`).join('\n')}`;
  const hours = m.activeSeconds === null ? '' : `<div class="kpi"><b>${esc(uzHours(m.activeSeconds))}</b><span>Ishlangan vaqt (davr)</span></div>`;
  return `<!doctype html>
<html lang="uz"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(m.title)} — loyiha holati</title><style>${STYLE}</style></head>
<body><main>
<h1>${esc(m.title)}</h1>
<p class="sub">Loyiha holati hisoboti · ${esc(uzPeriod(m.periodFrom, m.periodTo))}</p>
<section class="card"><div class="kpis">
<div class="kpi"><b>${Number(p.percentDone)}%</b><span>Bajarildi</span></div>
<div class="kpi"><b>${Number(p.done)}</b><span>Bajarilgan vazifa</span></div>
<div class="kpi"><b>${Number(p.inProgress)}</b><span>Jarayonda</span></div>
<div class="kpi"><b>${Number(p.remaining)}</b><span>Qolgan</span></div>${hours}
</div>
<div style="margin-top:14px">${progressSvg(m)}</div></section>
<h2>Haftalar bo'yicha bajarilgan vazifalar</h2><section class="card">${weeklySvg(m)}</section>
${groups}
${summaries}
${m.truncated ? '<p class="mut">Ro\'yxatlar qisqartirilgan.</p>' : ''}
<footer>Hisobot ${esc(uzDay(m.generatedDay))} sanasida yaratilgan. Faqat ko'rish uchun: kod, yozishmalar va ichki ma'lumotlar kiritilmagan.</footer>
</main></body></html>
`;
}

/** Tekshiruv uchun: HTML'dan ko'rinadigan matn (`<style>` va teglarsiz, entity'lar ochilgan). */
export function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}
