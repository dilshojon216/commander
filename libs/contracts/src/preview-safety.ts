/**
 * Egaga ko'rsatiladigan buyruq/prompt xavfsizligi (H-04, M-16): xavfli andozalar, yashirin belgilar, "ko'p qismi yashirilgan"
 * hisobi. Sof va chiziqli (cheklangan kvantifikatorlar, kiritma `SCAN_MAX` bilan cheklangan). Center (Telegram kartalari)
 * va dashboard (approval/shablon/navbat ko'rinishi) BIR XIL qoidalardan foydalanadi.
 */

export const SCAN_MAX = 65_536;
/** Matnning shu ulushidan ko'pi `[REDACTED]` belgilar bo'lsa "ko'p qismi yashirilgan". */
export const MOSTLY_HIDDEN_SHARE = 0.5;
/** Belgilardan tashqari ko'rinadigan harf-raqam shundan kam bo'lsa ham (maxfiy belgi bor bo'lsa) "ko'p qismi yashirilgan". */
export const MIN_VISIBLE_ALNUM = 8;

export interface DangerRule {
  id: string;
  label: string;
  re: RegExp;
}

const W = '(?<![A-Za-z0-9_./-])';
const E = '(?![A-Za-z0-9_-])';

export const DANGER_RULES: readonly DangerRule[] = [
  { id: 'pipe_shell', label: 'pipe → shell/interpretator (| sh)', re: new RegExp(`\\|[ \\t]{0,8}(?:sudo[ \\t]{1,8})?(?:/[a-z/]{0,20})?(?:ba|z|da|k|c|fi)?sh${E}|\\|[ \\t]{0,8}(?:python3?|node|perl|ruby|php)${E}`, 'i') },
  { id: 'download', label: 'curl/wget (tarmoqdan yuklash)', re: new RegExp(`${W}(?:curl|wget)${E}`, 'i') },
  { id: 'rm_rf', label: 'rm -rf (o\'chirish)', re: new RegExp(`${W}rm[ \\t]{1,8}(?:-[A-Za-z]{0,6}[rR][A-Za-z]{0,6}|--recursive)${E}`) },
  { id: 'base64_d', label: 'base64 -d (yashirilgan kod)', re: new RegExp(`${W}base64[^\\n|;&]{0,24}[ \\t](?:-d|-D|--decode)${E}`, 'i') },
  { id: 'eval', label: 'eval', re: new RegExp(`${W}eval${E}`) },
  { id: 'chmod_x', label: 'chmod +x', re: new RegExp(`${W}chmod[ \\t]{1,8}(?:-[A-Za-z]{1,4}[ \\t]{1,8}){0,2}(?:[ugoa]{0,3}\\+[rwXs]{0,3}x|[0-7]?[0-7][1357][0-7]${E})`) },
  { id: 'sudo', label: 'sudo', re: new RegExp(`${W}sudo${E}`) },
  { id: 'ssh', label: 'ssh/scp/rsync (masofaviy mashina)', re: new RegExp(`${W}(?:ssh|scp|sftp|rsync)${E}`) },
  { id: 'netcat', label: 'nc/netcat (tarmoq kanali)', re: new RegExp(`${W}(?:nc|ncat|netcat|socat)${E}`) },
  { id: 'inline_code', label: 'bash -c / python -c / node -e (inline kod)', re: new RegExp(`${W}(?:ba|z|da)?sh[ \\t]{1,8}-[A-Za-z]{0,3}c${E}|${W}(?:python3?|perl|ruby)[ \\t]{1,8}-[A-Za-z]{0,3}[ce]${E}|${W}node[ \\t]{1,8}(?:-[A-Za-z]{0,3}e|--eval)${E}`) },
  { id: 'dotfile_write', label: "dotfile'ga yozish (> ~/.zshrc, > .env ...)", re: /(?:>{1,2}|\btee(?:[ \t]{1,8}-a)?)[ \t]{0,6}[^\s|;&>]{0,200}(?:^|\/|~\/)\.[A-Za-z_][A-Za-z0-9_.-]{0,40}(?![A-Za-z0-9_.-])|(?:>{1,2})[ \t]{0,6}\.[A-Za-z_][A-Za-z0-9_.-]{0,40}/ },
  { id: 'persistence', label: 'crontab/launchctl/systemctl (doimiy ishga tushirish)', re: new RegExp(`${W}(?:crontab|launchctl|systemctl|at)${E}[ \\t]{0,8}(?:-|[a-z]|$)`) },
  { id: 'subst', label: 'buyruq almashtirish $(...) / `...`', re: /\$\(|`[^`\n]{1,200}`/ },
  { id: 'env_exfil', label: 'env/printenv (muhit o\'zgaruvchilari)', re: new RegExp(`${W}(?:env|printenv)${E}[ \\t]{0,8}(?:\\||>|$)`) },
];

const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** Telegram/dashboard'ga chiqishdan oldin: bidi (RLO), nol-kenglik, C0/C1 boshqaruv belgilari olib tashlanadi (\n, \t qoladi). */
export function stripHiddenChars(s: string): { text: string; removed: number } {
  let removed = 0;
  const text = s.replace(HIDDEN_CHARS, () => {
    removed += 1;
    return '';
  });
  return { text, removed };
}

export function detectDanger(text: string): DangerRule[] {
  const t = text.length > SCAN_MAX ? text.slice(0, SCAN_MAX) : text;
  return DANGER_RULES.filter((r) => r.re.test(t));
}

const MARKER_RE = /\[REDACTED(?: [A-Z]{2,8})?\]/g;

/** Redaktsiya belgilari egallagan ulush va ularsiz qolgan ko'rinadigan harf-raqamlar soni. */
export function redactionStats(text: string): { markers: number; share: number; visibleAlnum: number } {
  const t = text.length > SCAN_MAX ? text.slice(0, SCAN_MAX) : text;
  let markerChars = 0;
  let markers = 0;
  const rest = t.replace(MARKER_RE, (m) => {
    markers += 1;
    markerChars += m.length;
    return ' ';
  });
  const visibleAlnum = (rest.match(/[A-Za-z0-9]/g) ?? []).length;
  return { markers, share: t.length === 0 ? 0 : markerChars / t.length, visibleAlnum };
}

export function isMostlyHidden(text: string): boolean {
  const s = redactionStats(text);
  return s.markers > 0 && (s.share > MOSTLY_HIDDEN_SHARE || s.visibleAlnum < MIN_VISIBLE_ALNUM);
}

export interface PreviewResult {
  /** Ko'rsatiladigan (kesilgan, tozalangan) matn; HTML-escape QILINMAGAN. */
  shown: string;
  totalChars: number;
  /** Ko'rsatilmagan belgilar soni (kesilgan dum). */
  hiddenChars: number;
  /** "… (+N belgi, to'liq ko'rinish dashboard'da)" yoki ''. */
  truncationNote: string;
  /** Butun matndagi (kesilgan qism ham) xavfli andozalar. */
  flags: DangerRule[];
  /** Xavfli andoza faqat KESILGAN qismda bor. */
  dangerHidden: boolean;
  /** Matn DB'da ham kesilgan: oxiri tekshirilmagan. */
  unscannedTail: boolean;
  /** Matnning ko'p qismi redaktsiya bilan yashirilgan. */
  mostlyHidden: boolean;
  /** Olib tashlangan bidi/boshqaruv belgilari soni. */
  strippedChars: number;
  /** Telegram'da bir-tap tasdiq berilmasin: faqat dashboard'da to'liq ko'rib. */
  requireDashboard: boolean;
  /** Ogohlantirish qatorlari (oddiy matn; HTML'ga chiqarishda escape qiling). */
  reasons: string[];
}

export const truncationNote = (n: number): string => `… (+${n} belgi, to'liq ko'rinish dashboard'da)`;

/**
 * `redacted` allaqachon redakt qilingan matn (DB'dagi). `totalOverride`: matn DB'da o'zi kesilgan bo'lsa haqiqiy uzunlik
 * (masalan `promptLength`): shunda ko'rsatilmagan belgilar to'g'ri hisoblanadi.
 */
export function buildPreview(redacted: string, maxChars: number, totalOverride?: number): PreviewResult {
  const { text: clean, removed } = stripHiddenChars(redacted);
  const chars = Array.from(clean.length > SCAN_MAX * 2 ? clean.slice(0, SCAN_MAX * 2) : clean);
  const total = Math.max(totalOverride ?? 0, chars.length + (clean.length > SCAN_MAX * 2 ? clean.length - SCAN_MAX * 2 : 0));
  const shown = chars.slice(0, maxChars).join('');
  const hiddenChars = Math.max(0, total - Array.from(shown).length);
  const flags = detectDanger(clean);
  const shownFlags = new Set(detectDanger(shown).map((r) => r.id));
  // Kesilgan qismdagi xavfli andoza: ko'rsatilgan qismda yo'q, lekin butun (DB'dagi) matnda bor.
  const dangerHidden = hiddenChars > 0 && flags.some((r) => !shownFlags.has(r.id));
  // Matn DB'ning o'zida kesilgan (`totalOverride` > saqlangan): oxirini hech kim skanerlay olmaydi.
  const unscannedTail = totalOverride !== undefined && totalOverride > chars.length;
  const mostlyHidden = isMostlyHidden(clean);
  const reasons: string[] = [];
  if (flags.length > 0) reasons.push(`⚠ Ehtiyot bo'ling: ${flags.map((r) => r.label).join('; ')}`);
  if (dangerHidden) reasons.push("⚠ Xavfli andoza kesilgan qismda ham bor: to'liq matnni dashboard'da ko'ring");
  if (unscannedTail) reasons.push("⚠ Matnning oxiri saqlanmagan/tekshirilmagan: to'liq ko'rib chiqish uchun dashboard'ga qarang");
  if (mostlyHidden) reasons.push("⚠ ko'p qismi yashirilgan (sir sifatida maskalangan): Telegram'dan tasdiqlab bo'lmaydi, dashboard'da ko'ring");
  if (removed > 0) reasons.push(`⚠ ${removed} ta yashirin boshqaruv belgisi (bidi/nol-kenglik) olib tashlandi`);
  return {
    shown,
    totalChars: total,
    hiddenChars,
    truncationNote: hiddenChars > 0 ? truncationNote(hiddenChars) : '',
    flags,
    dangerHidden,
    unscannedTail,
    mostlyHidden,
    strippedChars: removed,
    requireDashboard: mostlyHidden || dangerHidden || unscannedTail,
    reasons,
  };
}

