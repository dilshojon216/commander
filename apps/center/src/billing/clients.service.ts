import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BILLING_LIMITS } from '@commander/contracts';
import type { BillingProjectDto, ClientDto, CreateClientBody, ListBillingProjectsResponse, ListClientsResponse, UpdateClientBody } from '@commander/contracts';
import { trimRate } from './timesheet.service.js';

interface ClientRow {
  id: string;
  name: string;
  notes: string;
  hourly_rate: string | null;
  currency: 'UZS' | 'USD';
  created_at: Date;
  updated_at: Date;
  project_keys: string[] | null;
}

const COLS = `c.id, c.name, c.notes, c.hourly_rate::text AS hourly_rate, c.currency, c.created_at, c.updated_at,
  (SELECT COALESCE(array_agg(cp.project_key ORDER BY cp.project_key), '{}') FROM client_projects cp WHERE cp.client_id = c.id) AS project_keys`;

const toDto = (r: ClientRow): ClientDto => ({
  id: r.id,
  name: r.name,
  notes: r.notes,
  hourlyRate: r.hourly_rate === null ? null : trimRate(r.hourly_rate),
  currency: r.currency,
  projectKeys: r.project_keys ?? [],
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const isUniqueViolation = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

// ESLATMA: TypeORM (postgres) `UPDATE/DELETE ... RETURNING` natijasini `[rows, count]` qilib qaytaradi; CTE bilan oddiy qatorlar olinadi.
/** Mijozlar CRUD va loyiha <-> mijoz bog'lash (6.7). Yozish `control` + audit (interceptor) + dashboard elevation. */
@Injectable()
export class ClientsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(): Promise<ListClientsResponse> {
    const rows: ClientRow[] = await this.dataSource.query(`SELECT ${COLS} FROM clients c ORDER BY lower(c.name)`);
    return { items: rows.map(toDto) };
  }

  async get(id: string): Promise<ClientDto> {
    const rows: ClientRow[] = await this.dataSource.query(`SELECT ${COLS} FROM clients c WHERE c.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'client_not_found', message: 'Mijoz topilmadi' });
    return toDto(rows[0]);
  }

  async create(body: CreateClientBody): Promise<ClientDto> {
    const [{ n }] = (await this.dataSource.query(`SELECT count(*)::int AS n FROM clients`)) as Array<{ n: number }>;
    if (n >= BILLING_LIMITS.maxClients) throw new ConflictException({ error: 'too_many_clients', message: 'Mijozlar soni chegarasiga yetdi' });
    try {
      const rows: Array<{ id: string }> = await this.dataSource.query(
        `INSERT INTO clients (name, notes, hourly_rate, currency) VALUES ($1, $2, $3::numeric, $4) RETURNING id`,
        [body.name, body.notes ?? '', body.hourlyRate ?? null, body.currency ?? 'UZS'],
      );
      return this.get(rows[0]!.id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ error: 'client_exists', message: 'Bunday nomli mijoz bor' });
      throw e;
    }
  }

  async update(id: string, body: UpdateClientBody): Promise<ClientDto> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown, cast = ''): void => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (body.name !== undefined) add('name', body.name);
    if (body.notes !== undefined) add('notes', body.notes);
    if (body.hourlyRate !== undefined) add('hourly_rate', body.hourlyRate, '::numeric');
    if (body.currency !== undefined) add('currency', body.currency);
    try {
      const rows: Array<{ id: string }> = await this.dataSource.query(`WITH u AS (UPDATE clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id) SELECT id FROM u`, params);
      if (!rows[0]) throw new NotFoundException({ error: 'client_not_found', message: 'Mijoz topilmadi' });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ error: 'client_exists', message: 'Bunday nomli mijoz bor' });
      throw e;
    }
    return this.get(id);
  }

  async remove(id: string): Promise<{ deleted: true }> {
    const rows: Array<{ id: string }> = await this.dataSource.query(`WITH d AS (DELETE FROM clients WHERE id = $1 RETURNING id) SELECT id FROM d`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'client_not_found', message: 'Mijoz topilmadi' });
    return { deleted: true };
  }

  /** Mijozning loyiha guruhlarini to'liq almashtiradi; boshqa mijozga biriktirilgan guruh shu mijozga ko'chadi. */
  async setProjects(id: string, projectKeys: readonly string[]): Promise<ClientDto> {
    const keys = [...new Set(projectKeys)];
    await this.get(id);
    if (keys.length > 0) {
      const known: Array<{ k: string }> = await this.dataSource.query(`SELECT DISTINCT COALESCE(repo_key, id::text) AS k FROM projects WHERE COALESCE(repo_key, id::text) = ANY($1::text[])`, [keys]);
      const have = new Set(known.map((r) => r.k));
      const missing = keys.filter((k) => !have.has(k));
      if (missing.length > 0) throw new BadRequestException({ error: 'unknown_project', message: `Noma'lum loyiha: ${missing.length} ta kalit topilmadi` });
    }
    await this.dataSource.transaction(async (m) => {
      await m.query(`DELETE FROM client_projects WHERE client_id = $1 AND NOT (project_key = ANY($2::text[]))`, [id, keys]);
      if (keys.length > 0) {
        await m.query(
          `INSERT INTO client_projects (project_key, client_id) SELECT k, $1::uuid FROM unnest($2::text[]) AS k
           ON CONFLICT (project_key) DO UPDATE SET client_id = EXCLUDED.client_id`,
          [id, keys],
        );
      }
      await m.query(`UPDATE clients SET updated_at = now() WHERE id = $1`, [id]);
    });
    return this.get(id);
  }

  /** Mijozga biriktirish uchun loyiha guruhlari (repo_key bo'yicha mashinalar bo'ylab jamlangan). */
  async projects(): Promise<ListBillingProjectsResponse> {
    const rows: Array<{ project_key: string; name: string; repo_key: string | null; machines: number; last_at: Date | null; client_id: string | null }> = await this.dataSource.query(
      `SELECT g.project_key, g.name, g.repo_key, g.machines, g.last_at, cp.client_id
         FROM (
           SELECT COALESCE(p.repo_key, p.id::text) AS project_key,
                  (array_agg(p.name ORDER BY p.created_at DESC))[1] AS name,
                  max(p.repo_key) AS repo_key,
                  count(DISTINCT p.machine_id)::int AS machines,
                  max(GREATEST(p.last_snapshot_at, p.created_at)) AS last_at
             FROM projects p GROUP BY 1
         ) g LEFT JOIN client_projects cp ON cp.project_key = g.project_key
        ORDER BY g.last_at DESC NULLS LAST, g.name`,
    );
    const items: BillingProjectDto[] = rows.map((r) => ({ projectKey: r.project_key, name: r.name, repoKey: r.repo_key, machines: r.machines, lastActivityAt: r.last_at ? r.last_at.toISOString() : null, clientId: r.client_id }));
    return { items };
  }
}
