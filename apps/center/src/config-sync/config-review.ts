import type { CommandReview, ConfigPlanResult } from '@commander/contracts';
import type { BundleContent } from './config-bundle.js';

/**
 * H-06: `config.apply` step-up kartasi uchun HAQIQIY xulosa. Eski karta faqat "Profil x vN (K fayl)" derdi; endi har fayl uchun
 * qo'shiladi/o'zgaradi/o'chadi (qator sonlari) va bajariladigan kontent bayroqlari chiqadi. Bayroq bo'lsa Telegram faqat havola beradi
 * (tasdiq dashboard'da, diff'ni to'liq ko'rib). Sof mantiq: regexlar chiziqli, kiritma cheklangan.
 */

export type ReviewFlag = 'exec' | 'hooks' | 'frontmatter' | 'bash_inject' | 'shell_snippet' | 'new_skill' | 'new_agent' | 'new_command' | 'settings_allow' | 'settings_env' | 'claude_md';

const FLAG_TEXT: Record<ReviewFlag, string> = {
  exec: 'bajariladigan/skript fayl (.sh .py .js ...)',
  hooks: "hooks (JSON/frontmatter): sessiya hodisalarida kod ishga tushadi",
  frontmatter: 'frontmatter allowed-tools / permissions (ruxsatlarni kengaytiradi)',
  bash_inject: "!`...` bash kiritmasi (buyruq matnidan kod bajariladi)",
  shell_snippet: 'shell kod bloklari (```bash/sh) commands/skills ichida',
  new_skill: "yangi skill",
  new_agent: "yangi agent",
  new_command: "yangi slash-buyruq",
  settings_allow: "settings: permissions.allow qo'shiladi",
  settings_env: 'settings: env o\'zgaruvchilari o\'rnatiladi',
  claude_md: "CLAUDE.md (modelga ko'rsatma) o'zgaradi",
};

/** Dashboard-tasdiqni majburlaydigan bayroqlar (CLAUDE.md o'zgarishi faqat eslatma). */
const BLOCKING: ReadonlySet<ReviewFlag> = new Set<ReviewFlag>(['exec', 'hooks', 'frontmatter', 'bash_inject', 'shell_snippet', 'new_skill', 'new_agent', 'new_command', 'settings_allow']);

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i;
const MAX_SCAN = 262_144;

function frontmatter(content: string): string {
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('\n---', 3);
  return end === -1 ? content.slice(0, 4096) : content.slice(0, Math.min(end + 4, 8192));
}

/** Bitta fayl uchun bayroqlar (mazmun bo'yicha). */
export function flagsForFile(path: string, kind: string, content: string, exec: boolean, isNew: boolean): ReviewFlag[] {
  const flags = new Set<ReviewFlag>();
  const text = content.length > MAX_SCAN ? content.slice(0, MAX_SCAN) : content;
  if (exec || (kind === 'skill' && SCRIPT_EXT.test(path))) flags.add('exec');
  if (isNew && kind === 'skill') flags.add('new_skill');
  if (isNew && kind === 'agent') flags.add('new_agent');
  if (isNew && kind === 'command') flags.add('new_command');
  if (kind === 'claude_md') flags.add('claude_md');
  const isMd = /\.md$/i.test(path);
  if (isMd) {
    const fm = frontmatter(text);
    if (/^[ \t]*hooks[ \t]*:/im.test(fm)) flags.add('hooks');
    if (/^[ \t]*(allowed-tools|allowedTools|permissions|disallowed-tools|tools)[ \t]*:/im.test(fm)) flags.add('frontmatter');
  }
  if (/\.json$/i.test(path) && /"(hooks|statusLine|mcpServers|permissions|apiKeyHelper|env)"[ \t]*:/.test(text)) flags.add('hooks');
  if (kind === 'command' || kind === 'skill' || kind === 'agent') {
    if (/(^|\n)[ \t]*!`|\s!`[^`\n]{1,300}`/.test(text)) flags.add('bash_inject');
    if (/```[ \t]{0,4}(?:bash|sh|zsh|shell|powershell|ps1|console)\b/i.test(text)) flags.add('shell_snippet');
  }
  return [...flags];
}

const lineCount = (s: string): number => (s.length === 0 ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0));

/** Unified diff'dagi qo'shilgan/o'chirilgan qatorlar. */
export function diffCounts(diff: string | undefined): { added: number; removed: number } | null {
  if (diff === undefined || diff.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added += 1;
    else if (l.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

export interface ConfigReviewSummary {
  /** Karta uchun matn (<= ~1800 belgi). */
  preview: string;
  review: CommandReview;
  counts: { add: number; update: number; delete: number };
  flags: ReviewFlag[];
}

/**
 * Reja (dry-run natijasi) + profil mazmunidan xulosa. `plan` agentning haqiqiy lokal holat bilan solishtirgan natijasi:
 * faqat `add|update|delete` yozuvlari ko'rsatiladi (`unchanged|skip` e'tiborsiz).
 */
export function summarizeConfigApply(name: string, version: number, mode: string, plan: ConfigPlanResult, bundle: BundleContent | null, execPaths: ReadonlySet<string>): ConfigReviewSummary {
  const content = new Map((bundle?.files ?? []).map((f) => [f.path, f.content]));
  const counts = { add: 0, update: 0, delete: 0 };
  const flags = new Set<ReviewFlag>();
  const fileLines: string[] = [];
  const flagged: string[] = [];
  for (const e of plan.entries) {
    if (e.action !== 'add' && e.action !== 'update' && e.action !== 'delete') continue;
    counts[e.action] += 1;
    const dc = diffCounts(e.diff);
    const text = content.get(e.path) ?? '';
    let lc: string;
    if (e.action === 'add') lc = `+${dc?.added ?? lineCount(text)}`;
    else if (e.action === 'delete') lc = `-${dc?.removed ?? '?'}`;
    else lc = dc ? `+${dc.added} -${dc.removed}` : '~';
    const mark = e.action === 'add' ? 'YANGI' : e.action === 'update' ? "o'zgaradi" : "o'chadi";
    let fileFlags: ReviewFlag[] = [];
    if (e.action !== 'delete') {
      fileFlags = flagsForFile(e.path, e.kind, text, execPaths.has(e.path), e.action === 'add');
      for (const f of fileFlags) flags.add(f);
    }
    const marks = fileFlags.filter((f) => BLOCKING.has(f));
    fileLines.push(`${lc.padEnd(9)} ${e.path} (${mark})${marks.length > 0 ? ` ⚠ ${marks.join(',')}` : ''}`);
    if (marks.length > 0) flagged.push(e.path);
  }
  const st = plan.settings;
  if (st?.changed) {
    if (st.allowAdd.length > 0) {
      flags.add('settings_allow');
      fileLines.push(`settings   permissions.allow +${st.allowAdd.length}: ${st.allowAdd.slice(0, 6).join(' | ')}${st.allowAdd.length > 6 ? ' …' : ''}`);
    }
    if (st.denyAdd.length > 0 || st.denyRemove.length > 0 || st.allowRemove.length > 0) fileLines.push(`settings   deny +${st.denyAdd.length}/-${st.denyRemove.length}, allow -${st.allowRemove.length}`);
    if (st.envSet.length > 0) {
      flags.add('settings_env');
      fileLines.push(`settings   env o'rnatiladi: ${st.envSet.slice(0, 6).join(', ')}`);
    }
    if (st.envRemove.length > 0) fileLines.push(`settings   env o'chadi: ${st.envRemove.slice(0, 6).join(', ')}`);
  }
  const shown = fileLines.slice(0, 22);
  const head = `Profil "${name}" v${version}, rejim: ${mode}: +${counts.add} yangi, ~${counts.update} o'zgaradi, -${counts.delete} o'chadi`;
  const more = fileLines.length > shown.length ? [`… (+${fileLines.length - shown.length} qator)`] : [];
  const preview = [head, ...shown, ...more].join('\n').slice(0, 1900);
  const flagList = [...flags];
  const blocking = flagList.filter((f) => BLOCKING.has(f));
  const reasons: string[] = [];
  if (blocking.length > 0) reasons.push(`⚠ Bajariladigan kontent bor: ${blocking.map((f) => FLAG_TEXT[f]).join('; ')}`);
  if (flagged.length > 0) reasons.push(`⚠ Bayroqli fayllar: ${flagged.slice(0, 5).join(', ')}${flagged.length > 5 ? ` (+${flagged.length - 5})` : ''}`);
  if (flags.has('claude_md')) reasons.push(`ℹ ${FLAG_TEXT.claude_md}`);
  if (flags.has('settings_env') && blocking.length === 0) reasons.push(`ℹ ${FLAG_TEXT.settings_env}`);
  return { preview, review: { required: blocking.length > 0, reasons: reasons.slice(0, 16) }, counts, flags: flagList };
}

/**
 * Joriy reja (dry-run) markazda saqlanmagan (restart/eskirgan): per-fayl farq noma'lum. Profil mazmuni bo'yicha bayroqlar
 * hisoblanadi va dashboard'da ko'rib chiqish HAR DOIM talab qilinadi (egasi diff'ni qayta oladi).
 */
export function summarizeWithoutPlan(name: string, version: number, mode: string, bundle: BundleContent | null, execPaths: ReadonlySet<string>): ConfigReviewSummary {
  const files = bundle?.files ?? [];
  const flags = new Set<ReviewFlag>();
  const lines: string[] = [];
  for (const f of files.slice(0, 22)) {
    const kind = f.path === 'CLAUDE.md' ? 'claude_md' : f.path.startsWith('agents/') ? 'agent' : f.path.startsWith('commands/') ? 'command' : 'skill';
    const ff = flagsForFile(f.path, kind, f.content, execPaths.has(f.path), true);
    for (const x of ff) flags.add(x);
    lines.push(`~${lineCount(f.content).toString().padEnd(8)} ${f.path}${ff.filter((x) => BLOCKING.has(x)).length > 0 ? ` ⚠ ${ff.filter((x) => BLOCKING.has(x)).join(',')}` : ''}`);
  }
  const more = files.length > 22 ? [`… (+${files.length - 22} fayl)`] : [];
  const preview = [`Profil "${name}" v${version}, rejim: ${mode}: ${files.length} fayl (farq noma'lum)`, ...lines, ...more].join('\n').slice(0, 1900);
  const reasons = ["⚠ Joriy farq (qo'shiladi/o'zgaradi/o'chadi) markazda saqlanmagan: dashboard'da diff'ni ko'rib tasdiqlang"];
  const blocking = [...flags].filter((f) => BLOCKING.has(f));
  if (blocking.length > 0) reasons.push(`⚠ Bajariladigan kontent bor: ${blocking.map((f) => FLAG_TEXT[f]).join('; ')}`);
  return { preview, review: { required: true, reasons }, counts: { add: 0, update: files.length, delete: 0 }, flags: [...flags] };
}
