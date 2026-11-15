import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prompt shablonlari (3.4).
 *
 * `prompt_templates`: ko'lam `global` | `project` (project_id) | `repo` (repo_key). Matn `{{task_key}}`, `{{task_title}}`,
 * `{{branch}}`, `{{project}}`, `{{date}}` o'zgaruvchilarini qo'llaydi; render markazda, render qilingan matn SAQLANMAYDI.
 * Nom ko'lam ichida noyob (katta-kichik harfga e'tiborsiz). `builtin` = shu migratsiya kiritgan global shablonlar.
 * `created_by_device_id` ixtiyoriy (seed uchun NULL; qurilma o'chirilsa NULL).
 */
const SEED: Array<{ name: string; description: string; body: string; mode: string | null }> = [
  {
    name: 'Testlarni yurgiz va tuzat',
    description: 'Test to\'plamini ishga tushiradi va yiqilganlarini tuzatadi',
    mode: 'acceptEdits',
    body:
      '{{project}} loyihasida (branch: {{branch}}) barcha testlarni yurgiz. Yiqilgan testlar bo\'lsa sababini top va kodni tuzat ' +
      '(testni faqat u noto\'g\'ri bo\'lsa o\'zgartir). Oxirida testlar to\'liq o\'tganini tasdiqla va nima o\'zgarganini qisqa yoz.',
  },
  {
    name: 'Kod review',
    description: 'Joriy branch o\'zgarishlarini ko\'rib chiqadi (yozmaydi)',
    mode: 'plan',
    body:
      '{{project}} loyihasidagi {{branch}} branch o\'zgarishlarini ko\'rib chiq (git diff asosida). Xatolar, xavfsizlik muammolari, ' +
      'test yetishmovchiligi va soddalashtirish imkoniyatlarini jiddiyligi bo\'yicha tartiblab yoz. Kodni o\'zgartirma.',
  },
  {
    name: 'CHANGELOG yangila',
    description: 'So\'nggi o\'zgarishlardan CHANGELOG yozuvini tayyorlaydi',
    mode: 'acceptEdits',
    body:
      '{{date}} sanasi uchun {{project}} CHANGELOG.md faylini yangila: oxirgi relizdan beri commitlarni (git log) o\'qib, ' +
      'foydalanuvchiga ko\'rinadigan o\'zgarishlarni "Qo\'shildi / O\'zgardi / Tuzatildi" bo\'limlariga yoz. Boshqa fayllarga tegma.',
  },
  {
    name: 'Deploy oldidan tekshiruv',
    description: 'Build, lint, test va migratsiyalarni tekshiradi (deploy qilmaydi)',
    mode: 'plan',
    body:
      '{{project}} ({{branch}}) deploy qilishdan oldin tekshir: build, lint, typecheck va testlar o\'tadimi; yangi migratsiyalar bormi ' +
      'va orqaga qaytariladimi; .env/sirlar commitga tushmaganmi. Natijani "tayyor / tayyor emas" xulosasi bilan yoz. Deploy qilma.',
  },
  {
    name: 'TASKS.md holatini yangila',
    description: 'Vazifa holatini kod bilan solishtirib TASKS.md ni yangilaydi',
    mode: 'acceptEdits',
    body:
      '{{project}} loyihasida {{task_key}} ({{task_title}}) vazifasining haqiqiy holatini kod va testlar bo\'yicha tekshir va ' +
      'docs/TASKS.md dagi holatini mos ravishda yangila. Faqat shu qatorni o\'zgartir; nima asosida qaror qilganingni qisqa yoz.',
  },
];

export class PromptTemplates1731403060000 implements MigrationInterface {
  name = 'PromptTemplates1731403060000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "prompt_templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "scope" text NOT NULL,
        "project_id" uuid,
        "repo_key" text,
        "name" text NOT NULL,
        "description" text,
        "body" text NOT NULL,
        "model" text,
        "permission_mode" text,
        "builtin" boolean NOT NULL DEFAULT false,
        "created_by_device_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_prompt_templates" PRIMARY KEY ("id"),
        CONSTRAINT "fk_prompt_templates_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_prompt_templates_device" FOREIGN KEY ("created_by_device_id") REFERENCES "devices" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_prompt_templates_scope" CHECK (
          ("scope" = 'global' AND "project_id" IS NULL AND "repo_key" IS NULL)
          OR ("scope" = 'project' AND "project_id" IS NOT NULL AND "repo_key" IS NULL)
          OR ("scope" = 'repo' AND "project_id" IS NULL AND "repo_key" IS NOT NULL)
        ),
        CONSTRAINT "chk_prompt_templates_mode" CHECK ("permission_mode" IS NULL OR "permission_mode" IN ('default', 'acceptEdits', 'plan', 'auto')),
        CONSTRAINT "chk_prompt_templates_body_len" CHECK (char_length("body") BETWEEN 1 AND 16000),
        CONSTRAINT "chk_prompt_templates_name_len" CHECK (char_length("name") BETWEEN 1 AND 80)
      )
    `);
    // Nom ko'lam egasi ichida noyob (NULL'lar noyoblikda teng hisoblanishi uchun COALESCE).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_prompt_templates_scope_name" ON "prompt_templates"
        ("scope", COALESCE("project_id", '00000000-0000-0000-0000-000000000000'::uuid), COALESCE("repo_key", ''), lower("name"))
    `);
    await queryRunner.query(`CREATE INDEX "idx_prompt_templates_project" ON "prompt_templates" ("project_id") WHERE "project_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "idx_prompt_templates_repo" ON "prompt_templates" ("repo_key") WHERE "repo_key" IS NOT NULL`);

    for (const t of SEED) {
      await queryRunner.query(
        `INSERT INTO "prompt_templates" ("scope", "name", "description", "body", "permission_mode", "builtin") VALUES ('global', $1, $2, $3, $4, true)`,
        [t.name, t.description, t.body, t.mode],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "prompt_templates"`);
  }
}
