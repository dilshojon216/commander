import { SCAN_LIMITS } from '@commander/contracts';
import type { ScanFinding, ScanSeverity } from '@commander/contracts';
import { redactShapes } from './redact.js';

/**
 * 6.10: kuzatiladigan fayllarda commit qilingan sirlarni qidirish. MAXFIYLIK: natijada FAQAT fayl (nisbiy) + qator + qoida nomi;
 * topilgan qiymat va uning atrofidagi matn HECH QACHON chiqmaydi (sarlavha har qoida uchun qat'iy jumla).
 * Aniq shakllar (`redact.ts` SHAPE_PATTERNS bilan bir xil g'oya) nomli qoidalar bilan; qolgan shakllar `redactShapes` orqali umumiy "secret-shape".
 */

interface Rule {
  name: string;
  re: RegExp;
  severity: ScanSeverity;
  title: string;
}

const S = '(?<![A-Za-z0-9_-])';
export const SECRET_RULES: readonly Rule[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/, severity: 'critical', title: 'Private key block committed' },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'critical', title: 'AWS access key id committed' },
  { name: 'anthropic-key', re: new RegExp(`${S}sk-ant-[A-Za-z0-9_-]{8,}`), severity: 'high', title: 'Anthropic API key committed' },
  { name: 'openai-key', re: new RegExp(`${S}sk-[A-Za-z0-9_-]{20,}`), severity: 'high', title: 'API key (sk-...) committed' },
  { name: 'github-token', re: new RegExp(`${S}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`), severity: 'high', title: 'GitHub token committed' },
  { name: 'slack-token', re: new RegExp(`${S}xox[abprs]-[A-Za-z0-9-]{10,}`), severity: 'high', title: 'Slack token committed' },
  { name: 'stripe-key', re: new RegExp(`${S}(?:sk|rk)_live_[A-Za-z0-9]{16,}`), severity: 'high', title: 'Stripe live key committed' },
  { name: 'google-api-key', re: new RegExp(`${S}AIza[0-9A-Za-z_-]{30,}`), severity: 'high', title: 'Google API key committed' },
  { name: 'npm-token', re: new RegExp(`${S}npm_[A-Za-z0-9]{30,}`), severity: 'high', title: 'npm token committed' },
  { name: 'telegram-bot-token', re: /(?<![0-9])\d{8,10}:AA[A-Za-z0-9_-]{30,}/, severity: 'high', title: 'Telegram bot token committed' },
  { name: 'webhook-url', re: /\b(?:hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/_-]{16,}|discord(?:app)?\.com\/api\/webhooks\/\d{6,}\/[A-Za-z0-9_-]{20,})/, severity: 'high', title: 'Webhook URL with secret path committed' },
  { name: 'jwt', re: new RegExp(`${S}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*`), severity: 'moderate', title: 'JSON Web Token committed' },
  { name: 'url-credentials', re: /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@"'<>]{1,64}:[^\s"'<>@]{3,128}@[A-Za-z0-9.-]/i, severity: 'high', title: 'Credentials inside a URL committed' },
];

const NAME_RE = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|APIKEY|PRIVATE[-_]?KEY|ACCESS[-_]?KEY|CREDENTIALS?)/i;
// NAME = "value" | NAME: value (kamida 12 belgi, bo'sh joysiz)
const ASSIGN_RE = /(?:^|[\s,{(])["']?([A-Za-z0-9_.-]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|APIKEY|PRIVATE[-_]?KEY|ACCESS[-_]?KEY|CREDENTIALS?)[A-Za-z0-9_-]{0,32})["']?\s*[=:]\s*(?:"([^"\s]{12,256})"|'([^'\s]{12,256})'|([^\s"',;]{12,256}))/i;
const PLACEHOLDER_RE = /(\$\{|\$\(|<[^>]*>|%[A-Za-z_]+%|\{\{|process\.env|os\.environ|getenv|your[-_ ]|changeme|example|placeholder|xxxx|\*{4,}|dummy|redacted|todo|secret_key_here|\.{3})/i;

/** Qiymat haqiqiy sirga o'xshaydimi (o'zgaruvchi/namuna/o'rin egasi emas, kamida 2 xil belgi sinfi). */
function looksReal(v: string): boolean {
  if (PLACEHOLDER_RE.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  return classes >= 2 && new Set(v).size >= 6;
}

export interface SecretHit {
  line: number;
  rule: string;
  severity: ScanSeverity;
  title: string;
}

/** Bitta matnni skanerlaydi: har (qator, qoida) uchun bitta topilma; qiymat qaytarilmaydi. `maxHits` dan keyin to'xtaydi. */
export function scanTextForSecrets(text: string, maxHits = 50): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
    const line = (lines[i] ?? '').slice(0, 2000);
    if (line.length < 8) continue;
    let matched = false;
    for (const r of SECRET_RULES) {
      if (r.re.test(line)) {
        hits.push({ line: i + 1, rule: r.name, severity: r.severity, title: r.title });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const a = ASSIGN_RE.exec(line);
    if (a && NAME_RE.test(a[1] ?? '')) {
      const v = a[2] ?? a[3] ?? a[4] ?? '';
      if (looksReal(v)) {
        hits.push({ line: i + 1, rule: 'secret-assignment', severity: 'moderate', title: 'Hard-coded secret-like value assigned' });
        continue;
      }
    }
    if (redactShapes(line) !== line) hits.push({ line: i + 1, rule: 'secret-shape', severity: 'moderate', title: 'Secret-like token shape committed' });
  }
  return hits;
}

// --- .env-ga o'xshash fayllar --------------------------------------------------------------------

const ENV_SAFE_SUFFIX = /\.(?:example|sample|template|dist|defaults?|schema)$/i;
const base = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;

/** Commit qilinmasligi kerak bo'lgan fayl turi: `env` (.env*) yoki `key` (kalit/sertifikat); aks holda `null`. */
export function envLikeKind(path: string): 'env' | 'key' | null {
  const b = base(path);
  if (/^\.env(?:\..+)?$/i.test(b)) return ENV_SAFE_SUFFIX.test(b) ? null : 'env';
  if (/\.(?:pem|p12|pfx|keystore|jks)$/i.test(b) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(b)) return /\.pub$/i.test(b) ? null : 'key';
  return null;
}

export function envFileFinding(path: string): ScanFinding | null {
  const kind = envLikeKind(path);
  if (!kind) return null;
  return {
    kind: 'env_file',
    tool: 'env-files',
    severity: kind === 'key' ? 'high' : 'moderate',
    package: null,
    version: null,
    fixVersion: null,
    advisoryIds: [],
    title: kind === 'key' ? 'Key/certificate file is tracked by git' : 'Environment file is tracked by git',
    file: path.slice(0, SCAN_LIMITS.pathMaxChars),
    line: null,
    rule: kind === 'key' ? 'key-file' : 'env-file',
    direct: null,
  };
}

export function secretFinding(path: string, h: SecretHit): ScanFinding {
  return { kind: 'secret', tool: 'secret-scan', severity: h.severity, package: null, version: null, fixVersion: null, advisoryIds: [], title: h.title, file: path.slice(0, SCAN_LIMITS.pathMaxChars), line: h.line, rule: h.rule, direct: null };
}

const SKIP_NAME = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pubspec\.lock|go\.sum|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock)$/;
const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|otf|eot|mp[34]|mov|class|so|dylib|exe|dll|bin|wasm|min\.js|map|svg|lock)$/i;
export const shouldSkipFile = (path: string): boolean => SKIP_NAME.test(path) || SKIP_EXT.test(path);

/** Bayt namunasida NUL bo'lsa binar. */
export const looksBinary = (buf: Uint8Array): boolean => buf.subarray(0, 4096).includes(0);
