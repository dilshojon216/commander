import { execFile } from 'node:child_process';
import { resolveExecutable, safeExecEnv } from './trusted-bin.js';
import { GIT_OPS_LIMITS, SHA_RE } from '@commander/contracts';
import type { CiCheck, CiPr, CiRun, CiState } from '@commander/contracts';

/**
 * GitHub CLI (`gh`) bilan ishlash (task 3.5). `gh` FAQAT o'rnatilgan va shu mashinada avtorizatsiyadan o'tgan bo'lsa ishlatiladi
 * (`gh auth status`, interaktivsiz). Hamma chaqiruv argumentlar massivi bilan (shell YO'Q); promptlar o'chirilgan; `gh` chiqishi
 * (JSON) qat'iy tekshiriladi va kesiladi: uchinchi tomon matniga ishonilmaydi.
 */

export interface GhResult {
  /** Jarayon chiqish kodi (`ENOENT` bo'lsa `null`). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `gh` topilmadi (PATH'da yo'q). */
  missing: boolean;
  timedOut: boolean;
}

export interface GhRunner {
  (cwd: string, args: readonly string[], opts?: { timeoutMs?: number }): Promise<GhResult>;
}

export const GH_TIMEOUT_MS = 30_000;

export function createGhRunner(bin = 'gh'): GhRunner {
  return (cwd, args, opts) =>
    new Promise<GhResult>((resolve) => {
      // M-18: absolyut yo'l (ishonchli PATH); topilmasa "o'rnatilmagan" deb hisoblanadi (cwd'dan qidirilmaydi).
      const exe = resolveExecutable(bin, 'gh');
      if (!exe) return resolve({ code: null, stdout: '', stderr: '', missing: true, timedOut: false });
      execFile(
        exe,
        [...args],
        {
          cwd,
          timeout: opts?.timeoutMs ?? GH_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: safeExecEnv(process.env, { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', GH_SPINNER_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', CLICOLOR: '0' }),
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr, missing: false, timedOut: false });
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
          if (e.code === 'ENOENT') return resolve({ code: null, stdout: '', stderr: '', missing: true, timedOut: false });
          resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: stdout ?? '', stderr: stderr ?? '', missing: false, timedOut: e.killed === true || e.signal === 'SIGTERM' });
        },
      );
    });
}

export type GhAvailability = 'ok' | 'missing' | 'unauthenticated';

/** `gh auth status` (interaktivsiz): 0 = kirilgan; ENOENT = o'rnatilmagan; boshqasi = avtorizatsiya yo'q. */
export async function detectGh(run: GhRunner, cwd: string): Promise<GhAvailability> {
  const r = await run(cwd, ['auth', 'status'], { timeoutMs: 15_000 });
  if (r.missing) return 'missing';
  return r.code === 0 ? 'ok' : 'unauthenticated';
}

// --- chiqishni tozalash -----------------------------------------------------------------------

const CTRL_RE = /[\u0000-\u001f\u007f]/g;

export function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(CTRL_RE, ' ').trim().slice(0, max) : '';
}

/** Faqat `https://` havola (kesilgan); aks holda `null`. */
export function safeLink(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length > 500 || !/^https:\/\/[^\s<>"']+$/.test(s)) return null;
  return s;
}

function parseJsonArray(stdout: string): unknown[] | null {
  const t = stdout.trim();
  if (!t.startsWith('[')) return null;
  try {
    const v: unknown = JSON.parse(t);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const asRec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// --- PR URL -----------------------------------------------------------------------------------

const PR_URL_RE = /https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)/;

/** `gh pr create` stdout/stderr'idan PR URL va raqami. */
export function parsePrUrl(text: string): { url: string; number: number } | null {
  const m = PR_URL_RE.exec(text);
  if (!m) return null;
  const number = Number(m[1]);
  return Number.isSafeInteger(number) && number > 0 ? { url: m[0], number } : null;
}

/** `gh pr create` "allaqachon bor" xatosi (stderr'da URL bilan). */
export function isPrExistsError(stderr: string): boolean {
  return /already exists/i.test(stderr) && PR_URL_RE.test(stderr);
}

// --- gh pr list / checks / run list -----------------------------------------------------------

const PR_STATES: Record<string, CiPr['state']> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

/** `gh pr list --json number,url,state,title,isDraft` (eng yangi birinchi). */
export function parseGhPrList(stdout: string): CiPr | null {
  const arr = parseJsonArray(stdout);
  if (!arr) return null;
  for (const it of arr) {
    const o = asRec(it);
    if (!o) continue;
    const number = typeof o['number'] === 'number' && Number.isSafeInteger(o['number']) && o['number'] > 0 ? o['number'] : null;
    const url = safeLink(o['url']);
    const state = PR_STATES[String(o['state']).toUpperCase()];
    if (number === null || !url || !state) continue;
    return { number, url, state, title: cleanText(o['title'], GIT_OPS_LIMITS.titleMaxChars), draft: o['isDraft'] === true };
  }
  return null;
}

const BUCKETS = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);

/** `gh pr checks --json name,bucket,link` (chiqish kodi 1/8 bo'lsa ham stdout JSON). */
export function parseGhChecks(stdout: string): CiCheck[] {
  const arr = parseJsonArray(stdout);
  if (!arr) return [];
  const out: CiCheck[] = [];
  for (const it of arr) {
    const o = asRec(it);
    if (!o) continue;
    const bucket = typeof o['bucket'] === 'string' ? o['bucket'].toLowerCase() : '';
    const name = cleanText(o['name'], GIT_OPS_LIMITS.checkNameMaxChars);
    if (!name || !BUCKETS.has(bucket)) continue;
    out.push({ name, bucket: bucket as CiCheck['bucket'], link: safeLink(o['link']) });
    if (out.length >= GIT_OPS_LIMITS.maxChecks) break;
  }
  return out;
}

/** `gh run list --json databaseId,name,status,conclusion,headSha,url` -> eng yangi run. */
export function parseGhRuns(stdout: string): CiRun | null {
  const arr = parseJsonArray(stdout);
  if (!arr) return null;
  for (const it of arr) {
    const o = asRec(it);
    if (!o) continue;
    const idRaw = o['databaseId'];
    const id = typeof idRaw === 'number' && Number.isSafeInteger(idRaw) ? String(idRaw) : typeof idRaw === 'string' && /^\d{1,20}$/.test(idRaw) ? idRaw : null;
    if (!id) continue;
    const sha = typeof o['headSha'] === 'string' && SHA_RE.test(o['headSha']) ? o['headSha'] : null;
    const conclusion = cleanText(o['conclusion'], 32).toLowerCase();
    return {
      id,
      name: cleanText(o['name'] ?? o['workflowName'], GIT_OPS_LIMITS.checkNameMaxChars),
      status: cleanText(o['status'], 32).toLowerCase() || 'unknown',
      conclusion: conclusion || null,
      url: safeLink(o['url']),
      headSha: sha,
    };
  }
  return null;
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/** Umumiy CI holati: tekshiruvlar bor bo'lsa shulardan (fail > pending > success), aks holda oxirgi run'dan. Sof. */
export function deriveCiState(checks: readonly CiCheck[], run: CiRun | null): CiState {
  if (checks.length > 0) {
    if (checks.some((c) => c.bucket === 'fail')) return 'failure';
    if (checks.some((c) => c.bucket === 'pending')) return 'pending';
    if (checks.some((c) => c.bucket === 'pass')) return 'success';
    return 'unknown';
  }
  if (!run) return 'none';
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion === 'success') return 'success';
  if (run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion)) return 'failure';
  return 'unknown';
}
