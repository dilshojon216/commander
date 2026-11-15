import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { DataSource } from 'typeorm';
import type { MigrationInterface } from 'typeorm';
import { ENTITIES, MIGRATIONS } from '../../src/database/database.config.js';

/** Admin ulanish (postgres DB'ga). Throwaway bazalar shu orqali yaratiladi/o'chiriladi. */
export function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required (TimescaleDB server, superuser)');
  return url;
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export async function createThrowawayDb(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `cmdr_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return {
    url: withDatabase(adminUrl(), name),
    drop: async () => {
      const a = new pg.Client({ connectionString: adminUrl() });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function openDataSource(
  url: string,
  migrations: Array<new () => MigrationInterface> = MIGRATIONS,
): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: ENTITIES,
    migrations,
    synchronize: false,
  });
  await ds.initialize();
  return ds;
}

/**
 * Yangi (throwaway) bazada migratsiyadan keyin TimescaleDB `policy_*` job'larini (retention, cagg refresh,
 * compression) to'xtatadi. Yangi bazada ular DARHOL ishga tushadi va testning birinchi yozuvlari
 * (projects/sessions FK + hypertable chunk'lari) bilan qulf to'qnashib deadlock berishi mumkin — test
 * artefakti (prod'da job kuniga bir marta, o'rnatishdan keyin bir marta). Testlar job'larni kerak bo'lsa
 * `run_job()` bilan o'zi chaqiradi.
 *
 * `createThrowawayDb()` ichida qilib bo'lmaydi: job'lar migratsiya paytida yaratiladi (migratsiyadan oldin
 * hali yo'q), migratsiya esa ikki yo'l bilan ishlaydi (`ds.runMigrations()` yoki Nest `migrationsRun`).
 * Shuning uchun migratsiyadan KEYIN chaqiriladi. Job jadvali/holatini tekshiradigan speclar (schema,
 * retention, health) buni chaqirmaydi.
 */
export async function pausePolicyJobs(ds: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  await ds.query(`SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE proc_name LIKE 'policy_%'`);
}
