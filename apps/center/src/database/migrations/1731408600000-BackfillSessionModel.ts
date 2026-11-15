import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sessiya modeli bo'sh qolgan sessiyalar (hook'lar modelni ko'pincha bermaydi): `token_usage` dagi eng so'nggi model bilan
 * to'ldiriladi. Bundan keyin ingest o'zi yangilaydi. `down` — no-op (ma'lumot to'ldirish; qaytarish shart emas).
 */
export class BackfillSessionModel1731408600000 implements MigrationInterface {
  name = 'BackfillSessionModel1731408600000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE sessions s SET model = t.model
         FROM (SELECT DISTINCT ON (machine_id, session_id) machine_id, session_id, model
                 FROM token_usage
                WHERE model IS NOT NULL AND model <> '' AND model NOT LIKE '<%'
                ORDER BY machine_id, session_id, ts DESC) t
        WHERE s.model IS NULL AND s.machine_id = t.machine_id AND s.claude_session_id = t.session_id`,
    );
  }

  public async down(): Promise<void> {
    // no-op: to'ldirilgan model qiymatlari zararsiz
  }
}
