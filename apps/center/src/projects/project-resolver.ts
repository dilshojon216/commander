import type { EntityManager } from 'typeorm';
import { decideProject, stickyProjectId } from './project-resolution-logic.js';
import type { ProjectCandidate } from './project-resolution-logic.js';

export interface CwdRef {
  cwd: string;
  rootKind?: 'git' | 'dir' | null | undefined;
}

const keyOf = (r: CwdRef): string => `${r.rootKind ?? ''}\u0000${r.cwd}`;

/** Mashinadagi sessiyalarning allaqachon belgilangan loyihalari (`claude_session_id` -> project_id | null). */
export async function loadSessionProjects(m: EntityManager, machineId: string, sessionIds: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return out;
  const rows: Array<{ claude_session_id: string; project_id: string | null }> = await m.query(
    `SELECT claude_session_id, project_id FROM sessions WHERE machine_id = $1 AND claude_session_id = ANY($2::text[])`,
    [machineId, ids],
  );
  for (const r of rows) out.set(r.claude_session_id, r.project_id);
  return out;
}

/** Bitta cwd uchun loyiha id'si (qoidalar: project-resolution-logic.ts). */
export async function resolveProjectForCwd(m: EntityManager, machineId: string, ref: CwdRef): Promise<string> {
  const exact: Array<{ id: string }> = await m.query(`SELECT id FROM projects WHERE machine_id = $1 AND path = $2`, [machineId, ref.cwd]);
  let ancestors: ProjectCandidate[] = [];
  if (!exact[0] && ref.rootKind !== 'git') {
    // starts_with: LIKE'dagi % va _ belgilarisiz; ildiz (`/`, `C:/`) mantiqda chiqarib tashlanadi
    ancestors = await m.query(
      `SELECT id, path FROM projects WHERE machine_id = $1 AND path <> $2 AND starts_with($2, rtrim(path, '/') || '/')`,
      [machineId, ref.cwd],
    );
  }
  const d = decideProject({ cwd: ref.cwd, rootKind: ref.rootKind, exactId: exact[0]?.id ?? null, ancestors });
  if (d.action === 'use') return d.projectId;
  const rows: Array<{ id: string }> = await m.query(`SELECT upsert_project($1::uuid, $2, NULL, NULL, $3) AS id`, [machineId, ref.cwd, d.kind]);
  return rows[0]!.id;
}

export interface SessionCwd extends CwdRef {
  sessionId: string;
}

/**
 * Har sessiya uchun loyiha id'si. Sessiyada loyiha bor bo'lsa o'sha (yopishqoq); yo'q bo'lsa shu sessiyaning
 * BIRINCHI cwd'idan aniqlanadi (`items` vaqt tartibida bo'lishi shart). cwd yo'q va loyiha yo'q -> null.
 * Barqaror tartibda yaratiladi (parallel tranzaksiyalarda deadlock bo'lmasin).
 */
export async function resolveSessionProjects(
  m: EntityManager,
  machineId: string,
  items: ReadonlyArray<{ sessionId: string; cwd?: string | undefined; rootKind?: 'git' | 'dir' | null | undefined }>,
): Promise<Map<string, string | null>> {
  const existing = await loadSessionProjects(m, machineId, items.map((i) => i.sessionId));
  const result = new Map<string, string | null>();
  const firstCwd = new Map<string, CwdRef>();
  for (const it of items) {
    const have = existing.get(it.sessionId);
    if (have) {
      result.set(it.sessionId, have);
      continue;
    }
    if (it.cwd && !firstCwd.has(it.sessionId)) firstCwd.set(it.sessionId, { cwd: it.cwd, rootKind: it.rootKind });
  }
  const unique = new Map<string, CwdRef>();
  for (const r of firstCwd.values()) unique.set(keyOf(r), r);
  const resolved = new Map<string, string>();
  for (const k of [...unique.keys()].sort()) resolved.set(k, await resolveProjectForCwd(m, machineId, unique.get(k)!));
  for (const it of items) {
    if (result.has(it.sessionId)) continue;
    const ref = firstCwd.get(it.sessionId);
    result.set(it.sessionId, stickyProjectId(existing.get(it.sessionId), ref ? resolved.get(keyOf(ref)) : null));
  }
  return result;
}
