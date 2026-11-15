import { SCAN_LIMITS, normalizeSeverity } from '@commander/contracts';
import type { ScanFinding, ScanSeverity, ScanTool } from '@commander/contracts';
import { redact } from './redact.js';

/**
 * 6.10: xavfsizlik/dependency asboblari chiqishini normallashtiruvchi SOF parserlar (fayl tizimi/jarayon yo'q).
 * Har matn `redact()` dan o'tadi va cheklanadi; noto'g'ri shakldagi kirish tashlanadi (hech qachon exception emas).
 */

const CTRL = /[\u0000-\u001f\u007f]/g;
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? redact(v).replace(CTRL, ' ').trim().slice(0, max) : '');
const orNull = (v: unknown, max: number): string | null => {
  const s = clean(v, max);
  return s === '' ? null : s;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const ADVISORY_RE = /(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|CVE-\d{4}-\d{4,7}|PYSEC-\d{4}-\d{1,6}|GO-\d{4}-\d{4,6}|OSV-\d{4}-\d{1,6})/gi;

/** Matn ichidan advisory identifikatorlarini ajratadi (takrorsiz, tartib saqlanadi). */
export function extractAdvisoryIds(...sources: unknown[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    if (typeof s !== 'string') continue;
    for (const m of s.matchAll(ADVISORY_RE)) {
      const id = m[1]!.toUpperCase().replace(/^GHSA-(.*)$/, (_a, rest: string) => `GHSA-${rest.toLowerCase()}`);
      if (!out.includes(id)) out.push(id);
      if (out.length >= SCAN_LIMITS.maxAdvisoryIds) return out;
    }
  }
  return out;
}

interface FindingInit {
  kind: ScanFinding['kind'];
  tool: ScanTool;
  severity: ScanSeverity;
  package?: unknown;
  version?: unknown;
  fixVersion?: unknown;
  advisoryIds?: string[];
  title: unknown;
  direct?: boolean | null;
}

function vuln(i: FindingInit): ScanFinding {
  return {
    kind: i.kind,
    tool: i.tool,
    severity: i.severity,
    package: orNull(i.package, SCAN_LIMITS.packageMaxChars),
    version: orNull(i.version, SCAN_LIMITS.versionMaxChars),
    fixVersion: orNull(i.fixVersion, SCAN_LIMITS.versionMaxChars),
    advisoryIds: (i.advisoryIds ?? []).slice(0, SCAN_LIMITS.maxAdvisoryIds),
    title: clean(i.title, SCAN_LIMITS.titleMaxChars) || (i.kind === 'outdated' ? 'Outdated dependency' : 'Vulnerable dependency'),
    file: null,
    line: null,
    rule: null,
    direct: i.direct ?? null,
  };
}

/** JSON'ni xavfsiz parse qiladi (bo'sh/yaroqsiz = `undefined`). */
export function safeJson(text: string): unknown {
  const t = text.trim();
  if (t === '') return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

/** Qatorma-qator JSON (ndjson); yaroqsiz qatorlar tashlanadi. */
export function parseNdjson(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const v = safeJson(line);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** Ketma-ket yopishtirilgan JSON obyektlari (`go list -json`, `govulncheck -json`): qavs chuqurligi bo'yicha ajratadi. */
export function parseConcatenatedJson(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const v = safeJson(text.slice(start, i + 1));
        if (v !== undefined) out.push(v);
        start = -1;
      }
    }
  }
  return out;
}

// --- npm / pnpm / yarn ---------------------------------------------------------------------------

/** `npm audit --json` (v7+): `vulnerabilities` xaritasi. `version` = ta'sirlangan oraliq (o'rnatilgan versiya chiqishda yo'q). */
export function parseNpmAudit(text: string, tool: ScanTool = 'npm-audit'): ScanFinding[] {
  const j = safeJson(text);
  if (!isObj(j) || !isObj(j['vulnerabilities'])) return [];
  const out: ScanFinding[] = [];
  for (const [name, raw] of Object.entries(j['vulnerabilities'])) {
    if (!isObj(raw)) continue;
    const via = arr(raw['via']);
    const objs = via.filter(isObj);
    const first = objs[0];
    const fa = raw['fixAvailable'];
    const fixVersion = isObj(fa) ? fa['version'] : undefined;
    const ids = extractAdvisoryIds(...objs.flatMap((v) => [v['url'], v['title']]));
    const title = first ? first['title'] : `Vulnerable via ${via.filter((v): v is string => typeof v === 'string').slice(0, 3).join(', ')}`;
    out.push(vuln({ kind: 'vulnerability', tool, severity: normalizeSeverity(raw['severity']), package: raw['name'] ?? name, version: raw['range'], fixVersion, advisoryIds: ids, title, direct: typeof raw['isDirect'] === 'boolean' ? raw['isDirect'] : null }));
  }
  return out;
}

/** pnpm / klassik yarn bilan bir xil `advisories` xaritasi (npm audit v6 formati). */
export function parseAdvisoriesMap(text: string, tool: ScanTool): ScanFinding[] {
  const j = safeJson(text);
  if (!isObj(j) || !isObj(j['advisories'])) return [];
  const out: ScanFinding[] = [];
  for (const raw of Object.values(j['advisories'])) {
    if (isObj(raw)) out.push(fromAdvisory(raw, tool));
  }
  return out;
}

function fromAdvisory(a: Record<string, unknown>, tool: ScanTool): ScanFinding {
  const findings = arr(a['findings']).filter(isObj);
  const patched = typeof a['patched_versions'] === 'string' && a['patched_versions'] !== '<0.0.0' ? a['patched_versions'].replace(/^>=\s*/, '') : undefined;
  return vuln({
    kind: 'vulnerability',
    tool,
    severity: normalizeSeverity(a['severity']),
    package: a['module_name'],
    version: findings[0]?.['version'] ?? a['vulnerable_versions'],
    fixVersion: patched,
    advisoryIds: extractAdvisoryIds(a['github_advisory_id'], ...arr(a['cves']).filter((c): c is string => typeof c === 'string'), a['url']),
    title: a['title'],
  });
}

/** `yarn audit --json` (klassik, ndjson `auditAdvisory`) va yarn berry `yarn npm audit --json` (ndjson `value`/`children`). */
export function parseYarnAudit(text: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  const whole = safeJson(text);
  const lines = isObj(whole) && isObj(whole['advisories']) ? [] : parseNdjson(text);
  if (isObj(whole) && isObj(whole['advisories'])) return parseAdvisoriesMap(text, 'yarn-audit');
  for (const l of lines) {
    if (!isObj(l)) continue;
    if (l['type'] === 'auditAdvisory' && isObj(l['data']) && isObj(l['data']['advisory'])) {
      out.push(fromAdvisory(l['data']['advisory'], 'yarn-audit'));
    } else if (typeof l['value'] === 'string' && isObj(l['children'])) {
      const c = l['children'];
      const tree = arr(c['Tree Versions']);
      out.push(
        vuln({
          kind: 'vulnerability',
          tool: 'yarn-audit',
          severity: normalizeSeverity(c['Severity']),
          package: l['value'],
          version: typeof tree[0] === 'string' ? tree[0] : c['Vulnerable Versions'],
          fixVersion: undefined,
          advisoryIds: extractAdvisoryIds(c['ID'], c['URL'], c['Issue']),
          title: c['Issue'],
          direct: null,
        }),
      );
    }
  }
  return out;
}

// --- pip-audit -----------------------------------------------------------------------------------

/** `pip-audit -f json`: `{dependencies:[{name,version,vulns:[{id,fix_versions,aliases,description}]}]}` (eski: massiv). pip-audit jiddiylik bermaydi: `moderate`. */
export function parsePipAudit(text: string): ScanFinding[] {
  const j = safeJson(text);
  const deps = Array.isArray(j) ? j : isObj(j) ? arr(j['dependencies']) : [];
  const out: ScanFinding[] = [];
  for (const d of deps) {
    if (!isObj(d)) continue;
    for (const v of arr(d['vulns']).filter(isObj)) {
      const fixes = arr(v['fix_versions']).filter((x): x is string => typeof x === 'string');
      out.push(
        vuln({
          kind: 'vulnerability',
          tool: 'pip-audit',
          severity: 'moderate',
          package: d['name'],
          version: d['version'],
          fixVersion: fixes[0],
          advisoryIds: extractAdvisoryIds(v['id'], ...arr(v['aliases']).filter((x): x is string => typeof x === 'string')),
          title: v['description'] ?? v['id'],
        }),
      );
    }
  }
  return out;
}

// --- dart / flutter ------------------------------------------------------------------------------

const verOf = (v: unknown): string | null => (isObj(v) && typeof v['version'] === 'string' ? v['version'] : null);

/** `dart|flutter pub outdated --json`: o'rnatilgan != eng so'nggi bo'lsa eskirgan (`info`); to'xtatilgan paket `moderate`. */
export function parsePubOutdated(text: string, tool: 'dart-outdated' | 'flutter-outdated'): ScanFinding[] {
  const j = safeJson(text);
  if (!isObj(j)) return [];
  const out: ScanFinding[] = [];
  for (const p of arr(j['packages']).filter(isObj)) {
    const current = verOf(p['current']);
    const latest = verOf(p['latest']);
    const discontinued = p['isDiscontinued'] === true;
    if (!discontinued && (!current || !latest || current === latest)) continue;
    out.push(
      vuln({
        kind: 'outdated',
        tool,
        severity: discontinued ? 'moderate' : 'info',
        package: p['package'],
        version: current,
        fixVersion: latest ?? verOf(p['upgradable']),
        title: discontinued ? 'Discontinued package' : 'Outdated dependency',
        direct: p['kind'] === 'direct' ? true : p['kind'] === 'transitive' ? false : null,
      }),
    );
  }
  return out;
}

// --- go ------------------------------------------------------------------------------------------

/** `go list -m -u -json all`: `Update` bor modul eskirgan (`info`). */
export function parseGoListUpdates(text: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const m of parseConcatenatedJson(text)) {
    if (!isObj(m) || m['Main'] === true || !isObj(m['Update'])) continue;
    out.push(vuln({ kind: 'outdated', tool: 'go-list-u', severity: 'info', package: m['Path'], version: m['Version'], fixVersion: m['Update']['Version'], title: 'Outdated module', direct: typeof m['Indirect'] === 'boolean' ? !m['Indirect'] : null }));
  }
  return out;
}

/** `govulncheck -json`: `osv` xabarlari (sarlavha) + `finding` (trace'da funksiya bor = chaqiriladi: `high`, aks holda `low`). */
export function parseGovulncheck(text: string): ScanFinding[] {
  const osvs = new Map<string, { summary: string; aliases: string[] }>();
  const findings: Record<string, unknown>[] = [];
  for (const m of parseConcatenatedJson(text)) {
    if (!isObj(m)) continue;
    if (isObj(m['osv']) && typeof m['osv']['id'] === 'string') {
      osvs.set(m['osv']['id'], { summary: typeof m['osv']['summary'] === 'string' ? m['osv']['summary'] : '', aliases: arr(m['osv']['aliases']).filter((x): x is string => typeof x === 'string') });
    } else if (isObj(m['finding'])) findings.push(m['finding']);
  }
  const best = new Map<string, ScanFinding>();
  for (const f of findings) {
    const id = typeof f['osv'] === 'string' ? f['osv'] : '';
    if (!id) continue;
    const trace = arr(f['trace']).filter(isObj);
    const called = trace.some((t) => typeof t['function'] === 'string');
    const first = trace[0];
    const meta = osvs.get(id);
    const next = vuln({
      kind: 'vulnerability',
      tool: 'govulncheck',
      severity: called ? 'high' : 'low',
      package: first?.['module'],
      version: first?.['version'],
      fixVersion: f['fixed_version'],
      advisoryIds: extractAdvisoryIds(id, ...(meta?.aliases ?? [])),
      title: meta?.summary || id,
    });
    const prev = best.get(id);
    if (!prev || (prev.severity === 'low' && called)) best.set(id, next);
  }
  return [...best.values()];
}
