import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TEMPLATE_LIMITS } from '@commander/contracts';
import type {
  CreateCommandResponse,
  CreateTemplateBody,
  ListTemplatesQuery,
  ListTemplatesResponse,
  RenderTemplateBody,
  RenderTemplateResponse,
  SendTemplatePromptBody,
  TemplateDto,
  UpdateTemplateBody,
} from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { AuditService } from '../identity/audit/audit.service.js';
import { tashkentDayOf } from '../projects/tashkent-day.js';
import { buildRenderResponse, containsSecret, toTemplateDto } from './template-logic.js';
import type { RenderContext, TemplateRow } from './template-logic.js';

export interface TemplateActor {
  deviceId: string;
  actorKind: CommandActor['actorKind'];
  ip: string | null;
}

/** Render konteksti manbalari: loyiha (nom, oxirgi snapshot branch'i), vazifa (project_tasks), sessiya (loyiha + faol vazifa). */
export interface RenderInput extends RenderTemplateBody {
  /** Telegram `/new`: hali sessiya yo'q, loyiha (mashina + cwd) bo'yicha topiladi. */
  machineId?: string;
  cwd?: string;
}

const SELECT = `
  SELECT t.id, t.scope, t.project_id, p.name AS project_name, t.repo_key, t.name, t.description, t.body, t.model, t.permission_mode,
         t.builtin, t.big_task, t.created_by_device_id, t.created_at, t.updated_at
    FROM prompt_templates t LEFT JOIN projects p ON p.id = t.project_id`;

const unprocessable = (error: string, message: string, extra: Record<string, unknown> = {}): HttpException => new HttpException({ error, message, ...extra }, 422);

/**
 * Prompt shablonlari (3.4): CRUD (yozish `control` scope + audit), server tomonida render, mavjud sessiyaga prompt qilib yuborish.
 * Render qilingan matn hech qayerda saqlanmaydi: u (a) javob sifatida (preview, yangi sessiya/navbat formasini to'ldirish) yoki
 * (b) `session.prompt` buyrug'iga beriladi — u o'z yo'lida redakt qilib saqlaydi va auditga yozadi.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly commands: CommandsService,
  ) {}

  // --- o'qish ----------------------------------------------------------------------------------

  async list(q: ListTemplatesQuery): Promise<ListTemplatesResponse> {
    const rows: TemplateRow[] = await this.dataSource.query(
      `${SELECT}
        WHERE ($1::text IS NULL OR t.scope = $1)
          AND ($2::uuid IS NULL
               OR t.scope = 'global'
               OR (t.scope = 'project' AND t.project_id = $2)
               OR (t.scope = 'repo' AND t.repo_key = (SELECT repo_key FROM projects WHERE id = $2)))
        ORDER BY CASE t.scope WHEN 'project' THEN 0 WHEN 'repo' THEN 1 ELSE 2 END, lower(t.name)`,
      [q.scope ?? null, q.projectId ?? null],
    );
    return { items: rows.map(toTemplateDto) };
  }

  async get(id: string): Promise<TemplateDto> {
    const rows: TemplateRow[] = await this.dataSource.query(`${SELECT} WHERE t.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Template not found' });
    return toTemplateDto(rows[0]);
  }

  // --- yozish ----------------------------------------------------------------------------------

  async create(body: CreateTemplateBody, actor: TemplateActor): Promise<TemplateDto> {
    if (containsSecret(body.body)) throw unprocessable('secret_detected', 'The template text looks like it contains a secret (token/key); remove it');
    if (body.projectId) {
      const p: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1`, [body.projectId]);
      if (p.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
    }
    const id = await this.dataSource.transaction(async (m) => {
      const [{ n }] = (await m.query(`SELECT count(*)::int AS n FROM prompt_templates`)) as Array<{ n: number }>;
      if (n >= TEMPLATE_LIMITS.maxTemplates) throw new ConflictException({ error: 'too_many_templates', message: 'Too many templates' });
      let newId: string;
      try {
        const rows: Array<{ id: string }> = await m.query(
          `INSERT INTO prompt_templates (scope, project_id, repo_key, name, description, body, model, permission_mode, created_by_device_id, big_task)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [body.scope, body.projectId ?? null, body.repoKey ?? null, body.name, body.description?.trim() || null, body.body, body.model ?? null, body.permissionMode ?? null, actor.deviceId, body.bigTask === true],
        );
        newId = rows[0]!.id;
      } catch (err) {
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
          throw new ConflictException({ error: 'template_exists', message: 'A template with this name already exists in this scope' });
        }
        throw err;
      }
      await this.audit.record(
        { actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'template.created', target: newId, ip: actor.ip, details: { scope: body.scope, name: body.name, body_length: body.body.length } },
        m,
      );
      return newId;
    });
    return this.get(id);
  }

  async update(id: string, body: UpdateTemplateBody, actor: TemplateActor): Promise<TemplateDto> {
    if (body.body !== undefined && containsSecret(body.body)) throw unprocessable('secret_detected', 'The template text looks like it contains a secret (token/key); remove it');
    await this.dataSource.transaction(async (m) => {
      const cur: Array<{ id: string }> = await m.query(`SELECT id FROM prompt_templates WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur[0]) throw new NotFoundException({ error: 'not_found', message: 'Template not found' });
      const sets: string[] = [];
      const args: unknown[] = [id];
      const set = (col: string, v: unknown): void => {
        args.push(v);
        sets.push(`${col} = $${args.length}`);
      };
      if (body.name !== undefined) set('name', body.name);
      if (body.description !== undefined) set('description', body.description === null ? null : body.description.trim() || null);
      if (body.body !== undefined) set('body', body.body);
      if (body.model !== undefined) set('model', body.model);
      if (body.permissionMode !== undefined) set('permission_mode', body.permissionMode);
      if (body.bigTask !== undefined) set('big_task', body.bigTask);
      try {
        await m.query(`UPDATE prompt_templates SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, args);
      } catch (err) {
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
          throw new ConflictException({ error: 'template_exists', message: 'A template with this name already exists in this scope' });
        }
        throw err;
      }
      await this.audit.record(
        { actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'template.updated', target: id, ip: actor.ip, details: { fields: Object.keys(body), body_length: body.body?.length ?? null } },
        m,
      );
    });
    return this.get(id);
  }

  async remove(id: string, actor: TemplateActor): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const rows: Array<{ id: string; name: string }> = await m.query(`DELETE FROM prompt_templates WHERE id = $1 RETURNING id, name`, [id]);
      if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Template not found' });
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'template.deleted', target: id, ip: actor.ip, details: { name: rows[0].name } }, m);
    });
  }

  // --- render ----------------------------------------------------------------------------------

  async render(id: string, input: RenderInput, now: Date = new Date()): Promise<RenderTemplateResponse> {
    const t = await this.get(id);
    const ctx = await this.contextFor(input, now);
    return buildRenderResponse(t, ctx);
  }

  /** Sessiya/loyiha/vazifa bo'yicha kontekst. Topilmagan manba `null` (render `missing` ga qo'shadi); mavjud bo'lmagan id 404. */
  async contextFor(input: RenderInput, now: Date): Promise<RenderContext> {
    let projectId = input.projectId ?? null;
    let taskKey = input.taskKey ?? null;
    if (input.sessionId) {
      const rows: Array<{ project_id: string | null; machine_id: string; cwd: string; claude_session_id: string }> = await this.dataSource.query(
        `SELECT project_id, machine_id, cwd, claude_session_id FROM sessions WHERE id = $1`,
        [input.sessionId],
      );
      const s = rows[0];
      if (!s) throw new NotFoundException({ error: 'not_found', message: 'Session not found' });
      projectId = projectId ?? s.project_id ?? (await this.projectByPath(s.machine_id, s.cwd));
      if (!taskKey) {
        const spans: Array<{ task_key: string }> = await this.dataSource.query(
          `SELECT task_key FROM session_task_spans WHERE machine_id = $1 AND session_id = $2 ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 1`,
          [s.machine_id, s.claude_session_id],
        );
        taskKey = spans[0]?.task_key ?? null;
      }
    } else if (!projectId && input.machineId && input.cwd) {
      projectId = await this.projectByPath(input.machineId, input.cwd);
    }

    let project: RenderContext['project'] = null;
    if (projectId) {
      const rows: Array<{ name: string; branch: string | null }> = await this.dataSource.query(
        `SELECT p.name, (SELECT s.branch FROM project_snapshots s WHERE s.project_id = p.id ORDER BY s.taken_at DESC LIMIT 1) AS branch
           FROM projects p WHERE p.id = $1`,
        [projectId],
      );
      if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
      project = { name: rows[0].name, branch: rows[0].branch };
    }
    let taskTitle: string | null = null;
    if (projectId && taskKey) {
      const rows: Array<{ title: string }> = await this.dataSource.query(`SELECT title FROM project_tasks WHERE project_id = $1 AND task_key = $2`, [projectId, taskKey]);
      taskTitle = rows[0]?.title ?? null;
    }
    return { project, taskKey, taskTitle, date: tashkentDayOf(now) };
  }

  /** Telegram `/new`: shu mashina+papka uchun mavjud shablonlar (loyiha topilsa global + loyiha + repo, aks holda faqat global). */
  async listForCwd(machineId: string, cwd: string): Promise<TemplateDto[]> {
    const projectId = await this.projectByPath(machineId, cwd);
    return (await this.list(projectId ? { projectId } : { scope: 'global' })).items;
  }

  private async projectByPath(machineId: string, path: string): Promise<string | null> {
    const rows: Array<{ id: string }> = await this.dataSource.query(`SELECT id FROM projects WHERE machine_id = $1 AND path = $2 LIMIT 1`, [machineId, path]);
    return rows[0]?.id ?? null;
  }

  // --- ishlatish: mavjud sessiyaga prompt ------------------------------------------------------

  /**
   * Shablonni sessiyaga `session.prompt` qilib yuboradi. Yetishmayotgan o'zgaruvchi yoki juda uzun matn = 422 (yarim-render qilingan
   * matn hech qachon yuborilmaydi). Buyruq `CommandsService` orqali: policy, lockdown, audit (`command.created`) va tezlik chegarasi o'sha yo'lda;
   * qo'shimcha `template.sent` audit yozuvi shablon id'sini bog'laydi (matn yozilmaydi).
   */
  async sendPrompt(id: string, body: SendTemplatePromptBody, actor: TemplateActor, idempotencyKey?: string): Promise<CreateCommandResponse> {
    const r = await this.render(id, { sessionId: body.sessionId, ...(body.taskKey ? { taskKey: body.taskKey } : {}) });
    if (r.missing.length > 0) throw unprocessable('missing_variables', `Missing variables: ${r.missing.join(', ')}`, { missing: r.missing });
    if (r.tooLong) throw unprocessable('prompt_too_long', 'The rendered prompt is too long');
    await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'template.sent', target: id, ip: actor.ip, details: { session_id: body.sessionId, length: r.length } });
    return this.commands.create({ type: 'session.prompt', sessionId: body.sessionId, text: r.text }, { deviceId: actor.deviceId, actorKind: actor.actorKind, ip: actor.ip }, idempotencyKey);
  }
}
