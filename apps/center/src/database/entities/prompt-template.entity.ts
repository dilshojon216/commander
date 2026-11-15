import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const TEMPLATE_SCOPE_VALUES = ['global', 'project', 'repo'] as const;
export type TemplateScopeValue = (typeof TEMPLATE_SCOPE_VALUES)[number];

/** Prompt shabloni (3.4). Render qilingan matn saqlanmaydi: faqat `{{o'zgaruvchi}}` li asl matn. */
@Entity('prompt_templates')
export class PromptTemplate {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'text', name: 'scope' })
  scope: TemplateScopeValue;

  @Column({ type: 'uuid', name: 'project_id', nullable: true })
  projectId: string | null;

  @Column({ type: 'text', name: 'repo_key', nullable: true })
  repoKey: string | null;

  @Column({ type: 'text', name: 'name' })
  name: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description: string | null;

  @Column({ type: 'text', name: 'body' })
  body: string;

  @Column({ type: 'text', name: 'model', nullable: true })
  model: string | null;

  @Column({ type: 'text', name: 'permission_mode', nullable: true })
  permissionMode: string | null;

  /** 6.9: "katta vazifa" shabloni: sessiya ochishdan oldin avtomatik checkpoint (sozlama yoqilgan bo'lsa). */
  @Column({ type: 'boolean', name: 'big_task', default: false })
  bigTask: boolean;

  @Column({ type: 'boolean', name: 'builtin', default: false })
  builtin: boolean;

  @Column({ type: 'uuid', name: 'created_by_device_id', nullable: true })
  createdByDeviceId: string | null;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updatedAt: Date;
}
