import { z } from 'zod';
import { EpochMsSchema, envelopeMessage } from './envelope.js';

/**
 * Server salomatligi (task 3.8). agentd har 30 s da `agent.health` yuboradi (jonli: ack/outbox yo'q, uzilsa yo'qoladi),
 * center `machine_health` hypertable'ga yozadi va `health` kanali orqali klientlarga `machine.health` push qiladi.
 *
 * Maxfiylik: jarayonlar FAQAT nomi bilan (argumentlar yo'q: ular ichida sirlar bo'lishi mumkin); Docker uchun env va
 * label'lar yuborilmaydi; systemd uchun faqat unit nomlari.
 */

export const HEALTH_LIMITS = {
  maxDisks: 10,
  maxTopProcesses: 5,
  maxContainers: 100,
  maxFailedUnits: 50,
  maxPerCore: 256,
  /** agentd yig'ish oralig'i. */
  intervalMs: 30_000,
  /** To'liq snapshot shu oraliqda majburan yuboriladi (oraliqda faqat o'zgargan bo'limlar: delta). */
  fullEveryMs: 5 * 60_000,
} as const;

const Pct = z.number().min(0).max(100);
const Bytes = z.number().int().min(0).max(1e15);
const Name = z.string().min(1).max(128);

export const HealthCpuSchema = z.object({
  /** Umumiy CPU bandligi (%). `null` = birinchi o'lchov (farq hisoblash uchun avvalgi namuna yo'q). */
  pct: Pct.nullable(),
  load1: z.number().min(0).max(100_000).nullable().optional(),
  load5: z.number().min(0).max(100_000).nullable().optional(),
  load15: z.number().min(0).max(100_000).nullable().optional(),
  cores: z.number().int().min(1).max(4096),
  perCore: z.array(Pct).max(HEALTH_LIMITS.maxPerCore).optional(),
});
export type HealthCpu = z.infer<typeof HealthCpuSchema>;

export const HealthMemorySchema = z.object({
  totalBytes: Bytes,
  usedBytes: Bytes,
  swapTotalBytes: Bytes,
  swapUsedBytes: Bytes,
});
export type HealthMemory = z.infer<typeof HealthMemorySchema>;

export const HealthDiskSchema = z.object({
  /** Mount nuqtasi (`/`, `/var/lib/docker`, `C:`). */
  mount: z.string().min(1).max(256),
  fs: z.string().max(32).optional(),
  totalBytes: Bytes,
  usedBytes: Bytes,
  pct: Pct,
});
export type HealthDisk = z.infer<typeof HealthDiskSchema>;

export const HealthProcessSchema = z.object({
  /** Faqat bajariladigan fayl nomi (argumentsiz, yo'lsiz). */
  name: Name,
  /** Bitta yadroga nisbatan (ko'p yadroli mashinada 100 dan oshishi mumkin). */
  cpuPct: z.number().min(0).max(100 * 4096),
  memPct: Pct,
});
export type HealthProcess = z.infer<typeof HealthProcessSchema>;

export const HealthTopProcessesSchema = z.object({
  byCpu: z.array(HealthProcessSchema).max(HEALTH_LIMITS.maxTopProcesses),
  byMem: z.array(HealthProcessSchema).max(HEALTH_LIMITS.maxTopProcesses),
});
export type HealthTopProcesses = z.infer<typeof HealthTopProcessesSchema>;

export const CONTAINER_HEALTH = ['none', 'starting', 'healthy', 'unhealthy'] as const;
export const ContainerHealthSchema = z.enum(CONTAINER_HEALTH);
export type ContainerHealth = z.infer<typeof ContainerHealthSchema>;

export const HealthContainerSchema = z.object({
  name: Name,
  image: z.string().min(1).max(256),
  /** `running`, `exited`, `restarting`, `paused`, `created`, `dead`, ... (kichik harf). */
  state: z.string().min(1).max(32),
  /** `Up 3 hours (healthy)`: Docker'ning o'qiladigan holat satri. */
  status: z.string().max(160),
  restartCount: z.number().int().min(0).max(10_000_000),
  health: ContainerHealthSchema,
});
export type HealthContainer = z.infer<typeof HealthContainerSchema>;

export const HealthDockerSchema = z.object({
  /** `docker` CLI bor va agentd foydalanuvchisi daemon'ga ulana oldi. */
  available: z.boolean(),
  containers: z.array(HealthContainerSchema).max(HEALTH_LIMITS.maxContainers),
  /** `available=false` sababi (qisqa, sirsiz): `not_installed`, `no_access`, `timeout`, ... */
  reason: z.string().max(64).optional(),
});
export type HealthDocker = z.infer<typeof HealthDockerSchema>;

export const HealthSystemdSchema = z.object({
  failed: z.array(z.string().min(1).max(128)).max(HEALTH_LIMITS.maxFailedUnits),
});
export type HealthSystemd = z.infer<typeof HealthSystemdSchema>;

/** Mashinaning to'liq joriy holati (center saqlaydigan va REST qaytaradigan shakl). */
export const HealthSnapshotSchema = z.object({
  collectedAt: EpochMsSchema,
  platform: z.string().min(1).max(32),
  cpu: HealthCpuSchema,
  memory: HealthMemorySchema,
  uptimeSec: z.number().int().min(0).max(1e10),
  disks: z.array(HealthDiskSchema).max(HEALTH_LIMITS.maxDisks),
  topProcesses: HealthTopProcessesSchema,
  /** Yo'q = Docker tekshirilmagan/mavjud emas. */
  docker: HealthDockerSchema.optional(),
  /** Faqat Linux (yo'q = systemd emas). */
  systemd: HealthSystemdSchema.optional(),
});
export type HealthSnapshot = z.infer<typeof HealthSnapshotSchema>;

/**
 * `agent.health` yuki. `full`: hamma bo'lim (docker/systemd faqat tegishli bo'lsa). `delta`: cpu/memory/uptime har doim,
 * qolgan bo'limlar FAQAT o'zgargan bo'lsa (yo'q bo'lim = avvalgisi o'zgarmagan). Center delta'ni oxirgi snapshot bilan
 * birlashtiradi; snapshot'i yo'q mashina uchun delta qabul qilinadi, lekin yetishmaydigan bo'limlar bo'sh qoladi.
 */
export const AgentHealthPayloadSchema = z
  .object({
    kind: z.enum(['full', 'delta']),
    collectedAt: EpochMsSchema,
    platform: z.string().min(1).max(32),
    cpu: HealthCpuSchema,
    memory: HealthMemorySchema,
    uptimeSec: z.number().int().min(0).max(1e10),
    disks: z.array(HealthDiskSchema).max(HEALTH_LIMITS.maxDisks).optional(),
    topProcesses: HealthTopProcessesSchema.optional(),
    docker: HealthDockerSchema.optional(),
    systemd: HealthSystemdSchema.optional(),
  })
  .refine((v) => v.kind === 'delta' || (v.disks !== undefined && v.topProcesses !== undefined), {
    message: 'full snapshot requires disks and topProcesses',
  });
export type AgentHealthPayload = z.infer<typeof AgentHealthPayloadSchema>;
export const AgentHealthMessageSchema = envelopeMessage('agent.health', AgentHealthPayloadSchema);
export type AgentHealthMessage = z.infer<typeof AgentHealthMessageSchema>;

// --- holat va chegaralar -----------------------------------------------------------------------

export const HEALTH_STATUSES = ['ok', 'warn', 'critical', 'offline', 'unknown'] as const;
export const HealthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/** Sukut chegaralari (PLAN ADR 3.8). Hammasi sozlanadi: global `settings` yozuvi + mashina bo'yicha override. */
export const HealthThresholdsSchema = z.object({
  diskWarnPct: z.number().min(1).max(100),
  diskCriticalPct: z.number().min(1).max(100),
  memPct: z.number().min(1).max(100),
  memForMin: z.number().min(1).max(1440),
  cpuPct: z.number().min(1).max(100),
  cpuForMin: z.number().min(1).max(1440),
  restartLoopCount: z.number().int().min(1).max(1000),
  restartLoopWindowMin: z.number().min(1).max(1440),
  offlineAfterMin: z.number().min(1).max(10_080),
});
export type HealthThresholds = z.infer<typeof HealthThresholdsSchema>;

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  diskWarnPct: 85,
  diskCriticalPct: 95,
  memPct: 90,
  memForMin: 5,
  cpuPct: 95,
  cpuForMin: 10,
  restartLoopCount: 3,
  restartLoopWindowMin: 10,
  offlineAfterMin: 10,
};

export const HealthThresholdsPatchSchema = HealthThresholdsSchema.partial().strict();
export type HealthThresholdsPatch = z.infer<typeof HealthThresholdsPatchSchema>;

export const HealthThresholdsResponseSchema = z.object({
  defaults: HealthThresholdsSchema,
  /** Mashina id -> faqat override qilingan maydonlar. */
  machines: z.record(z.uuid(), HealthThresholdsPatchSchema),
});
export type HealthThresholdsResponse = z.infer<typeof HealthThresholdsResponseSchema>;

export const PutHealthThresholdsBodySchema = z
  .object({
    defaults: HealthThresholdsPatchSchema.optional(),
    /** `null` = shu mashinaning override'i o'chiriladi. */
    machines: z.record(z.uuid(), HealthThresholdsPatchSchema.nullable()).optional(),
  })
  .strict();
export type PutHealthThresholdsBody = z.infer<typeof PutHealthThresholdsBodySchema>;

// --- hodisalar (incident) ----------------------------------------------------------------------

export const INCIDENT_KINDS = ['disk', 'memory', 'cpu', 'container', 'systemd', 'offline'] as const;
export const IncidentKindSchema = z.enum(INCIDENT_KINDS);
export type IncidentKind = z.infer<typeof IncidentKindSchema>;

export const IncidentSeveritySchema = z.enum(['warn', 'critical']);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

export const HealthIncidentDtoSchema = z.object({
  id: z.uuid(),
  machineId: z.uuid(),
  machineName: z.string(),
  kind: IncidentKindSchema,
  /** Bitta turdagi bir nechta hodisa farqi: mount, konteyner yoki unit nomi (bo'lmasa `''`). */
  subject: z.string(),
  severity: IncidentSeveritySchema,
  summary: z.string().max(300),
  openedAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type HealthIncidentDto = z.infer<typeof HealthIncidentDtoSchema>;

export const HEALTH_RANGES = ['6h', '24h', '7d'] as const;
export const HealthRangeSchema = z.enum(HEALTH_RANGES);
export type HealthRange = z.infer<typeof HealthRangeSchema>;

export const HealthQuerySchema = z.object({ range: HealthRangeSchema.default('24h') }).strict();
export type HealthQuery = z.infer<typeof HealthQuerySchema>;

export const HealthSeriesPointSchema = z.object({
  ts: EpochMsSchema,
  cpu: z.number().nullable(),
  memPct: z.number().nullable(),
  diskMaxPct: z.number().nullable(),
});
export type HealthSeriesPoint = z.infer<typeof HealthSeriesPointSchema>;

export const MachineHealthResponseSchema = z.object({
  machineId: z.uuid(),
  range: HealthRangeSchema,
  status: HealthStatusSchema,
  /** Oxirgi snapshot (hech qachon kelmagan bo'lsa `null`). */
  latest: HealthSnapshotSchema.nullable(),
  receivedAt: z.iso.datetime({ offset: true }).nullable(),
  series: z.array(HealthSeriesPointSchema),
  /** Ochiq hodisalar + oynadagi yopilganlari (yangidan eskiga, <= 50). */
  incidents: z.array(HealthIncidentDtoSchema),
  thresholds: HealthThresholdsSchema,
});
export type MachineHealthResponse = z.infer<typeof MachineHealthResponseSchema>;

export const HealthSummaryItemSchema = z.object({
  machineId: z.uuid(),
  name: z.string(),
  online: z.boolean(),
  status: HealthStatusSchema,
  cpuPct: z.number().nullable(),
  memPct: z.number().nullable(),
  diskMaxPct: z.number().nullable(),
  diskMaxMount: z.string().nullable(),
  containersTotal: z.number().int(),
  containersBad: z.number().int(),
  failedUnits: z.number().int(),
  receivedAt: z.iso.datetime({ offset: true }).nullable(),
  openIncidents: z.number().int(),
});
export type HealthSummaryItem = z.infer<typeof HealthSummaryItemSchema>;

export const HealthSummaryResponseSchema = z.object({
  items: z.array(HealthSummaryItemSchema),
  /** Eng yomon holat (critical > warn > offline > ok; hech narsa yo'q = unknown). */
  worst: HealthStatusSchema,
});
export type HealthSummaryResponse = z.infer<typeof HealthSummaryResponseSchema>;

export const ListHealthIncidentsQuerySchema = z
  .object({
    machineId: z.uuid().optional(),
    state: z.enum(['open', 'resolved', 'all']).default('all'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListHealthIncidentsQuery = z.infer<typeof ListHealthIncidentsQuerySchema>;
export const ListHealthIncidentsResponseSchema = z.object({ items: z.array(HealthIncidentDtoSchema) });
export type ListHealthIncidentsResponse = z.infer<typeof ListHealthIncidentsResponseSchema>;

/** `machine.health` push (kanal `health`): mashinaning to'liq joriy holati (throttle: mashina bo'yicha >= 5 s). */
export const MachineHealthUpdatedMessageSchema = envelopeMessage(
  'machine.health',
  z.object({
    machineId: z.uuid(),
    status: HealthStatusSchema,
    snapshot: HealthSnapshotSchema,
    receivedAt: z.iso.datetime({ offset: true }),
  }),
);
