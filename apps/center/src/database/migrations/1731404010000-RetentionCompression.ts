import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retention va compression siyosati (5.2). Yagona manba: PLAN.md "5.2" ADR; kod tomonida `retention/retention-policy.ts`.
 *
 * Hypertable'lar (TimescaleDB siyosatlari):
 *   session_events  90 kun (SessionsV2'da allaqachon) | compress 7 kundan keyin  | segmentby machine_id
 *   token_usage     30 kun (UsageAndLimits)           | compress 7 kundan keyin  | segmentby machine_id
 *   machine_health  14 kun (MachineHealth)            | compress 3 kundan keyin  | segmentby machine_id
 *   limit_samples   180 kun (YANGI)                   | compress yo'q (kichik)
 * Continuous aggregate'lar (`usage_5m`, `usage_1h`, `token_usage_daily_by_project`, `machine_health_5m`)ga retention YO'Q:
 * kunlik/umrbod statistika doimiy. Har cagg refresh `start_offset` i raw retention'dan KICHIK (token_usage: 25 < 30 kun,
 * machine_health: 3 < 14 kun), shu sabab raw chunk o'chirilganda materializatsiya qilingan bucket'lar qayta hisoblanib yo'qolmaydi.
 * `compress_after` har doim `drop_after`dan kichik.
 *
 * Compression job'lari migratsiyadan +1 soat keyin birinchi marta ishga tushadi (migratsiya/deploy paytida jonli INSERT'lar bilan
 * qulf poygasi bo'lmasin: sinovda `deadlock detected` kuzatilgan), keyin standart jadval bo'yicha.
 *
 * Oddiy jadvallar: TimescaleDB siyosati yo'q, shuning uchun `commander_retention_sweep` protsedurasi kuniga bir marta
 * (`add_job`, center ishlamasa ham DB ichida ishlaydi):
 *   approvals 90 kun (pending'dan tashqari; plan_text 30 kunlik alohida siyosati ApprovalRules'da servis tomonida),
 *   session_messages 30 kun, reports 365 kun (`generated_at`),
 *   commands.result: 90 kundan keyin KATTA (> 2 KB) natija jsonb `{trimmed, original_bytes}` ga almashtiriladi (qator saqlanadi).
 * audit_log: HECH QACHON o'chirilmaydi/o'zgartirilmaydi (append-only; trigger bunga yo'l qo'ymaydi). chat: umuman saqlanmaydi.
 */
export class RetentionCompression1731404010000 implements MigrationInterface {
  name = 'RetentionCompression1731404010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT add_retention_policy('limit_samples', INTERVAL '180 days')`);

    await queryRunner.query(`
      ALTER TABLE "token_usage" SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'machine_id',
        timescaledb.compress_orderby = 'ts DESC, request_id'
      )
    `);
    await queryRunner.query(`SELECT add_compression_policy('token_usage', INTERVAL '7 days', initial_start => now() + INTERVAL '1 hour')`);

    await queryRunner.query(`
      ALTER TABLE "session_events" SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'machine_id',
        timescaledb.compress_orderby = 'ts DESC, id DESC'
      )
    `);
    await queryRunner.query(`SELECT add_compression_policy('session_events', INTERVAL '7 days', initial_start => now() + INTERVAL '1 hour')`);

    await queryRunner.query(`
      ALTER TABLE "machine_health" SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'machine_id',
        timescaledb.compress_orderby = 'ts DESC'
      )
    `);
    await queryRunner.query(`SELECT add_compression_policy('machine_health', INTERVAL '3 days', initial_start => now() + INTERVAL '1 hour')`);

    await queryRunner.query(`
      CREATE PROCEDURE commander_retention_sweep(job_id int DEFAULT NULL, config jsonb DEFAULT NULL)
      LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM "session_messages" WHERE "created_at" < now() - INTERVAL '30 days';
        DELETE FROM "approvals" WHERE "status" <> 'pending' AND "requested_at" < now() - INTERVAL '90 days';
        DELETE FROM "reports" WHERE "generated_at" < now() - INTERVAL '365 days';
        UPDATE "commands"
           SET "result" = jsonb_build_object('trimmed', true, 'original_bytes', octet_length("result"::text))
         WHERE "result" IS NOT NULL
           AND "finished_at" < now() - INTERVAL '90 days'
           AND octet_length("result"::text) > 2048
           AND NOT ("result" ? 'trimmed');
      END
      $$
    `);
    // Birinchi ishga tushish: ertaga (migratsiya paytida katta o'chirish bo'lmasin), keyin har 24 soatda.
    await queryRunner.query(`
      SELECT add_job('commander_retention_sweep', INTERVAL '1 day', initial_start => now() + INTERVAL '1 hour', fixed_schedule => false)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      SELECT delete_job(job_id) FROM timescaledb_information.jobs WHERE proc_name = 'commander_retention_sweep'
    `);
    await queryRunner.query(`DROP PROCEDURE commander_retention_sweep(int, jsonb)`);
    for (const t of ['machine_health', 'session_events', 'token_usage']) {
      await queryRunner.query(`SELECT remove_compression_policy('${t}', if_exists => true)`);
      await queryRunner.query(`ALTER TABLE "${t}" SET (timescaledb.compress = false)`);
    }
    await queryRunner.query(`SELECT remove_retention_policy('limit_samples', if_exists => true)`);
  }
}
