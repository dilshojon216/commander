import { randomUUID } from 'node:crypto';
import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CONFIG_LIMITS, ConfigChunkBuffer, ConfigResultSchema, ConfigSkippedSchema, SettingsFragmentSchema } from '@commander/contracts';
import type {
  AgentControlState,
  CaptureConfigBody,
  CaptureConfigResponse,
  CommandDto,
  ConfigApplyBody,
  ConfigChunkPayload,
  ConfigDiffBody,
  ConfigDiffResponse,
  ConfigFileContentResponse,
  ConfigPlanResult,
  ConfigMachineState,
  ConfigProfileDetail,
  ConfigProfileSummary,
  ConfigRollbackBody,
  ConfigSettingsResponse,
  ConfigSkipped,
  ConfigStateReport,
  ConfigStatusResponse,
  CreateCommandResponse,
  ListConfigProfilesResponse,
  SettingsFragment,
} from '@commander/contracts';
import { ConfigStateReportSchema } from '@commander/contracts';
import { redactText } from '../common/redact-text.js';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { decodeBundle, encodeBundle } from './config-bundle.js';
import { summarizeConfigApply, summarizeWithoutPlan } from './config-review.js';
import { computeConfigStatus } from './config-status.js';
import type { LatestProfileRef } from './config-status.js';
import { fragmentSha256, validateCapture } from './config-validate.js';

const looksSecret = (t: string): boolean => redactText(t) !== t;
const DRIFT_NOTIFY_KEY = 'config.drift_notify';
/** H-06: oxirgi dry-run rejalari (apply kartasi uchun haqiqiy farq). Faqat xotirada; mazmun DB'ga yozilmaydi. */
const PLAN_CACHE_TTL_MS = 30 * 60_000;
const PLAN_CACHE_MAX = 64;

export function httpStatusForConfigError(code: string | null): number {
  switch (code) {
    case 'machine_offline':
    case 'config_plan_changed':
    case 'agent_outdated':
      return 409;
    case 'lockdown':
    case 'policy_disabled':
    case 'config_not_allowed':
    case 'action_not_allowed':
    case 'center_key_unpinned':
    case 'running_as_root':
      return 403;
    case 'agent_timeout':
    case 'dispatch_expired':
      return 504;
    default:
      return 502;
  }
}

interface ProfileRow {
  id: string;
  name: string;
  version: number;
  source_machine_id: string | null;
  source_machine_slug: string | null;
  created_by_device_id: string | null;
  created_at: Date;
  file_count: number;
  total_bytes: number;
  has_settings: boolean;
  latest: boolean;
}

const PROFILE_SELECT = `
  SELECT p.id, p.name, p.version, p.source_machine_id, m.slug AS source_machine_slug, p.created_by_device_id, p.created_at,
         p.file_count, p.total_bytes, (p.settings IS NOT NULL) AS has_settings,
         (p.version = (SELECT max(version) FROM config_profiles x WHERE x.name = p.name)) AS latest
    FROM config_profiles p LEFT JOIN machines m ON m.id = p.source_machine_id`;

const toSummary = (r: ProfileRow): ConfigProfileSummary => ({
  id: r.id,
  name: r.name,
  version: r.version,
  sourceMachineId: r.source_machine_id,
  sourceMachineSlug: r.source_machine_slug,
  createdByDeviceId: r.created_by_device_id,
  createdAt: r.created_at.toISOString(),
  fileCount: r.file_count,
  totalBytes: r.total_bytes,
  hasSettings: r.has_settings,
  latest: r.latest,
});

export type DriftListener = (machineId: string, prev: string | null, next: string, info: { applied: { profileName: string; profileVersion: number } | null }) => void;

/**
 * Sozlamalar sinxronlash (3.7), markaz tomoni: profillar (versiyalar), capture/diff/apply/rollback buyruqlari (`commands` konveyeri:
 * imzo + audit + step-up + lokal siyosat), heartbeat drift hisoboti va `config.chunk` qabul qilish.
 * Agentdan kelgan HAR narsa markazda qayta tekshiriladi (`validateCapture`).
 */
@Injectable()
export class ConfigSyncService {
  private readonly logger = new Logger(ConfigSyncService.name);
  private readonly buffers = new Map<string, ConfigChunkBuffer>();
  private readonly listeners = new Set<DriftListener>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly commands: CommandsService,
  ) {}

  // --- agent -> center ------------------------------------------------------------------------

  onChunk(machineId: string, c: ConfigChunkPayload): void {
    let b = this.buffers.get(machineId);
    if (!b) this.buffers.set(machineId, (b = new ConfigChunkBuffer()));
    if (!b.add(c, Date.now())) this.logger.warn(`config.chunk rejected (machine ${machineId})`);
  }

  onDrift(l: DriftListener): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  /** Heartbeat `config` hisoboti: saqlaydi va holat o'zgarsa tinglovchilarni (Telegram) ogohlantiradi. */
  async onHeartbeat(machineId: string, report: ConfigStateReport): Promise<void> {
    const parsed = ConfigStateReportSchema.safeParse(report);
    if (!parsed.success) return;
    const r = parsed.data;
    const prevRows: Array<{ status: string | null }> = await this.dataSource.query(`SELECT status FROM config_machine_state WHERE machine_id = $1`, [machineId]);
    const latest = r.applied ? await this.latestRef(r.applied.profileName) : null;
    const core = computeConfigStatus({ supported: true, report: r }, latest);
    await this.dataSource.query(
      `INSERT INTO config_machine_state (machine_id, report, reported_at, status) VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (machine_id) DO UPDATE SET report = EXCLUDED.report, reported_at = now(), status = EXCLUDED.status`,
      [machineId, JSON.stringify(r), core.status],
    );
    const prev = prevRows[0]?.status ?? null;
    if (prev !== core.status) {
      for (const l of this.listeners) {
        try {
          l(machineId, prev, core.status, { applied: core.applied ? { profileName: core.applied.profileName, profileVersion: core.applied.profileVersion } : null });
        } catch (err) {
          this.logger.warn(`drift listener failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // --- profillar ------------------------------------------------------------------------------

  async listProfiles(): Promise<ListConfigProfilesResponse> {
    const rows: ProfileRow[] = await this.dataSource.query(`${PROFILE_SELECT} ORDER BY p.name, p.version DESC`);
    return { items: rows.map(toSummary) };
  }

  async getSummary(id: string): Promise<ConfigProfileSummary> {
    const rows: ProfileRow[] = await this.dataSource.query(`${PROFILE_SELECT} WHERE p.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'profile_not_found', message: 'Profile not found' });
    return toSummary(rows[0]);
  }

  async profileDetail(id: string): Promise<ConfigProfileDetail> {
    const summary = await this.getSummary(id);
    const meta: Array<{ settings: unknown; skipped: unknown }> = await this.dataSource.query(`SELECT settings, skipped FROM config_profiles WHERE id = $1`, [id]);
    const files: Array<{ path: string; kind: string; sha256: string; size: number; exec: boolean }> = await this.dataSource.query(
      `SELECT path, kind, sha256, size, exec FROM config_profile_files WHERE profile_id = $1 ORDER BY path`,
      [id],
    );
    const settings = meta[0]?.settings ? SettingsFragmentSchema.safeParse(meta[0].settings) : null;
    const skipped = ConfigSkippedSchema.array().safeParse(meta[0]?.skipped);
    return {
      ...summary,
      files: files.map((f) => ({ path: f.path, kind: f.kind as ConfigProfileDetail['files'][number]['kind'], sha256: f.sha256, size: f.size, exec: f.exec })),
      settings: settings?.success ? settings.data : null,
      skipped: skipped.success ? skipped.data : [],
    };
  }

  async fileContent(id: string, path: string): Promise<ConfigFileContentResponse> {
    const rows: Array<{ path: string; sha256: string; size: number; content: string }> = await this.dataSource.query(
      `SELECT path, sha256, size, content FROM config_profile_files WHERE profile_id = $1 AND path = $2`,
      [id, path],
    );
    if (!rows[0]) throw new NotFoundException({ error: 'file_not_found', message: 'File not found in this profile version' });
    return { path: rows[0].path, sha256: rows[0].sha256, size: rows[0].size, content: rows[0].content };
  }

  private async latestRef(name: string): Promise<LatestProfileRef | null> {
    const rows: Array<{ id: string; version: number; settings_sha256: string | null }> = await this.dataSource.query(
      `SELECT id, version, settings_sha256 FROM config_profiles WHERE name = $1 ORDER BY version DESC LIMIT 1`,
      [name],
    );
    const p = rows[0];
    if (!p) return null;
    const files: Array<{ path: string; sha256: string }> = await this.dataSource.query(`SELECT path, sha256 FROM config_profile_files WHERE profile_id = $1`, [p.id]);
    return { version: p.version, files, settingsSha256: p.settings_sha256 };
  }

  // --- capture --------------------------------------------------------------------------------

  async capture(body: CaptureConfigBody, actor: CommandActor): Promise<CaptureConfigResponse> {
    const created = await this.commands.create({ type: 'config.capture', machineId: body.machineId }, actor, undefined);
    this.throwIfFailed(created.command);
    const { command, timedOut } = await this.commands.waitFinished(created.command.id, CONFIG_LIMITS.captureWaitMs);
    if (timedOut) throw new HttpException({ error: 'agent_timeout', message: 'The agent did not return the files in time', commandId: command.id }, 504);
    this.throwIfFailed(command);
    const raw = ConfigResultSchema.safeParse(this.commands.takeConfig(command.id));
    if (!raw.success || raw.data.kind !== 'capture') throw new HttpException({ error: 'invalid_result', message: 'The agent returned an invalid capture result; retry', commandId: command.id }, 502);
    const res = raw.data;

    let bundle = null;
    if (res.bundle) {
      const parts = this.buffers.get(body.machineId)?.get(res.bundle.sha256, res.bundle.chunks);
      if (!parts) throw new HttpException({ error: 'config_bundle_missing', message: 'The profile content did not arrive completely; retry', commandId: command.id }, 502);
      const dec = decodeBundle(parts, res.bundle);
      this.buffers.get(body.machineId)?.delete(res.bundle.sha256);
      if (!dec.ok) throw new HttpException({ error: 'config_bundle_invalid', message: dec.reason, commandId: command.id }, 502);
      bundle = dec.bundle;
    }
    const v = validateCapture(res, bundle, looksSecret);
    if (!v.ok) throw new HttpException({ error: 'config_bundle_invalid', message: v.error, commandId: command.id }, 502);
    if (v.value.files.length === 0 && v.value.settings === null) {
      throw new HttpException({ error: 'config_empty', message: 'Nothing to capture (no managed files or settings found)', skipped: v.value.skipped, commandId: command.id }, 422);
    }

    const profile = await this.storeProfile(body.name, body.machineId, actor.deviceId, v.value.files, v.value.settings, v.value.skipped, v.value.totalBytes);
    return { profile, skipped: v.value.skipped, commandId: command.id };
  }

  private async storeProfile(
    name: string,
    machineId: string,
    deviceId: string,
    files: Array<{ path: string; kind: string; sha256: string; size: number; exec: boolean; content: string }>,
    settings: SettingsFragment | null,
    skipped: ConfigSkipped[],
    totalBytes: number,
  ): Promise<ConfigProfileSummary> {
    const id = randomUUID();
    await this.dataSource.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`config_profiles:${name}`]);
      const [{ v }] = (await m.query(`SELECT COALESCE(max(version), 0) + 1 AS v FROM config_profiles WHERE name = $1`, [name])) as Array<{ v: number }>;
      await m.query(
        `INSERT INTO config_profiles (id, name, version, source_machine_id, created_by_device_id, file_count, total_bytes, settings, settings_sha256, skipped)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb)`,
        [id, name, v, machineId, deviceId, files.length, totalBytes, settings ? JSON.stringify(settings) : null, settings ? fragmentSha256(settings) : null, JSON.stringify(skipped)],
      );
      for (const f of files) {
        await m.query(`INSERT INTO config_profile_files (profile_id, path, kind, sha256, size, exec, content) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, f.path, f.kind, f.sha256, f.size, f.exec, f.content]);
      }
    });
    return this.getSummary(id);
  }

  // --- diff / apply / rollback ----------------------------------------------------------------

  private async buildApply(profileId: string, mode: 'merge' | 'mirror', dryRun: boolean, expectedPlanHash: string | undefined) {
    const summary = await this.getSummary(profileId);
    const meta: Array<{ settings: unknown; settings_sha256: string | null }> = await this.dataSource.query(`SELECT settings, settings_sha256 FROM config_profiles WHERE id = $1`, [profileId]);
    const rows: Array<{ path: string; kind: string; sha256: string; size: number; exec: boolean; content: string }> = await this.dataSource.query(
      `SELECT path, kind, sha256, size, exec, content FROM config_profile_files WHERE profile_id = $1 ORDER BY path`,
      [profileId],
    );
    const settingsParsed = meta[0]?.settings ? SettingsFragmentSchema.safeParse(meta[0].settings) : null;
    const settings = settingsParsed?.success ? settingsParsed.data : null;
    const enc = rows.length > 0 || settings ? encodeBundle({ files: rows.map((r) => ({ path: r.path, content: r.content })), settings }) : null;
    const items = rows.map((r) => ({ path: r.path, kind: r.kind as 'skill', sha256: r.sha256, size: r.size, exec: r.exec }));
    const apply = {
      profileName: summary.name,
      profileVersion: summary.version,
      mode,
      dryRun,
      items,
      settingsSha256: settings ? meta[0]!.settings_sha256 : null,
      bundle: enc?.ref ?? null,
      ...(expectedPlanHash ? { expectedPlanHash } : {}),
    };
    return { summary, apply, chunks: enc?.chunks ?? [], bundle: rows.length > 0 || settings ? { files: rows.map((r) => ({ path: r.path, content: r.content })), settings } : null, execPaths: new Set(rows.filter((r) => r.exec).map((r) => r.path)) };
  }

  /** Dry-run: agent lokal fayllar bilan solishtirib reja va diff qaytaradi (hech narsa yozilmaydi). */
  async diff(machineId: string, body: ConfigDiffBody, actor: CommandActor): Promise<ConfigDiffResponse> {
    const { summary, apply, chunks } = await this.buildApply(body.profileId, body.mode, true, undefined);
    const created = await this.commands.create(
      { type: 'config.apply', machineId, apply, chunks, preview: `Farq (dry-run): ${summary.name} v${summary.version}`, profileId: summary.id },
      actor,
      undefined,
    );
    this.throwIfFailed(created.command);
    const { command, timedOut } = await this.commands.waitFinished(created.command.id, CONFIG_LIMITS.diffWaitMs);
    if (timedOut) throw new HttpException({ error: 'agent_timeout', message: 'The agent did not return the plan in time', commandId: command.id }, 504);
    this.throwIfFailed(command);
    const raw = ConfigResultSchema.safeParse(this.commands.takeConfig(command.id));
    if (!raw.success || raw.data.kind !== 'plan') throw new HttpException({ error: 'invalid_result', message: 'The agent returned an invalid plan; retry', commandId: command.id }, 502);
    this.rememberPlan(machineId, body.profileId, raw.data);
    return { commandId: command.id, profile: summary, plan: raw.data };
  }

  private readonly plans = new Map<string, { plan: ConfigPlanResult; until: number }>();

  private rememberPlan(machineId: string, profileId: string, plan: ConfigPlanResult, now: number = Date.now()): void {
    if (this.plans.size >= PLAN_CACHE_MAX) {
      for (const [k, v] of this.plans) if (v.until <= now) this.plans.delete(k);
      if (this.plans.size >= PLAN_CACHE_MAX) this.plans.delete(this.plans.keys().next().value as string);
    }
    this.plans.set(`${machineId}|${profileId}|${plan.planHash}`, { plan, until: now + PLAN_CACHE_TTL_MS });
  }

  private recallPlan(machineId: string, profileId: string, planHash: string, now: number = Date.now()): ConfigPlanResult | null {
    const hit = this.plans.get(`${machineId}|${profileId}|${planHash}`);
    return hit && hit.until > now ? hit.plan : null;
  }

  /** Haqiqiy qo'llash: step-up (Telegram) qoidalari bo'yicha; natija `command.updated` bilan. */
  async apply(machineId: string, body: ConfigApplyBody, actor: CommandActor, idempotencyKey: string | undefined): Promise<CreateCommandResponse> {
    const { summary, apply, chunks, bundle, execPaths } = await this.buildApply(body.profileId, body.mode, false, body.expectedPlanHash);
    // H-06: egasiga HAQIQIY o'zgarishlar xulosasi: tasdiqlangan reja (`expectedPlanHash`) uchun oxirgi dry-run natijasi (diff) ishlatiladi.
    // Reja xotirada yo'q bo'lsa (restart/eskirgan): faqat profil mazmuni bo'yicha bayroqlar va dashboard'da majburiy ko'rib chiqish.
    const plan = this.recallPlan(machineId, body.profileId, body.expectedPlanHash);
    const review = plan ? summarizeConfigApply(summary.name, summary.version, body.mode, plan, bundle, execPaths) : summarizeWithoutPlan(summary.name, summary.version, body.mode, bundle, execPaths);
    const preview = `${review.preview}\nreja: ${body.expectedPlanHash.slice(0, 8)}`;
    return this.commands.create({ type: 'config.apply', machineId, apply, chunks, preview, profileId: summary.id, review: review.review }, actor, idempotencyKey);
  }

  async rollback(machineId: string, body: ConfigRollbackBody, actor: CommandActor, idempotencyKey: string | undefined): Promise<CreateCommandResponse> {
    const rows: Array<{ report: unknown }> = await this.dataSource.query(`SELECT report FROM config_machine_state WHERE machine_id = $1`, [machineId]);
    const rep = ConfigStateReportSchema.safeParse(rows[0]?.report);
    if (rep.success && !rep.data.backups.some((b) => b.id === body.backupId)) {
      throw new ConflictException({ error: 'config_backup_not_found', message: 'This backup is not in the machine\'s last report' });
    }
    return this.commands.create({ type: 'config.rollback', machineId, backupId: body.backupId }, actor, idempotencyKey);
  }

  // --- holat ----------------------------------------------------------------------------------

  async status(profileName: string | undefined): Promise<ConfigStatusResponse> {
    const name = profileName ?? 'default';
    const latestRows: ProfileRow[] = await this.dataSource.query(`${PROFILE_SELECT} WHERE p.name = $1 ORDER BY p.version DESC LIMIT 1`, [name]);
    const machines: Array<{ id: string; slug: string; display_name: string | null; hostname: string | null; online: boolean; control: AgentControlState | null; report: unknown; reported_at: Date | null }> =
      await this.dataSource.query(
        `SELECT m.id, m.slug, m.display_name, m.hostname, m.online, m.control, s.report, s.reported_at
           FROM machines m LEFT JOIN config_machine_state s ON s.machine_id = m.id
          WHERE m.status = 'active' AND m.merged_into_id IS NULL ORDER BY m.slug`,
      );
    const cache = new Map<string, LatestProfileRef | null>();
    const out: ConfigMachineState[] = [];
    for (const m of machines) {
      const parsed = m.report ? ConfigStateReportSchema.safeParse(m.report) : null;
      const report = parsed?.success ? parsed.data : null;
      const supported = m.control?.configSync === true || report !== null;
      let latest: LatestProfileRef | null = null;
      if (report?.applied) {
        const n = report.applied.profileName;
        if (!cache.has(n)) cache.set(n, await this.latestRef(n));
        latest = cache.get(n) ?? null;
      }
      const core = computeConfigStatus({ supported, report }, latest);
      out.push({
        machineId: m.id,
        slug: m.slug,
        name: m.display_name ?? m.hostname ?? m.slug,
        online: m.online,
        supported,
        allowRead: m.control?.allowConfigRead === true,
        allowWrite: m.control?.allowConfigWrite === true,
        ...core,
        reportedAt: m.reported_at ? m.reported_at.toISOString() : null,
      });
    }
    return { profile: latestRows[0] ? toSummary(latestRows[0]) : null, machines: out };
  }

  // --- sozlama --------------------------------------------------------------------------------

  async getSettings(): Promise<ConfigSettingsResponse> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [DRIFT_NOTIFY_KEY]);
    return { driftNotify: rows[0]?.value === true };
  }

  async putSettings(s: ConfigSettingsResponse): Promise<ConfigSettingsResponse> {
    await this.dataSource.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [DRIFT_NOTIFY_KEY, JSON.stringify(s.driftNotify)],
    );
    return s;
  }

  private throwIfFailed(c: CommandDto): void {
    if (c.status === 'rejected' || c.status === 'failed' || c.status === 'expired') {
      throw new HttpException({ error: c.errorCode ?? c.status, message: c.errorMessage ?? `Command ${c.status}`, commandId: c.id }, httpStatusForConfigError(c.errorCode));
    }
  }
}
