import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { CommandDto, CreateCommandResponse, LogsReadResponse, StartLogsBody } from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { LogsRelayService } from './logs-relay.service.js';

const FAILED: ReadonlySet<string> = new Set(['failed', 'rejected', 'expired']);

export interface LogsSnapshot {
  command: CommandDto;
  lines: string[];
  truncated: boolean;
  dropped: number;
}

/**
 * Log ko'ruvchi (6.6) markaz tomoni: buyruqni mavjud konveyer orqali yaratadi (imzo + audit + lokal siyosat; step-up YO'Q: faqat
 * o'qish) va xotiradagi oqimni cursor bilan o'qitadi. Log matni DB'ga yozilmaydi.
 */
@Injectable()
export class LogsService {
  constructor(
    private readonly commands: CommandsService,
    private readonly relay: LogsRelayService,
  ) {}

  async start(machineId: string, body: StartLogsBody, actor: CommandActor, idempotencyKey?: string): Promise<CreateCommandResponse> {
    if (!this.relay.canAccept()) throw new HttpException({ error: 'logs_busy', message: 'Too many open log streams on the center' }, 429);
    const out = await this.commands.create(
      { type: 'logs.tail', machineId, source: body.source, name: body.name, lines: body.lines, ...(body.since ? { since: body.since } : {}), ...(body.follow ? { follow: true } : {}) },
      actor,
      idempotencyKey,
    );
    if (!FAILED.has(out.command.status)) this.relay.register(out.command.id, out.command.machineId);
    return out;
  }

  private async logsCommand(commandId: string): Promise<CommandDto> {
    const dto = await this.commands.getDto(commandId);
    if (dto.type !== 'logs.tail') throw new NotFoundException({ error: 'not_found', message: 'Log stream not found' });
    return dto;
  }

  /** Bufer + buyruq holati: oqim boshlanmagan bo'lsa buyruq xatosi ko'rinadi (`error`), tugagan/yo'q oqim `done`. */
  async read(commandId: string, after: number): Promise<LogsReadResponse> {
    const dto = await this.logsCommand(commandId);
    const r = this.relay.read(commandId, after);
    const failed = FAILED.has(dto.status);
    const cmdError = { code: dto.errorCode ?? 'failed', message: dto.errorMessage ?? 'The command failed' };
    if (r) {
      if (failed && r.state !== 'done' && r.state !== 'error') return { ...r, state: 'error', reason: 'error', error: cmdError };
      return r;
    }
    const base = { commandId, lines: [] as string[], nextSeq: after, dropped: 0, truncated: false };
    if (failed) return { ...base, state: 'error', reason: 'error', error: cmdError };
    if (dto.status === 'done') return { ...base, state: 'done', reason: 'ended', error: null };
    return { ...base, state: 'starting', reason: null, error: null };
  }

  async stop(commandId: string): Promise<{ stopped: boolean }> {
    await this.logsCommand(commandId);
    return { stopped: this.relay.stop(commandId) };
  }

  /** Telegram uchun: snapshot buyrug'i, tugashini kutadi va xotiradagi qatorlarni qaytaradi. */
  async snapshot(machineId: string, body: Omit<StartLogsBody, 'follow'>, actor: CommandActor, waitMs = 30_000): Promise<LogsSnapshot> {
    const created = await this.start(machineId, { ...body, follow: false }, actor);
    const id = created.command.id;
    if (FAILED.has(created.command.status)) return { command: created.command, lines: [], truncated: false, dropped: 0 };
    const fin = await this.commands.waitFinished(id, waitMs);
    const r = this.relay.read(id, 0);
    // Snapshot bufer hajmiga (<= 256 KB) sig'adi, lekin `readPageLines` dan ko'p bo'lsa sahifalab olamiz (Telegram uchun ham yetarli)
    let lines = r?.lines ?? [];
    let next = r?.nextSeq ?? 0;
    for (let guard = 0; r && guard < 6 && lines.length > 0; guard++) {
      const more = this.relay.read(id, next);
      if (!more || more.lines.length === 0) break;
      lines = lines.concat(more.lines);
      next = more.nextSeq;
    }
    this.relay.stop(id); // snapshot tugagan bo'lsa no-op (follow emas)
    return { command: fin.command, lines, truncated: r?.truncated ?? false, dropped: r?.dropped ?? 0 };
  }
}
