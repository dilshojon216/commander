import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { PROJECT_OPS_LIMITS, SUMMARIZE_SYSTEM_PROMPT, buildSummarizePrompt, parseSummarizeOutput } from '@commander/contracts';
import type { AppendTasksPayload, ReadMdPayload, SummarizePayload } from '@commander/contracts';
import { runClaude } from './claude-exec.js';
import { errMsg, type Logger } from './logger.js';
import { hashTasksFile, readMdFile } from './project-files.js';
import type { RunnerOutcome } from './runner.js';
import { appendTasksToMd } from './tasks-md-edit.js';

export interface ProjectOpsDeps {
  /** Yangi snapshot yuboradi (`force`: xesh o'zgarmagan bo'lsa ham). `true` = outbox'ga qo'yildi. */
  snapshot: (root: string) => Promise<boolean>;
  claudeBin: string;
  /** `claude -p` ishlaydigan bo'sh papka (`~/.commander/summarize`): loyiha kodiga/CLAUDE.md'ga tegmaydi. */
  summarizeDir: string;
  log: Logger;
  /** Testlar uchun: `claude` ijrochisi. */
  exec?: (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;
  summarizeTimeoutMs?: number;
}

const fail = (code: NonNullable<RunnerOutcome['code']>, message: string): RunnerOutcome => ({ ok: false, code, message });

const insideRoot = (realRoot: string, p: string): boolean => {
  const rel = relative(realRoot, p);
  return rel !== '' && !rel.startsWith('..') && !rel.split(sep).includes('..') && !/^[A-Za-z]:/.test(rel);
};

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * Loyiha ish maydoni buyruqlari (2.15): `refresh`, `read_md`, `append_tasks`, `summarize`. Siyosat (yoqilgan, ruxsat, ildiz)
 * `CommandManager`da ALLAQACHON tekshirilgan; bu yerda faqat bajarish va qo'shimcha fayl xavfsizligi.
 */
export class ProjectOps {
  constructor(private readonly d: ProjectOpsDeps) {}

  async refresh(root: string): Promise<RunnerOutcome> {
    try {
      const sent = await this.d.snapshot(root);
      return { ok: true, result: { detail: sent ? 'snapshot queued' : 'unchanged' } };
    } catch (err) {
      this.d.log.warn('project.refresh xatosi', { error: errMsg(err) });
      return fail('internal', 'snapshot failed');
    }
  }

  readMd(p: ReadMdPayload): RunnerOutcome {
    const r = readMdFile(p.root, p.path);
    if (r === 'path_invalid') return fail('path_invalid', 'The path is not a regular md file inside the project root');
    if (r === 'file_not_found') return fail('file_not_found', 'The file does not exist or cannot be read');
    return { ok: true, result: { md: r } };
  }

  /**
   * FAQAT loyihaning TASKS.md'ini tahrirlaydi. Optimistik konkurentlik: xom bayt xeshi `baseHash` ga teng bo'lishi shart
   * (aks holda `tasks_md_changed`). Atomik yozuv: shu papkada vaqtinchalik fayl + rename. So'ng yangi snapshot.
   */
  async appendTasks(p: AppendTasksPayload): Promise<RunnerOutcome> {
    let realRoot: string;
    try {
      realRoot = realpathSync(p.root);
    } catch {
      return fail('project_not_found', 'The project root does not exist');
    }
    const full = join(realRoot, p.tasksPath);
    let mode = 0o644;
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink() || !st.isFile()) return fail('path_invalid', 'TASKS.md must be a regular file (symlinks are refused)');
      if (st.size > PROJECT_OPS_LIMITS.maxTasksFileBytes) return fail('file_too_large', 'TASKS.md is too large to edit');
      mode = st.mode & 0o777;
      if (!insideRoot(realRoot, realpathSync(full))) return fail('path_invalid', 'TASKS.md resolves outside the project root');
      const parent = dirname(full);
      if (parent !== realRoot && lstatSync(parent).isSymbolicLink()) return fail('path_invalid', 'The TASKS.md folder must not be a symlink');
    } catch {
      return fail('tasks_md_missing', 'TASKS.md does not exist in this project');
    }

    const buf = readFileSync(full);
    if (sha256(buf) !== p.baseHash) return fail('tasks_md_changed', 'TASKS.md changed since the snapshot; refresh and try again');
    const text = buf.toString('utf8');
    if (Buffer.compare(Buffer.from(text, 'utf8'), buf) !== 0) return fail('tasks_md_invalid', 'TASKS.md is not valid UTF-8; refusing to rewrite it');

    const r = appendTasksToMd(text, p.phase, p.tasks);
    if (r.added === 0) return fail('nothing_to_add', 'All task ids already exist in TASKS.md');

    const tmp = join(dirname(full), `.${basename(full)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, r.content, { mode });
      if (process.platform !== 'win32') chmodSync(tmp, mode);
      // Yozishdan oldin yana bir bor tekshiruv (oyna juda tor): fayl shu orada o'zgarmagan bo'lsin
      if (hashTasksFile(realRoot, p.tasksPath) !== p.baseHash) {
        rmSync(tmp, { force: true });
        return fail('tasks_md_changed', 'TASKS.md changed while editing; refresh and try again');
      }
      renameSync(tmp, full);
    } catch (err) {
      rmSync(tmp, { force: true });
      this.d.log.warn('TASKS.md yozilmadi', { error: errMsg(err) });
      return fail('internal', 'could not write TASKS.md');
    }
    const newHash = sha256(Buffer.from(r.content, 'utf8'));
    try {
      await this.d.snapshot(realRoot);
    } catch (err) {
      this.d.log.warn('TASKS.md yozildi, lekin snapshot yuborilmadi', { error: errMsg(err) });
    }
    return { ok: true, result: { append: { added: r.added, skippedKeys: r.skippedKeys, createdPhase: r.createdPhase, newHash } } };
  }

  /** `claude -p --model haiku` (vositalarsiz, bo'sh papkada, hooks/sozlamalarsiz): faqat statistika asosida xulosa va baholar. */
  async summarize(p: SummarizePayload): Promise<RunnerOutcome> {
    const prompt = buildSummarizePrompt(p.input);
    const args = [
      '-p',
      '--model',
      'haiku',
      '--tools',
      '',
      '--setting-sources',
      'local',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--output-format',
      'json',
      '--system-prompt',
      SUMMARIZE_SYSTEM_PROMPT,
      '--',
      prompt,
    ];
    const timeoutMs = this.d.summarizeTimeoutMs ?? 100_000;
    let stdout: string;
    try {
      mkdirSync(this.d.summarizeDir, { recursive: true, mode: 0o700 });
      stdout = this.d.exec
        ? await this.d.exec(args, { cwd: this.d.summarizeDir, timeoutMs })
        : await runClaude(this.d.claudeBin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd: this.d.summarizeDir, env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0', OTEL_SDK_DISABLED: 'true' } });
    } catch (err) {
      const msg = errMsg(err);
      this.d.log.warn('project.summarize: claude ishlamadi', { error: msg.slice(0, 200) });
      if (/sobit literal|xavfli belgilar/.test(msg)) return fail('shim_unsupported', 'claude.cmd shim cannot run summaries (native claude.exe is required)');
      return fail('summarize_failed', 'claude -p did not complete');
    }
    const parsed = parseClaudeJson(stdout);
    if (!parsed || parsed.isError) return fail('summarize_failed', 'claude returned an error result');
    const out = parseSummarizeOutput(parsed.text, new Set(p.input.tasks.map((t) => t.key)), parsed.model ?? 'haiku');
    if (!out) return fail('summarize_failed', 'claude output was not the expected JSON');
    return { ok: true, result: { summary: out } };
  }
}

/** `claude -p --output-format json`: bitta obyekt yoki hodisalar massivi; oxirgi `result` elementi kerak. */
export function parseClaudeJson(stdout: string): { text: string; isError: boolean; model: string | null } | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items: unknown[] = Array.isArray(v) ? v : [v];
  let model: string | null = null;
  let result: { text: string; isError: boolean } | null = null;
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    if (o['type'] === 'system' && typeof o['model'] === 'string') model = o['model'];
    if (o['type'] === 'result') result = { text: typeof o['result'] === 'string' ? o['result'] : '', isError: o['is_error'] === true };
  }
  return result ? { ...result, model } : null;
}
