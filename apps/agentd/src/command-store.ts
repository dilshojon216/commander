import type { DatabaseSync } from 'node:sqlite';
import type { CommandError, CommandResultData } from '@commander/contracts';

export type StoredState = 'received' | 'running' | 'done' | 'failed' | 'rejected';

export interface StoredCommand {
  commandId: string;
  nonce: string;
  type: string;
  state: StoredState;
  result: CommandResultData | null;
  error: CommandError | null;
  ackSent: boolean;
  ackConfirmed: boolean;
  resultConfirmed: boolean;
  /** `session.start` natijasi: biz ochgan Claude sessiyasi (maxConcurrentStarted hisobi uchun). */
  startedSessionId: string | null;
}

interface Row {
  command_id: string;
  nonce: string;
  type: string;
  state: StoredState;
  result: string | null;
  error: string | null;
  ack_sent: number;
  ack_confirmed: number;
  result_confirmed: number;
  started_session_id: string | null;
}

const toStored = (r: Row): StoredCommand => ({
  commandId: r.command_id,
  nonce: r.nonce,
  type: r.type,
  state: r.state,
  result: r.result ? (JSON.parse(r.result) as CommandResultData) : null,
  error: r.error ? (JSON.parse(r.error) as CommandError) : null,
  ackSent: r.ack_sent === 1,
  ackConfirmed: r.ack_confirmed === 1,
  resultConfirmed: r.result_confirmed === 1,
  startedSessionId: r.started_session_id,
});

/** Retention: nonce/natijalar shuncha ms saqlanadi (dispatch muddati <= 5 daqiqa, shuning uchun replay oynasi qamrab olinadi). */
export const COMMAND_LOG_RETENTION_MS = 24 * 3_600_000;

/**
 * Qabul qilingan buyruqlar jurnali (SQLite): (1) nonce VA commandId bir martaligi restartdan omon qoladi (replay himoyasi),
 * (2) natijalar markaz `ack` qilguncha saqlanadi va qayta ulanganda qayta yuboriladi (at-least-once; markaz idempotent).
 * Prompt matni bu yerda SAQLANMAYDI.
 */
export class CommandStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS command_log (
        command_id TEXT PRIMARY KEY,
        nonce TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        error TEXT,
        ack_sent INTEGER NOT NULL DEFAULT 0,
        ack_confirmed INTEGER NOT NULL DEFAULT 0,
        result_confirmed INTEGER NOT NULL DEFAULT 0,
        started_session_id TEXT,
        received_at INTEGER NOT NULL
      );
    `);
  }

  get(commandId: string): StoredCommand | undefined {
    const r = this.db.prepare('SELECT * FROM command_log WHERE command_id = ?').get(commandId) as Row | undefined;
    return r ? toStored(r) : undefined;
  }

  /**
   * Yangi buyruqni yozadi. `duplicate_command`: shu commandId allaqachon bor (qayta yetkazish: qayta bajarilmaydi);
   * `replayed_nonce`: nonce boshqa buyruqda ishlatilgan (REPLAY). `ok`: birinchi marta.
   */
  begin(commandId: string, nonce: string, type: string): 'ok' | 'duplicate_command' | 'replayed_nonce' {
    if (this.get(commandId)) return 'duplicate_command';
    try {
      this.db.prepare(`INSERT INTO command_log (command_id, nonce, type, state, received_at) VALUES (?, ?, ?, 'received', ?)`).run(commandId, nonce, type, this.now());
      return 'ok';
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) return this.get(commandId) ? 'duplicate_command' : 'replayed_nonce';
      throw err;
    }
  }

  markAckSent(commandId: string): void {
    this.db.prepare('UPDATE command_log SET ack_sent = 1 WHERE command_id = ?').run(commandId);
  }

  setState(commandId: string, state: StoredState, result?: CommandResultData, error?: CommandError): void {
    this.db
      .prepare('UPDATE command_log SET state = ?, result = ?, error = ?, result_confirmed = 0, started_session_id = COALESCE(?, started_session_id) WHERE command_id = ?')
      .run(state, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null, result?.claudeSessionId && state === 'done' ? result.claudeSessionId : null, commandId);
  }

  confirmAck(commandId: string): void {
    this.db.prepare('UPDATE command_log SET ack_confirmed = 1 WHERE command_id = ?').run(commandId);
  }

  confirmResult(commandId: string, state: StoredState): void {
    // Faqat shu holat uchun (oraliq `running` ack'i yakuniy natijani "tasdiqlangan" qilib yubormasin).
    this.db.prepare('UPDATE command_log SET result_confirmed = 1 WHERE command_id = ? AND state = ?').run(commandId, state);
  }

  /** Markaz tasdiqlamagan xabarlar (qayta ulanganda qayta yuboriladi). */
  unconfirmed(): StoredCommand[] {
    const rows = this.db
      .prepare(`SELECT * FROM command_log WHERE state <> 'received' AND (result_confirmed = 0 OR (ack_sent = 1 AND ack_confirmed = 0)) ORDER BY received_at`)
      .all() as unknown as Row[];
    return rows.map(toStored);
  }

  /** `session.start` (va 6.14 `session.resume`) natijasida bizning ochgan sessiyalarimiz (tirik/o'likligini chaqiruvchi `agents --json` bilan tekshiradi). */
  startedSessionIds(): string[] {
    const rows = this.db.prepare(`SELECT started_session_id FROM command_log WHERE type IN ('session.start', 'session.resume') AND state = 'done' AND started_session_id IS NOT NULL`).all() as Array<{ started_session_id: string }>;
    return rows.map((r) => r.started_session_id);
  }

  /** 6.14: agentd `session.resume` bilan yaratgan tmux sessiya nomlari (yopishda faqat shularni o'chirish mumkin). */
  createdTmuxSessions(): string[] {
    const rows = this.db.prepare(`SELECT result FROM command_log WHERE type = 'session.resume' AND state = 'done' AND result IS NOT NULL`).all() as Array<{ result: string }>;
    const out: string[] = [];
    for (const r of rows) {
      try {
        const n = (JSON.parse(r.result) as { tmuxSession?: unknown }).tmuxSession;
        if (typeof n === 'string') out.push(n);
      } catch {
        /* buzuq qator: e'tiborsiz */
      }
    }
    return out;
  }

  prune(): void {
    this.db.prepare('DELETE FROM command_log WHERE received_at < ? AND (result_confirmed = 1 OR state = ?)').run(this.now() - COMMAND_LOG_RETENTION_MS, 'received');
  }
}
