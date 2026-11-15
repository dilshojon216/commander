import type { DatabaseSync } from 'node:sqlite';
import type { SessionStatus } from '@commander/contracts';

export interface SessionRow {
  id: string;
  cwd: string | null;
  root: string | null;
  transcriptPath: string | null;
  status: SessionStatus | null;
  lastHookAt: number;
  otelLastAt: number;
  misses: number;
  endedAt: number | null;
}

interface RawSession {
  id: string;
  cwd: string | null;
  root: string | null;
  transcript_path: string | null;
  status: string | null;
  last_hook_at: number;
  otel_last_at: number;
  misses: number;
  ended_at: number | null;
}

function toRow(r: RawSession): SessionRow {
  return {
    id: r.id,
    cwd: r.cwd,
    root: r.root,
    transcriptPath: r.transcript_path,
    status: r.status as SessionStatus | null,
    lastHookAt: Number(r.last_hook_at),
    otelLastAt: Number(r.otel_last_at),
    misses: Number(r.misses),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
  };
}

const ENDED_RETENTION_MS = 7 * 24 * 3600 * 1000;

/** agentd bilgan sessiyalar: holat dedup'i, cwd/ildiz (OTel'da cwd yo'q), transcript yo'li, reconciliation hisoblagichi. */
export class SessionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as RawSession | undefined;
    return r ? toRow(r) : undefined;
  }

  /** Hook kelganda: sessiyani yaratadi/yangilaydi (cwd, ildiz, transcript yo'li, oxirgi hook vaqti, misses=0). */
  touchFromHook(id: string, patch: { cwd?: string; root?: string; transcriptPath?: string | null }): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, cwd, root, transcript_path, last_hook_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = COALESCE(excluded.cwd, cwd),
           root = COALESCE(excluded.root, root),
           transcript_path = COALESCE(excluded.transcript_path, transcript_path),
           last_hook_at = excluded.last_hook_at,
           misses = 0`,
      )
      .run(id, patch.cwd ?? null, patch.root ?? null, patch.transcriptPath ?? null, t, t);
  }

  setStatus(id: string, status: SessionStatus): void {
    const endedAt = status === 'ended' ? this.now() : null;
    this.db.prepare('UPDATE sessions SET status = ?, ended_at = ?, misses = 0 WHERE id = ?').run(status, endedAt, id);
  }

  /** OTel api_request kelganini belgilaydi (transcript fallback qarori uchun). */
  markOtel(id: string, at: number): void {
    this.db.prepare('UPDATE sessions SET otel_last_at = MAX(otel_last_at, ?) WHERE id = ?').run(at, id);
  }

  /** Hali tugamagan sessiyalar (reconciliation, transcript tailer). */
  listOpen(): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE status IS NOT 'ended' AND ended_at IS NULL").all() as unknown as RawSession[]).map(toRow);
  }

  /** Oxirgi `sinceMs` ichida tugagan sessiyalar (transcript'ni oxirigacha o'qish uchun). */
  listRecentlyEnded(sinceMs: number): SessionRow[] {
    return (
      this.db.prepare('SELECT * FROM sessions WHERE ended_at IS NOT NULL AND ended_at >= ?').all(this.now() - sinceMs) as unknown as RawSession[]
    ).map(toRow);
  }

  /** Ma'lum loyiha ildizlari (project-reporter): hozirgi va yaqinda tugagan sessiyalardan. */
  listRoots(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT root FROM sessions WHERE root IS NOT NULL').all() as unknown as Array<{ root: string }>;
    return rows.map((r) => r.root);
  }

  incrementMisses(id: string): number {
    this.db.prepare('UPDATE sessions SET misses = misses + 1 WHERE id = ?').run(id);
    return this.get(id)?.misses ?? 0;
  }

  resetMisses(id: string): void {
    this.db.prepare('UPDATE sessions SET misses = 0 WHERE id = ?').run(id);
  }

  prune(): void {
    this.db.prepare('DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?').run(this.now() - ENDED_RETENTION_MS);
    this.db.prepare('DELETE FROM transcript_offsets WHERE updated_at < ?').run(this.now() - ENDED_RETENTION_MS);
  }

  // --- transcript offsetlari ---

  getOffset(path: string): number | undefined {
    const r = this.db.prepare('SELECT byte_offset FROM transcript_offsets WHERE path = ?').get(path) as { byte_offset: number } | undefined;
    return r ? Number(r.byte_offset) : undefined;
  }

  setOffset(path: string, sessionId: string, offset: number): void {
    this.db
      .prepare(
        `INSERT INTO transcript_offsets (path, session_id, byte_offset, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET byte_offset = excluded.byte_offset, updated_at = excluded.updated_at`,
      )
      .run(path, sessionId, offset, this.now());
  }
}
