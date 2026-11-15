import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AgentEvent, AgentLimitsPayload, UsageRecord } from '@commander/contracts';
import { EventsService } from '../events/events.service.js';
import { clampToNow } from '../events/session-state.js';
import { latestModelBySession } from './session-model-logic.js';
import { resolveSessionProjects } from '../projects/project-resolver.js';
import { ProjectPartsService } from '../projects/project-parts.service.js';
import { TaskSpansService } from '../projects/task-spans.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import type { SessionRef, UsageDelta } from '../realtime/realtime-bus.js';

export interface IngestResult {
  /** Yangi yozilgan qatorlar (dublikatlar kirmaydi). */
  inserted: number;
  duplicates: number;
}

/**
 * agentd xabarlarini DB'ga yozadi. HAR metod bitta tranzaksiya: u muvaffaqiyatli tugagandan KEYIN
 * chaqiruvchi ack yuboradi. Hammasi idempotent: bir xil xabarni qayta yuborish ikki marta hisoblanmaydi.
 */
@Injectable()
export class AgentIngestService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly bus: RealtimeBus,
    private readonly spans: TaskSpansService,
    private readonly parts: ProjectPartsService,
  ) {}

  /**
   * Hodisalar vaqt bo'yicha o'sish tartibida (barqaror) qo'llanadi, shunda `statusSince` to'g'ri
   * hisoblanadi. Idempotentlik: `event_id` (EventsService.recordEvent). Sessiyaning loyihasi
   * (`sessions.project_id`) sessiyaning BIRINCHI cwd'idan aniqlanadi va keyin o'zgarmaydi (project-resolution-logic.ts).
   */
  async ingestEvents(machineId: string, events: AgentEvent[], now: Date = new Date()): Promise<IngestResult> {
    const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);
    const changed: SessionRef[] = [];
    const result = await this.dataSource.transaction(async (m) => {
      changed.length = 0; // tranzaksiya qayta urinsa ro'yxat takrorlanmasin
      const projects = await resolveSessionProjects(m, machineId, ordered.map((e) => ({ sessionId: e.claudeSessionId, cwd: e.cwd, rootKind: e.rootKind })));
      let inserted = 0;
      let duplicates = 0;
      for (const e of ordered) {
        const outcome = await this.events.recordEvent(m, {
          machineId,
          input: {
            host: '',
            sessionId: e.claudeSessionId,
            cwd: e.cwd,
            status: e.status,
            message: e.message ?? null,
            notificationType: e.notificationType ?? null,
            endReason: e.reason ?? null,
            transcriptPath: e.transcriptPath ?? null,
            permissionMode: e.permissionMode ?? null,
          },
          event: e.event,
          at: clampToNow(e.ts, now),
          clientTs: e.ts,
          eventId: e.eventId,
          projectId: projects.get(e.claudeSessionId) ?? null,
        });
        if (outcome === 'duplicate') duplicates += 1;
        else {
          inserted += 1;
          // Vazifa span'lari (2.9): marker yoki sessiya tugashi; bir xil tranzaksiyada
          await this.spans.applyEvent(m, {
            machineId,
            claudeSessionId: e.claudeSessionId,
            projectId: projects.get(e.claudeSessionId) ?? null,
            taskKey: e.taskKey,
            taskSource: e.taskSource,
            status: e.status,
            at: clampToNow(e.ts, now),
          });
          // 3.5: sessiya diff'i bazasi = BIRINCHI SessionStart'dagi git HEAD (keyingilari uni o'zgartirmaydi)
          if (e.event === 'SessionStart' && e.headSha) {
            await m.query(`UPDATE sessions SET start_head_sha = COALESCE(start_head_sha, $3) WHERE machine_id = $1 AND claude_session_id = $2`, [machineId, e.claudeSessionId, e.headSha]);
          }
        }
        if (outcome === 'applied') changed.push({ machineId, claudeSessionId: e.claudeSessionId });
      }
      // 6.15: yangi sessiyalarga qism (start_cwd bo'yicha; qismlari ma'lum loyihalar uchun)
      await this.parts.assignPending(m, [...projects.values()].filter((id): id is string => id !== null));
      await m.query(`UPDATE machines SET last_seen_at = now() WHERE id = $1`, [machineId]);
      return { inserted, duplicates };
    });
    // COMMIT'dan keyin: klientlarga e'lon (fan-out xatosi ingest/ack'ni yiqitmaydi).
    if (changed.length > 0) this.bus.publish({ type: 'sessions.changed', refs: changed });
    return result;
  }

  /**
   * `token_usage`: dedup kaliti PK (machine_id, request_id, ts); `ON CONFLICT DO NOTHING` shuning uchun
   * qayta yuborish hech narsani ikki marta qo'shmaydi. `project_id` = sessiyaning loyihasi (sessiya yo'q bo'lsa cwd bo'yicha; ikkalasi ham yo'q = NULL).
   */
  async ingestUsage(machineId: string, records: UsageRecord[]): Promise<IngestResult> {
    const deltas: UsageDelta[] = [];
    const result = await this.dataSource.transaction(async (m) => {
      deltas.length = 0;
      const projects = await resolveSessionProjects(m, machineId, records.map((r) => ({ sessionId: r.claudeSessionId, cwd: r.cwd })));
      const rows: Array<{ request_id: string }> = await m.query(
        `INSERT INTO token_usage
           (ts, machine_id, request_id, session_id, project_id, prompt_id, model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source)
         SELECT timestamptz 'epoch' + u.ts_ms * interval '1 millisecond', $1::uuid, u.request_id, u.session_id, u.project_id, u.prompt_id, u.model,
                u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens, u.cost_usd, u.source
           FROM unnest(
                  $2::bigint[], $3::text[], $4::text[], $5::uuid[], $6::text[], $7::text[],
                  $8::bigint[], $9::bigint[], $10::bigint[], $11::bigint[], $12::numeric[], $13::text[]
                ) AS u(ts_ms, request_id, session_id, project_id, prompt_id, model,
                       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source)
         ON CONFLICT (machine_id, request_id, ts) DO NOTHING
         RETURNING request_id`,
        [
          machineId,
          records.map((r) => r.ts),
          records.map((r) => r.requestId),
          records.map((r) => r.claudeSessionId),
          records.map((r) => projects.get(r.claudeSessionId) ?? null),
          records.map((r) => r.promptId ?? null),
          records.map((r) => r.model),
          records.map((r) => r.inputTokens),
          records.map((r) => r.outputTokens),
          records.map((r) => r.cacheReadTokens),
          records.map((r) => r.cacheCreationTokens),
          records.map((r) => r.costUsd ?? null),
          records.map((r) => r.source),
        ],
      );
      await m.query(`UPDATE machines SET last_seen_at = now() WHERE id = $1`, [machineId]);
      // Sessiya modeli: hook'lar ko'pincha bermaydi, token yozuvida esa aniq bor — eng so'nggisi sessiyaga yoziladi
      const latest = latestModelBySession(records);
      if (latest.size > 0) {
        await m.query(
          `UPDATE sessions s SET model = u.model
             FROM unnest($2::text[], $3::text[]) AS u(session_id, model)
            WHERE s.machine_id = $1 AND s.claude_session_id = u.session_id AND s.model IS DISTINCT FROM u.model`,
          [machineId, [...latest.keys()], [...latest.values()]],
        );
      }
      const insertedIds = new Set(rows.map((r) => r.request_id));
      for (const r of records) {
        if (!insertedIds.has(r.requestId)) continue;
        deltas.push({
          machineId,
          projectId: projects.get(r.claudeSessionId) ?? null,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheCreationTokens: r.cacheCreationTokens,
          costUsd: r.costUsd ?? null,
        });
      }
      return { inserted: rows.length, duplicates: records.length - rows.length };
    });
    if (deltas.length > 0) this.bus.publish({ type: 'usage.recorded', rows: deltas });
    return result;
  }

  /** `limit_samples`, source = 'official' (status line rasmiy raqami). Dedup: PK (machine_id, source, ts=observedAt). */
  async ingestLimits(machineId: string, p: AgentLimitsPayload): Promise<IngestResult> {
    const rows: unknown[] = await this.dataSource.query(
      `INSERT INTO limit_samples
         (ts, machine_id, session_id, source,
          five_hour_used_pct, five_hour_resets_at, seven_day_used_pct, seven_day_resets_at)
       VALUES (timestamptz 'epoch' + $1::bigint * interval '1 millisecond', $2, $3, 'official',
               $4::numeric, timestamptz 'epoch' + $5::bigint * interval '1 millisecond',
               $6::numeric, timestamptz 'epoch' + $7::bigint * interval '1 millisecond')
       ON CONFLICT (machine_id, source, ts) DO NOTHING
       RETURNING ts`,
      [
        p.observedAt,
        machineId,
        p.claudeSessionId ?? null,
        p.fiveHour?.usedPct ?? null,
        p.fiveHour?.resetsAt ?? null,
        p.sevenDay?.usedPct ?? null,
        p.sevenDay?.resetsAt ?? null,
      ],
    );
    if (rows.length > 0) this.bus.publish({ type: 'limits.changed' });
    return { inserted: rows.length, duplicates: 1 - rows.length };
  }
}
