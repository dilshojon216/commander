import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CONFIG_LIMITS, ConfigChunkBuffer, ConfigModeSchema, Sha256Schema, SettingsFragmentSchema, checkConfigPath, configPathKey } from '@commander/contracts';
import type {
  CommandErrorCode,
  ConfigApplyPayload,
  ConfigBackupInfo,
  ConfigBundleRef,
  ConfigCapturePayload,
  ConfigChunkPayload,
  ConfigItem,
  ConfigPlanEntry,
  ConfigPlanResult,
  ConfigResult,
  ConfigRollbackPayload,
  ConfigSettingsPlan,
  ConfigSkipped,
  ConfigStateReport,
  SettingsFragment,
} from '@commander/contracts';
import { decodeBundle, encodeBundle } from './config-bundle.js';
import type { BundleContent } from './config-bundle.js';
import { unifiedDiff } from './config-diff.js';
import { deleteManaged, listCandidates, readLocal, sha256Hex, writeFileAtomic, writeManagedAtomic } from './config-fs.js';
import { computePlanHash, planFiles } from './config-plan.js';
import type { ManifestFiles, PlannedEntry } from './config-plan.js';
import { extractSettingsFragment, planSettings, settingsIntact, settingsSha256 } from './config-settings.js';
import type { ManagedSettings } from './config-settings.js';
import { errMsg, type Logger } from './logger.js';
import { redact } from './redact.js';
import type { RunnerOutcome } from './runner.js';

/**
 * Sozlamalarni markazdan tarqatish (3.7), agentd tomoni: `config.capture`, `config.apply` (dry-run + haqiqiy), `config.rollback`
 * va heartbeat drift hisoboti. Siyosat (`allowConfigRead|Write`, root, lockdown) `CommandManager`da ALLAQACHON tekshirilgan.
 *
 * Xavfsizlik: faqat `checkConfigPath` ruxsat ro'yxatidagi yo'llar; symlink orqali o'qilmaydi/yozilmaydi; sirli fayl rad etiladi;
 * yozuv atomik va OLDIN zaxira (`~/.commander/backups/config-<ts>/`); mirror faqat Commander joylashtirgan (manifest `owned`)
 * va lokal o'zgartirilmagan fayllarni o'chiradi; `settings.json` da faqat `permissions.allow|deny` va `env` (Commander hook'lariga tegilmaydi).
 */

const fail = (code: CommandErrorCode, message: string): RunnerOutcome => ({ ok: false, code, message });
const isSecret = (t: string): boolean => redact(t) !== t;
const KEEP_BACKUPS = 20;
const FILE_READ_CAP = CONFIG_LIMITS.fileMaxBytes + 1;

const ManagedSettingsSchema = z.object({
  fragment: SettingsFragmentSchema,
  ownedAllow: z.array(z.string()),
  ownedDeny: z.array(z.string()),
  ownedEnv: z.array(z.string()),
  envDeployed: z.record(z.string(), z.string()),
  sha256: Sha256Schema,
});
const ManifestSchema = z.object({
  v: z.literal(1),
  profileName: z.string().min(1).max(64),
  profileVersion: z.number().int().min(1),
  mode: ConfigModeSchema,
  appliedAt: z.number().int().min(0),
  files: z.record(z.string(), z.object({ sha256: Sha256Schema, exec: z.boolean(), owned: z.boolean() })),
  settings: ManagedSettingsSchema.nullable(),
});
type Manifest = z.infer<typeof ManifestSchema>;

const BackupSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  createdAt: z.number().int(),
  profileName: z.string(),
  profileVersion: z.number().int(),
  entries: z.array(z.object({ path: z.string(), existed: z.boolean(), copy: z.string().nullable(), appliedSha256: Sha256Schema.nullable() })),
  settings: z.object({ existed: z.boolean(), copy: z.string().nullable(), appliedSha256: Sha256Schema }).nullable(),
  manifest: z.object({ existed: z.boolean(), copy: z.string().nullable() }),
  rolledBack: z.boolean().optional(),
});
type Backup = z.infer<typeof BackupSchema>;

export interface ConfigSyncDeps {
  /** Claude konfiguratsiya papkasi (`~/.claude` yoki `CLAUDE_CONFIG_DIR`). */
  claudeDir: string;
  /** `~/.commander` (manifest va zaxiralar shu yerda). */
  home: string;
  log: Logger;
  now?: () => number;
  /** `config.chunk` yuborish; `false` = hozir yuborib bo'lmadi (backpressure/uzilish). */
  sendChunk: (c: ConfigChunkPayload) => boolean;
  /** Markaz bo'laklarini kutish (ms). */
  chunkWaitMs?: number;
  /** Heartbeat hisoboti oralig'i (ms). */
  reportIntervalMs?: number;
}

interface SettingsLocal {
  exists: boolean;
  parsed?: unknown;
  invalid?: boolean;
  symlink?: boolean;
  raw?: Buffer;
}

export class ConfigSync {
  private readonly now: () => number;
  private readonly chunks = new ConfigChunkBuffer();
  private chain: Promise<unknown> = Promise.resolve();
  private lastReportAt = 0;
  private dirty = true;

  constructor(private readonly d: ConfigSyncDeps) {
    this.now = d.now ?? Date.now;
  }

  private get manifestFile(): string {
    return join(this.d.home, 'config-manifest.json');
  }
  private get backupsDir(): string {
    return join(this.d.home, 'backups');
  }
  private get settingsFile(): string {
    return join(this.d.claudeDir, 'settings.json');
  }

  // --- kirish: markaz bo'laklari ---------------------------------------------------------------

  onChunk(c: ConfigChunkPayload): void {
    if (!this.chunks.add(c, this.now())) this.d.log.warn('config.chunk rad etildi (hajm/nomuvofiqlik)', { seq: c.seq, total: c.total });
  }

  private async awaitParts(ref: { sha256: string; chunks: number }): Promise<string[] | undefined> {
    const deadline = this.now() + (this.d.chunkWaitMs ?? 20_000);
    for (;;) {
      const parts = this.chunks.get(ref.sha256, ref.chunks);
      if (parts) return parts;
      if (this.now() >= deadline) return undefined;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // --- navbat (bir vaqtda bitta o'zgartirish) ----------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // --- capture -----------------------------------------------------------------------------------

  capture(p: ConfigCapturePayload): Promise<RunnerOutcome> {
    return this.serial(() => this.doCapture(p));
  }

  private async doCapture(p: ConfigCapturePayload): Promise<RunnerOutcome> {
    try {
      const { items: cands, skipped: walkSkipped } = listCandidates(this.d.claudeDir);
      const skipped: ConfigSkipped[] = [...walkSkipped];
      const items: ConfigItem[] = [];
      const files: Array<{ path: string; content: string }> = [];
      let total = 0;
      for (const c of cands) {
        if (items.length >= CONFIG_LIMITS.maxFiles) {
          skipped.push({ path: c.rel, reason: 'too many files' });
          continue;
        }
        const chk = checkConfigPath(c.rel);
        if (!chk.ok) continue;
        if (c.size > CONFIG_LIMITS.fileMaxBytes) {
          skipped.push({ path: c.rel, reason: 'file too large (> 256 KB)' });
          continue;
        }
        const st = readLocal(this.d.claudeDir, c.rel, FILE_READ_CAP);
        if (st.state !== 'file') {
          skipped.push({ path: c.rel, reason: st.state === 'unsafe' ? st.reason : 'disappeared' });
          continue;
        }
        const text = decodeUtf8(st.content);
        if (text === null) {
          skipped.push({ path: c.rel, reason: 'binary or non-UTF-8 file' });
          continue;
        }
        if (isSecret(text)) {
          skipped.push({ path: c.rel, reason: 'contains a secret: refused' });
          continue;
        }
        if (total + st.size > CONFIG_LIMITS.profileMaxBytes) {
          skipped.push({ path: c.rel, reason: 'profile size limit (5 MB) reached' });
          continue;
        }
        total += st.size;
        items.push({ path: c.rel, kind: chk.kind, sha256: st.sha256, size: st.size, exec: c.exec });
        files.push({ path: c.rel, content: text });
      }

      let fragment: SettingsFragment | null = null;
      if (p.includeSettings) {
        const s = this.readSettingsLocal();
        if (s.symlink) skipped.push({ path: 'settings.json', reason: 'symlink (not followed)' });
        else if (s.invalid) skipped.push({ path: 'settings.json', reason: 'not valid JSON' });
        else if (s.exists) {
          const ex = extractSettingsFragment(s.parsed, isSecret);
          fragment = ex.fragment;
          for (const sk of ex.skipped) skipped.push({ path: 'settings.json', reason: sk });
        }
      }

      const hasContent = files.length > 0 || fragment !== null;
      let bundleRef: ConfigBundleRef | null = null;
      if (hasContent) {
        const enc = encodeBundle({ files, settings: fragment });
        for (const c of enc.chunks) await this.sendChunkWithBackoff(c);
        bundleRef = enc.ref;
      }
      const result: ConfigResult = {
        kind: 'capture',
        items,
        skipped: skipped.slice(0, CONFIG_LIMITS.maxSkipped),
        settingsSha256: fragment ? settingsSha256(fragment) : null,
        bundle: bundleRef,
        totalBytes: total,
      };
      return { ok: true, result: { detail: `${items.length} files, ${skipped.length} skipped`, config: result } };
    } catch (err) {
      this.d.log.warn('config.capture xatosi', { error: errMsg(err) });
      return fail('internal', 'capture failed');
    }
  }

  private async sendChunkWithBackoff(c: ConfigChunkPayload): Promise<void> {
    const deadline = this.now() + 20_000;
    while (!this.d.sendChunk(c)) {
      if (this.now() >= deadline) throw new Error('could not send config.chunk (connection busy or closed)');
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // --- apply (dry-run va haqiqiy) ------------------------------------------------------------------

  apply(p: ConfigApplyPayload): Promise<RunnerOutcome> {
    return this.serial(() => this.doApply(p));
  }

  private async doApply(p: ConfigApplyPayload): Promise<RunnerOutcome> {
    try {
      const prepared = await this.prepareBundle(p);
      if (!prepared.ok) return prepared.outcome;
      const { contents, bundle } = prepared;

      const manifest = this.loadManifest();
      const planned = planFiles(
        p.items.map((i) => ({ path: i.path, kind: i.kind, sha256: i.sha256, exec: i.exec })),
        (rel) => readLocal(this.d.claudeDir, rel, FILE_READ_CAP),
        manifest?.files ?? {},
        p.mode,
      );

      const sLocal = this.readSettingsLocal();
      const fragment: SettingsFragment | null = bundle.settings ?? (p.mode === 'mirror' && manifest?.settings ? { permissions: { allow: [], deny: [] }, env: {} } : null);
      const sPlan = fragment
        ? planSettings({
            fragment,
            local: sLocal.parsed,
            localInvalid: sLocal.invalid === true || sLocal.symlink === true,
            prev: manifest?.settings ?? null,
            mode: p.mode,
            looksSecret: isSecret,
          })
        : null;

      const planHash = computePlanHash(p.mode, planned, sPlan?.plan ?? null);
      const result = this.buildPlanResult(p, planned, contents, sPlan?.plan ?? null, planHash);

      if (p.dryRun) return { ok: true, result: { detail: summaryText(result), config: result } };

      if (!p.expectedPlanHash) return fail('invalid_payload', 'expectedPlanHash is required for a real apply');
      if (p.expectedPlanHash !== planHash) return fail('config_plan_changed', 'The local files changed since the diff was computed; run the diff again');

      return this.execute(p, planned, contents, sPlan, manifest, sLocal);
    } catch (err) {
      this.d.log.error('config.apply xatosi', { error: errMsg(err) });
      return fail('internal', 'apply failed');
    }
  }

  private async prepareBundle(p: ConfigApplyPayload): Promise<{ ok: true; contents: Map<string, Buffer>; bundle: BundleContent } | { ok: false; outcome: RunnerOutcome }> {
    const bad = (code: CommandErrorCode, msg: string): { ok: false; outcome: RunnerOutcome } => ({ ok: false, outcome: fail(code, msg) });
    let bundle: BundleContent = { files: [], settings: null };
    if (p.bundle) {
      const parts = await this.awaitParts(p.bundle);
      if (!parts) return bad('config_bundle_missing', 'The profile content did not arrive in time');
      const dec = decodeBundle(parts, p.bundle);
      this.chunks.delete(p.bundle.sha256);
      if (!dec.ok) return bad('config_bundle_invalid', dec.reason);
      bundle = dec.bundle;
    } else if (p.items.length > 0 || p.settingsSha256 !== null) {
      return bad('config_bundle_missing', 'The command lists items but carries no content');
    }

    const contents = new Map<string, Buffer>();
    const seenKeys = new Set<string>();
    const byPath = new Map(bundle.files.map((f) => [f.path, f.content]));
    if (byPath.size !== bundle.files.length) return bad('config_bundle_invalid', 'duplicate paths in bundle');
    let total = 0;
    for (const it of p.items) {
      const chk = checkConfigPath(it.path);
      if (!chk.ok || chk.kind !== it.kind) return bad('config_bundle_invalid', `path not allowed: ${it.path.slice(0, 80)}`);
      const key = configPathKey(it.path);
      if (seenKeys.has(key)) return bad('config_bundle_invalid', 'paths differ only by case');
      seenKeys.add(key);
      const text = byPath.get(it.path);
      if (text === undefined) return bad('config_bundle_invalid', `content missing for ${it.path.slice(0, 80)}`);
      const buf = Buffer.from(text, 'utf8');
      if (buf.length > CONFIG_LIMITS.fileMaxBytes) return bad('config_too_large', `file too large: ${it.path.slice(0, 80)}`);
      if (buf.length !== it.size || sha256Hex(buf) !== it.sha256) return bad('config_bundle_invalid', `hash mismatch for ${it.path.slice(0, 80)}`);
      if (isSecret(text)) return bad('config_bundle_invalid', `file looks like it contains a secret: ${it.path.slice(0, 80)}`);
      total += buf.length;
      contents.set(it.path, buf);
    }
    if (byPath.size !== p.items.length) return bad('config_bundle_invalid', 'bundle has files that are not listed');
    if (total > CONFIG_LIMITS.profileMaxBytes) return bad('config_too_large', 'profile exceeds 5 MB');
    if (p.settingsSha256 === null) {
      if (bundle.settings !== null) return bad('config_bundle_invalid', 'unexpected settings fragment');
    } else if (!bundle.settings || settingsSha256(bundle.settings) !== p.settingsSha256) {
      return bad('config_bundle_invalid', 'settings fragment hash mismatch');
    }
    return { ok: true, contents, bundle };
  }

  private buildPlanResult(p: ConfigApplyPayload, planned: PlannedEntry[], contents: Map<string, Buffer>, settings: ConfigSettingsPlan | null, planHash: string): ConfigPlanResult {
    const summary = { add: 0, update: 0, delete: 0, unchanged: 0, skip: 0 };
    let budget = CONFIG_LIMITS.maxDiffBytesTotal;
    let truncated = false;
    const entries: ConfigPlanEntry[] = planned.map((e) => {
      summary[e.action]++;
      const out: ConfigPlanEntry = { path: e.path, kind: e.kind, action: e.action };
      if (e.reason) out.reason = e.reason;
      if (e.action === 'add' || e.action === 'update' || e.action === 'delete') {
        const d = this.diffFor(e, contents.get(e.path));
        if (d.reason) out.reason = d.reason;
        else if (d.text !== undefined) {
          let text = d.text;
          if (text.length > CONFIG_LIMITS.maxDiffBytesPerFile) {
            text = `${text.slice(0, CONFIG_LIMITS.maxDiffBytesPerFile)}\n… (kesildi)\n`;
            out.diffTruncated = true;
            truncated = true;
          }
          if (budget - text.length < 0) {
            out.reason = 'diff omitted (total size limit)';
            truncated = true;
          } else {
            budget -= text.length;
            out.diff = text;
          }
        }
      }
      return out;
    });
    return { kind: 'plan', planHash, mode: p.mode, entries, settings, summary, truncated };
  }

  /** Unified diff (lokal -> profil). Lokal fayl sirli bo'lsa diff YASHIRILADI (sir markazga ketmasin). */
  private diffFor(e: PlannedEntry, next: Buffer | undefined): { text?: string; reason?: string } {
    let oldText = '';
    if (e.action === 'update' || e.action === 'delete') {
      const st = readLocal(this.d.claudeDir, e.path, FILE_READ_CAP);
      if (st.state !== 'file') return { reason: 'local file unreadable' };
      const t = decodeUtf8(st.content);
      if (t === null) return { reason: 'local file is binary: diff hidden' };
      if (isSecret(t)) return { reason: 'local file contains a secret: diff hidden' };
      oldText = t;
    }
    const newText = e.action === 'delete' ? '' : (next?.toString('utf8') ?? '');
    const d = unifiedDiff(oldText, newText, e.action === 'add' ? '/dev/null' : `local/${e.path}`, e.action === 'delete' ? '/dev/null' : `profile/${e.path}`);
    if (!d) return { reason: 'diff too large' };
    return { text: d.text };
  }

  // --- haqiqiy qo'llash ------------------------------------------------------------------------------

  private execute(
    p: ConfigApplyPayload,
    planned: PlannedEntry[],
    contents: Map<string, Buffer>,
    sPlan: ReturnType<typeof planSettings> | null,
    manifest: Manifest | null,
    sLocal: SettingsLocal,
  ): RunnerOutcome {
    const changes = planned.filter((e) => e.action === 'add' || e.action === 'update' || e.action === 'delete');
    const settingsNext = sPlan?.next ?? null;
    const settingsText = settingsNext ? `${JSON.stringify(settingsNext, null, 2)}\n` : null;

    // Manifest: yangi holat (yozish eng oxirida)
    const files: ManifestFiles = { ...(manifest?.files ?? {}) };
    for (const e of planned) {
      if (e.action === 'delete') delete files[e.path];
      else if (e.action === 'add' || e.action === 'update') files[e.path] = { sha256: e.newSha!, exec: e.exec, owned: true };
      else if (e.action === 'unchanged') files[e.path] = { sha256: e.newSha!, exec: e.exec, owned: files[e.path]?.owned ?? false };
    }
    const nextManifest: Manifest = {
      v: 1,
      profileName: p.profileName,
      profileVersion: p.profileVersion,
      mode: p.mode,
      appliedAt: this.now(),
      files,
      settings: sPlan ? sPlan.managed : (manifest?.settings ?? null),
    };

    let backupId: string | null = null;
    const done: PlannedEntry[] = [];
    let backup: Backup | null = null;
    try {
      if (changes.length > 0 || settingsText !== null) {
        const made = this.createBackup(p, changes, settingsText, sLocal, manifest);
        backupId = made.backup.id;
        backup = made.backup;
      }
      for (const e of changes) {
        if (e.action === 'delete') deleteManaged(this.d.claudeDir, e.path);
        else writeManagedAtomic(this.d.claudeDir, e.path, contents.get(e.path)!, e.exec);
        done.push(e);
      }
      if (settingsText !== null) writeFileAtomic(this.settingsFile, settingsText, 0o644);
      writeFileAtomic(this.manifestFile, `${JSON.stringify(nextManifest, null, 2)}\n`, 0o600);
    } catch (err) {
      this.d.log.error('config.apply yozuvi muvaffaqiyatsiz: zaxiradan tiklanadi', { error: errMsg(err) });
      if (backup) this.restoreAfterFailure(backup, done, settingsText !== null);
      return fail('config_write_failed', 'Writing failed; the previous state was restored from the backup');
    }
    this.dirty = true;
    if (backupId) this.pruneBackups();
    const counts = { add: 0, update: 0, delete: 0 };
    for (const e of changes) counts[e.action as 'add' | 'update' | 'delete']++;
    const result: ConfigResult = { kind: 'apply', backupId, applied: counts, settingsChanged: settingsText !== null };
    return { ok: true, result: { detail: `${counts.add} add, ${counts.update} update, ${counts.delete} delete${settingsText !== null ? ', settings' : ''}${backupId ? `; backup ${backupId}` : ''}`, config: result } };
  }

  private createBackup(p: ConfigApplyPayload, changes: PlannedEntry[], settingsText: string | null, sLocal: SettingsLocal, manifest: Manifest | null): { backup: Backup } {
    mkdirSync(this.backupsDir, { recursive: true, mode: 0o700 });
    let ts = this.now();
    let id = `config-${ts}`;
    while (existsDir(join(this.backupsDir, id))) id = `config-${++ts}`;
    const dir = join(this.backupsDir, id);
    mkdirSync(join(dir, 'files'), { recursive: true, mode: 0o700 });

    const entries: Backup['entries'] = changes.map((e, i) => {
      const st = readLocal(this.d.claudeDir, e.path, Number.MAX_SAFE_INTEGER);
      let copy: string | null = null;
      if (st.state === 'file') {
        copy = `files/${i}`;
        writeFileAtomic(join(dir, copy), st.content, 0o600);
      }
      return { path: e.path, existed: st.state === 'file', copy, appliedSha256: e.action === 'delete' ? null : e.newSha! };
    });
    let settings: Backup['settings'] = null;
    if (settingsText !== null) {
      let copy: string | null = null;
      if (sLocal.exists && sLocal.raw) {
        copy = 'settings.json';
        writeFileAtomic(join(dir, copy), sLocal.raw, 0o600);
      }
      settings = { existed: sLocal.exists, copy, appliedSha256: sha256Hex(settingsText) };
    }
    let manifestCopy: string | null = null;
    if (manifest) {
      manifestCopy = 'manifest.json';
      writeFileAtomic(join(dir, manifestCopy), readFileSync(this.manifestFile), 0o600);
    }
    const backup: Backup = {
      v: 1,
      id,
      createdAt: ts,
      profileName: p.profileName,
      profileVersion: p.profileVersion,
      entries,
      settings,
      manifest: { existed: manifest !== null, copy: manifestCopy },
    };
    writeFileAtomic(join(dir, 'backup.json'), `${JSON.stringify(backup, null, 2)}\n`, 0o600);
    return { backup };
  }

  /** Yozish yarim yo'lda to'xtasa: faqat yozib bo'lingan elementlar zaxiradan tiklanadi (manifest hali yozilmagan). */
  private restoreAfterFailure(backup: Backup, done: PlannedEntry[], settingsTouched: boolean): void {
    const dir = join(this.backupsDir, backup.id);
    const donePaths = new Set(done.map((e) => e.path));
    for (const e of backup.entries) {
      if (!donePaths.has(e.path)) continue;
      try {
        this.restoreEntry(dir, e, true);
      } catch (err) {
        this.d.log.error('zaxiradan tiklashda xato', { path: e.path, error: errMsg(err) });
      }
    }
    if (settingsTouched && backup.settings) {
      try {
        this.restoreSettings(dir, backup.settings, true);
      } catch (err) {
        this.d.log.error('settings.json ni tiklashda xato', { error: errMsg(err) });
      }
    }
  }

  private restoreEntry(dir: string, e: Backup['entries'][number], force: boolean): 'restored' | { skip: string } {
    const cur = readLocal(this.d.claudeDir, e.path, Number.MAX_SAFE_INTEGER);
    if (cur.state === 'unsafe') return { skip: cur.reason };
    const curSha = cur.state === 'file' ? cur.sha256 : null;
    if (!force && curSha !== e.appliedSha256) return { skip: 'modified since apply' };
    if (e.existed && e.copy) {
      const data = readFileSync(join(dir, e.copy));
      const exec = cur.state === 'file' ? cur.exec : false;
      writeManagedAtomic(this.d.claudeDir, e.path, data, exec);
    } else if (cur.state === 'file') {
      deleteManaged(this.d.claudeDir, e.path);
    }
    return 'restored';
  }

  private restoreSettings(dir: string, s: NonNullable<Backup['settings']>, force: boolean): 'restored' | { skip: string } {
    const cur = this.readSettingsLocal();
    if (cur.symlink) return { skip: 'settings.json is a symlink' };
    const curSha = cur.raw ? sha256Hex(cur.raw) : null;
    if (!force && curSha !== s.appliedSha256) return { skip: 'settings.json modified since apply' };
    if (s.existed && s.copy) writeFileAtomic(this.settingsFile, readFileSync(join(dir, s.copy)), 0o644);
    else if (cur.exists) rmSync(this.settingsFile, { force: true });
    return 'restored';
  }

  // --- rollback ---------------------------------------------------------------------------------------

  rollback(p: ConfigRollbackPayload): Promise<RunnerOutcome> {
    return this.serial(async () => this.doRollback(p));
  }

  private doRollback(p: ConfigRollbackPayload): RunnerOutcome {
    try {
      const dir = join(this.backupsDir, p.backupId);
      let backup: Backup;
      try {
        backup = BackupSchema.parse(JSON.parse(readFileSync(join(dir, 'backup.json'), 'utf8')));
      } catch {
        return fail('config_backup_not_found', 'The backup does not exist or is unreadable');
      }
      if (backup.id !== p.backupId) return fail('config_backup_not_found', 'The backup does not exist or is unreadable');
      if (backup.rolledBack) return fail('config_backup_not_found', 'This backup was already rolled back');
      // Zaxira ichidagi yo'llar qayta tekshiriladi (qo'lda o'zgartirilgan backup.json ruxsat ro'yxatidan chiqmasin)
      for (const e of backup.entries) if (!checkConfigPath(e.path).ok) return fail('config_backup_not_found', 'The backup lists a path outside the managed set');

      const skipped: ConfigSkipped[] = [];
      let restored = 0;
      for (const e of backup.entries) {
        const r = this.restoreEntry(dir, e, false);
        if (r === 'restored') restored++;
        else skipped.push({ path: e.path, reason: r.skip });
      }
      if (backup.settings) {
        const r = this.restoreSettings(dir, backup.settings, false);
        if (r === 'restored') restored++;
        else skipped.push({ path: 'settings.json', reason: r.skip });
      }
      // Manifest oldingi holatga (yoki yo'qqa)
      if (backup.manifest.existed && backup.manifest.copy) writeFileAtomic(this.manifestFile, readFileSync(join(dir, backup.manifest.copy)), 0o600);
      else rmSync(this.manifestFile, { force: true });
      writeFileAtomic(join(dir, 'backup.json'), `${JSON.stringify({ ...backup, rolledBack: true }, null, 2)}\n`, 0o600);
      this.dirty = true;
      const result: ConfigResult = { kind: 'rollback', backupId: p.backupId, restored, skipped: skipped.slice(0, CONFIG_LIMITS.maxFiles) };
      return { ok: true, result: { detail: `${restored} restored, ${skipped.length} skipped`, config: result } };
    } catch (err) {
      this.d.log.error('config.rollback xatosi', { error: errMsg(err) });
      return fail('config_write_failed', 'Rollback failed');
    }
  }

  private pruneBackups(): void {
    try {
      const ids = readdirSync(this.backupsDir).filter((n) => /^config-\d{13}$/.test(n)).sort();
      for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_BACKUPS))) rmSync(join(this.backupsDir, id), { recursive: true, force: true });
    } catch {
      /* zaxira tozalash muhim emas */
    }
  }

  // --- drift hisoboti ----------------------------------------------------------------------------------

  markDirty(): void {
    this.dirty = true;
  }

  /** Heartbeat uchun: har `reportIntervalMs` da (yoki qo'llash/qaytarish/ulanishdan keyin) hisobot, aks holda `undefined`. */
  heartbeatReport(first: boolean): ConfigStateReport | undefined {
    const now = this.now();
    const every = this.d.reportIntervalMs ?? CONFIG_LIMITS.reportIntervalMs;
    if (!first && !this.dirty && now - this.lastReportAt < every) return undefined;
    try {
      const r = this.report();
      this.lastReportAt = now;
      this.dirty = false;
      return r;
    } catch (err) {
      this.d.log.warn('config hisoboti tuzilmadi', { error: errMsg(err) });
      return undefined;
    }
  }

  report(): ConfigStateReport {
    const manifest = this.loadManifest();
    const files: ConfigStateReport['files'] = [];
    if (manifest) {
      for (const p of Object.keys(manifest.files).sort().slice(0, CONFIG_LIMITS.maxFiles)) {
        const st = readLocal(this.d.claudeDir, p, Number.MAX_SAFE_INTEGER);
        files.push({ path: p, sha256: st.state === 'file' ? st.sha256 : null });
      }
    }
    let settings: ConfigStateReport['settings'] = null;
    if (manifest?.settings) {
      const s = this.readSettingsLocal();
      settings = { sha256: manifest.settings.sha256, intact: !s.invalid && !s.symlink && settingsIntact(manifest.settings as ManagedSettings, s.parsed) };
    }
    return {
      files,
      applied: manifest ? { profileName: manifest.profileName, profileVersion: manifest.profileVersion, mode: manifest.mode, appliedAt: manifest.appliedAt } : null,
      settings,
      backups: this.listBackups(),
      at: this.now(),
    };
  }

  private listBackups(): ConfigBackupInfo[] {
    let ids: string[];
    try {
      ids = readdirSync(this.backupsDir).filter((n) => /^config-\d{13}$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
    const out: ConfigBackupInfo[] = [];
    for (const id of ids) {
      if (out.length >= CONFIG_LIMITS.maxBackupsReported) break;
      try {
        const b = BackupSchema.parse(JSON.parse(readFileSync(join(this.backupsDir, id, 'backup.json'), 'utf8')));
        out.push({ id, createdAt: b.createdAt, profileName: b.profileName.slice(0, 64), profileVersion: b.profileVersion, ...(b.rolledBack ? { rolledBack: true } : {}) });
      } catch {
        /* buzilgan zaxira ko'rsatilmaydi */
      }
    }
    return out;
  }

  // --- lokal holat -------------------------------------------------------------------------------------

  private loadManifest(): Manifest | null {
    try {
      return ManifestSchema.parse(JSON.parse(readFileSync(this.manifestFile, 'utf8')));
    } catch {
      return null; // yo'q yoki buzuq: hech narsa "Commander'niki" deb hisoblanmaydi (mirror hech narsa o'chirmaydi)
    }
  }

  private readSettingsLocal(): SettingsLocal {
    let st;
    try {
      st = lstatSync(this.settingsFile);
    } catch {
      return { exists: false };
    }
    if (st.isSymbolicLink()) return { exists: true, symlink: true };
    if (!st.isFile() || st.size > 1024 * 1024) return { exists: true, invalid: true };
    const raw = readFileSync(this.settingsFile);
    try {
      return { exists: true, raw, parsed: JSON.parse(raw.toString('utf8')) };
    } catch {
      return { exists: true, raw, invalid: true };
    }
  }
}

function decodeUtf8(b: Buffer): string | null {
  if (b.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

function existsDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function summaryText(r: ConfigPlanResult): string {
  const s = r.summary;
  return `plan: ${s.add} add, ${s.update} update, ${s.delete} delete, ${s.unchanged} unchanged, ${s.skip} skip${r.settings?.changed ? ', settings' : ''}`;
}
