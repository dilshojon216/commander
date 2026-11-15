import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  DEFAULT_INVESTIGATION_MODEL,
  DEFAULT_INVESTIGATION_SETTINGS,
  InvestigationSettingsSchema,
  OPS_FOLDER_HOWTO,
  SessionStatusSchema,
  HealthSnapshotSchema,
} from '@commander/contracts';
import type {
  AlertKind,
  HealthSnapshot,
  CommandDto,
  IncidentKind,
  IncidentSeverity,
  InvestigateBody,
  InvestigateResponse,
  InvestigationDto,
  InvestigationSettings,
  InvestigationState,
  InvestigationSubjectKind,
  ListInvestigationsQuery,
  ListInvestigationsResponse,
  PutInvestigationSettingsBody,
} from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { AuditService } from '../identity/audit/audit.service.js';
import { buildInvestigationPrompt, investigationSessionName } from './investigation-prompt.js';
import type { IncidentFacts } from './investigation-prompt.js';

export const INVESTIGATION_SETTINGS_KEY = 'investigation.settings';
/** Faol (tugamagan) tekshiruvlar holatlari: shu holatda yangisi ochilmaydi. */
const ACTIVE: ReadonlySet<InvestigationState> = new Set(['awaiting_confirmation', 'starting', 'running']);

interface Row {
  id: string;
  subject_kind: InvestigationSubjectKind;
  subject_id: string;
  machine_id: string;
  machine_name: string;
  command_id: string;
  model: string | null;
  created_at: Date;
  command_status: CommandDto['status'];
  error_code: string | null;
  error_message: string | null;
  session_id: string | null;
  session_status: string | null;
  ended_at: Date | null;
}

const SELECT = `
  SELECT ii.id, ii.subject_kind, ii.subject_id, ii.machine_id, COALESCE(m.display_name, m.hostname, m.slug) AS machine_name,
         ii.command_id, ii.model, ii.created_at, c.status AS command_status, c.error_code, c.error_message,
         s.id AS session_id, s.status AS session_status, s.ended_at
    FROM incident_investigations ii
    JOIN machines m ON m.id = ii.machine_id
    JOIN commands c ON c.id = ii.command_id
    LEFT JOIN sessions s ON s.machine_id = c.machine_id AND s.claude_session_id = c.result->>'claudeSessionId'`;

/** Buyruq + sessiya holatidan tekshiruv holati (sof). */
export function investigationState(commandStatus: CommandDto['status'], sessionEnded: boolean): InvestigationState {
  switch (commandStatus) {
    case 'awaiting_confirmation':
      return 'awaiting_confirmation';
    case 'pending':
    case 'sent':
    case 'acked':
    case 'running':
      return 'starting';
    case 'failed':
    case 'rejected':
    case 'expired':
      return 'failed';
    case 'done':
      return sessionEnded ? 'finished' : 'running';
  }
}

export function toInvestigationDto(r: Row): InvestigationDto {
  const ss = SessionStatusSchema.safeParse(r.session_status);
  return {
    id: r.id,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    machineId: r.machine_id,
    machineName: r.machine_name,
    commandId: r.command_id,
    sessionId: r.session_id,
    state: investigationState(r.command_status, r.ended_at !== null),
    sessionStatus: ss.success ? ss.data : null,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    model: r.model,
    createdAt: r.created_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
  };
}

/** Hodisa kontekst: qaysi mashina, nima ma'lum. */
interface Subject {
  machineId: string;
  machineName: string;
  facts: IncidentFacts;
  snapshot: HealthSnapshot | null;
  label: string;
}

/**
 * Hodisadan tekshiruvga (6.4). Hammasi mavjud buyruq konveyeri orqali (imzo, lokal siyosat, audit, step-up): tekshiruv =
 * `session.start` (plan rejimi) mashinaning sozlangan "ops" papkasida. Telegram inline tasdig'i (`confirmation: 'telegram_inline'`)
 * step-up'ni almashtiradi; dashboard so'rovi esa odatdagi Telegram step-up'ni talab qiladi (yoki istisno qurilma).
 */
@Injectable()
export class InvestigationsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly commands: CommandsService,
    private readonly audit: AuditService,
  ) {}

  // --- sozlamalar ------------------------------------------------------------------------------

  async getSettings(): Promise<InvestigationSettings> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [INVESTIGATION_SETTINGS_KEY]);
    const parsed = InvestigationSettingsSchema.safeParse({ ...DEFAULT_INVESTIGATION_SETTINGS, ...(typeof rows[0]?.value === 'object' && rows[0].value !== null ? rows[0].value : {}) });
    return parsed.success ? parsed.data : DEFAULT_INVESTIGATION_SETTINGS;
  }

  async putSettings(body: PutInvestigationSettingsBody): Promise<InvestigationSettings> {
    const cur = await this.getSettings();
    const opsFolders = { ...cur.opsFolders };
    for (const [machineId, path] of Object.entries(body.opsFolders ?? {})) {
      if (path === null) delete opsFolders[machineId];
      else opsFolders[machineId] = path;
    }
    const next = InvestigationSettingsSchema.parse({ model: body.model ?? cur.model, opsFolders });
    await this.dataSource.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [INVESTIGATION_SETTINGS_KEY, JSON.stringify(next)],
    );
    return next;
  }

  // --- hodisa konteksti ------------------------------------------------------------------------

  private async loadSubject(kind: InvestigationSubjectKind, id: string): Promise<Subject> {
    if (kind === 'health') {
      const rows: Array<{ machine_id: string; machine_name: string; kind: IncidentKind; subject: string; severity: IncidentSeverity; summary: string; opened_at: Date; resolved_at: Date | null; snapshot: unknown }> =
        await this.dataSource.query(
          `SELECT i.machine_id, COALESCE(m.display_name, m.hostname, m.slug) AS machine_name, i.kind, i.subject, i.severity, i.summary, i.opened_at, i.resolved_at,
                  (SELECT l.snapshot FROM machine_health_latest l WHERE l.machine_id = i.machine_id) AS snapshot
             FROM health_incidents i JOIN machines m ON m.id = i.machine_id WHERE i.id = $1`,
          [id],
        );
      const r = rows[0];
      if (!r) throw new NotFoundException({ error: 'not_found', message: 'Incident not found' });
      const snap = HealthSnapshotSchema.safeParse(r.snapshot);
      return {
        machineId: r.machine_id,
        machineName: r.machine_name,
        snapshot: snap.success ? snap.data : null,
        label: r.kind,
        facts: { kind: 'health', incidentKind: r.kind, subject: r.subject, severity: r.severity, summary: r.summary, openedAt: r.opened_at.toISOString(), resolved: r.resolved_at !== null },
      };
    }
    const rows: Array<{
      machine_id: string;
      machine_name: string;
      kind: AlertKind;
      title: string;
      detail: string;
      payload: Record<string, number | string | null>;
      created_at: Date;
      resolved_at: Date | null;
      session_name: string | null;
      project_name: string | null;
      snapshot: unknown;
    }> = await this.dataSource.query(
      `SELECT s.machine_id, COALESCE(m.display_name, m.hostname, m.slug) AS machine_name, a.kind, a.title, a.detail, a.payload, a.created_at, a.resolved_at,
              s.name AS session_name, COALESCE(p.name, s.project) AS project_name,
              (SELECT l.snapshot FROM machine_health_latest l WHERE l.machine_id = s.machine_id) AS snapshot
         FROM watchdog_alerts a JOIN sessions s ON s.id = a.session_id JOIN machines m ON m.id = s.machine_id LEFT JOIN projects p ON p.id = a.project_id
        WHERE a.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) throw new NotFoundException({ error: 'not_found', message: 'Alert not found' });
    const snap = HealthSnapshotSchema.safeParse(r.snapshot);
    return {
      machineId: r.machine_id,
      machineName: r.machine_name,
      snapshot: snap.success ? snap.data : null,
      label: 'watchdog',
      facts: {
        kind: 'watchdog',
        alertKind: r.kind,
        title: r.title,
        detail: r.detail,
        metrics: r.payload ?? {},
        projectName: r.project_name,
        sessionName: r.session_name,
        openedAt: r.created_at.toISOString(),
        resolved: r.resolved_at !== null,
      },
    };
  }

  // --- ishga tushirish -------------------------------------------------------------------------

  /** Telegram kartasi uchun: nima ochiladi (mashina, papka, model). Hech narsa yaratmaydi. */
  async preview(kind: InvestigationSubjectKind, id: string): Promise<{ machineId: string; machineName: string; folder: string | null; model: string; active: InvestigationDto | null }> {
    const subject = await this.loadSubject(kind, id);
    const settings = await this.getSettings();
    return { machineId: subject.machineId, machineName: subject.machineName, folder: settings.opsFolders[subject.machineId] ?? null, model: settings.model, active: await this.activeFor(kind, id) };
  }

  private async activeFor(kind: InvestigationSubjectKind, id: string): Promise<InvestigationDto | null> {
    const rows: Row[] = await this.dataSource.query(`${SELECT} WHERE ii.subject_kind = $1 AND ii.subject_id = $2 ORDER BY ii.created_at DESC LIMIT 3`, [kind, id]);
    const dto = rows.map(toInvestigationDto).find((d) => ACTIVE.has(d.state));
    return dto ?? null;
  }

  async start(body: InvestigateBody, actor: CommandActor, idempotencyKey?: string): Promise<InvestigateResponse> {
    const subject = await this.loadSubject(body.kind, body.id);
    const settings = await this.getSettings();
    const folder = settings.opsFolders[subject.machineId];
    if (!folder) throw new ConflictException({ error: 'ops_folder_not_configured', message: OPS_FOLDER_HOWTO });
    const active = await this.activeFor(body.kind, body.id);
    if (active) throw new ConflictException({ error: 'already_investigating', message: 'An investigation for this incident is already in progress', investigationId: active.id });

    const model = body.model ?? settings.model ?? DEFAULT_INVESTIGATION_MODEL;
    const prompt = buildInvestigationPrompt({ machineName: subject.machineName, facts: subject.facts, snapshot: subject.snapshot });
    // Aniq kalit: bir hodisa uchun bir daqiqada takroriy bosish bir xil buyruq (center idempotentligi)
    const key = idempotencyKey ?? `inv-${body.kind}-${body.id.slice(0, 8)}-${Math.floor(Date.now() / 60_000)}-${randomUUID().slice(0, 4)}`;
    const created = await this.commands.create(
      {
        type: 'session.start',
        machineId: subject.machineId,
        cwd: folder,
        prompt,
        model,
        // HAR DOIM plan: faqat o'qish; har qanday o'zgartirish alohida egasi tasdig'ini talab qiladi (mavjud ruxsat oqimi)
        permissionMode: 'plan',
        name: investigationSessionName(body.kind, subject.label, body.id),
      },
      { ...actor, reviewNotes: [`Hodisa tekshiruvi (${body.kind}): ${subject.machineName}. Plan rejimi: faqat o'qish.`] },
      key,
    );
    await this.dataSource.query(
      `INSERT INTO incident_investigations (subject_kind, subject_id, machine_id, command_id, requested_by_device_id, model) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (command_id) DO NOTHING`,
      [body.kind, body.id, subject.machineId, created.command.id, actor.deviceId, model],
    );
    await this.audit.record({
      actorDeviceId: actor.deviceId,
      actorKind: actor.actorKind,
      action: 'investigation.requested',
      target: created.command.id,
      ip: actor.ip,
      details: { subject_kind: body.kind, subject_id: body.id, machine_id: subject.machineId, model },
    });
    const dto = await this.getByCommand(created.command.id);
    return { investigation: dto, command: created.command };
  }

  // --- o'qish ----------------------------------------------------------------------------------

  async getByCommand(commandId: string): Promise<InvestigationDto> {
    const rows: Row[] = await this.dataSource.query(`${SELECT} WHERE ii.command_id = $1`, [commandId]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Investigation not found' });
    return toInvestigationDto(rows[0]);
  }

  async get(id: string): Promise<InvestigationDto> {
    const rows: Row[] = await this.dataSource.query(`${SELECT} WHERE ii.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Investigation not found' });
    return toInvestigationDto(rows[0]);
  }

  async list(q: ListInvestigationsQuery): Promise<ListInvestigationsResponse> {
    const rows: Row[] = await this.dataSource.query(
      `${SELECT}
        WHERE ($1::text IS NULL OR ii.subject_kind = $1) AND ($2::uuid IS NULL OR ii.machine_id = $2) AND ($3::uuid IS NULL OR ii.subject_id = $3)
        ORDER BY ii.created_at DESC LIMIT $4`,
      [q.kind ?? null, q.machineId ?? null, q.subjectId ?? null, q.limit],
    );
    return { items: rows.map(toInvestigationDto) };
  }
}

