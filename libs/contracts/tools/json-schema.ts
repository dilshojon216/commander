import { z } from 'zod';

/**
 * Zod kontraktlaridan JSON Schema (draft 2020-12) chiqarish (task 4.1).
 *
 * Klient (Swift/Dart) kodgeneratori faqat shu JSON Schema'lardan o'qiydi. Zod -> JSON Schema: Zod v4 ning
 * o'z `z.toJSONSchema` funksiyasi; hamma eksport qilingan sxema registry'ga nomi bilan qo'shiladi
 * (nom = eksport nomi, `Schema` qo'shimchasisiz), shuning uchun umumiy tiplar `$ref` bo'ladi.
 */

/** Klientlar ishlatadigan ildiz sxemalar (eksport nomi `Schema`siz). Qolgani ularning yopilishidan keladi. */
export const OUTPUT_ROOTS: readonly string[] = [
  // umumiy
  'ApiError',
  // o'qish REST (camelCase /v1)
  'MachineDto',
  'ListMachinesResponse',
  'SessionDto',
  'ListSessionsResponseV1',
  'SessionEventDto',
  'ListSessionEventsResponseV1',
  'ProjectDto',
  'ListProjectsResponse',
  'ProjectDetailDto',
  'ListProjectCommitsResponse',
  'ProjectTasksResponse',
  'ListTasksResponse',
  'UsageResponse',
  'UsageSummaryResponse',
  'LimitsResponse',
  'LimitForecast',
  'WeeklyPace',
  'PaceSettingsResponse',
  // approvals
  'ApprovalDto',
  'ListApprovalsResponse',
  'ApprovalDecisionResponse',
  // commands
  'CommandDto',
  'CreateCommandResponse',
  'ListCommandsResponse',
  // navbat, ogohlantirishlar, salomatlik, shablonlar, orkestratsiya
  'QueueItemDto',
  'ListQueueResponse',
  'QueueDetailResponse',
  'AlertDto',
  'ListAlertsResponse',
  'HealthSummaryResponse',
  'MachineHealthResponse',
  'ListHealthIncidentsResponse',
  'TemplateDto',
  'ListTemplatesResponse',
  'RenderTemplateResponse',
  'OrchestrationDto',
  'ListOrchestrationsResponse',
  // chat
  'ChatItem',
  // klient WS protokoli (server -> klient)
  'ServerToClientMessage',
  // auth / pairing
  'ClientPairResponse',
  'ClientDeviceMeResponse',
];

/** So'rov tanalari (io='input': default'li maydonlar ixtiyoriy). */
export const INPUT_ROOTS: readonly string[] = [
  'ApprovalDecisionBody',
  'PutPaceSettingsBody',
  'PaceOverrideBody',
  'CreateCommandBody',
  'CreateQueueItemBody',
  'UpdateQueueItemBody',
  'RenderTemplateBody',
  'SendTemplatePromptBody',
  'CreateOrchestrationBody',
  'ClientPairBody',
  // klient WS protokoli (klient -> server)
  'ClientToServerMessage',
];

export interface JsonSchemaFile {
  name: string;
  /** JSON Schema hujjati (obyekt). */
  schema: Record<string, unknown>;
}

type AnyRecord = Record<string, unknown>;

function isZodType(v: unknown): v is z.ZodType {
  return typeof v === 'object' && v !== null && '_zod' in v;
}

function refsOf(node: unknown, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const x of node) refsOf(x, acc);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as AnyRecord)) {
      if (k === '$ref' && typeof v === 'string') acc.add(v.replace(/\.json$/, ''));
      else refsOf(v, acc);
    }
  }
}

/** UUID regexi shovqin; format="uuid" yetarli. Qolgan cheklovlar (min/max) saqlanadi. */
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') {
    const o: AnyRecord = {};
    const src = node as AnyRecord;
    for (const [k, v] of Object.entries(src)) {
      if (k === 'pattern' && src.format === 'uuid') continue;
      o[k] = strip(v);
    }
    return o;
  }
  return node;
}

/**
 * `ns` — contracts modul nomlar maydoni (`import * as c from ...`). Chiqish: ildizlar va ularning
 * `$ref` yopilishi, nomi bo'yicha saralangan (deterministik).
 */
export function generateJsonSchemas(ns: Record<string, unknown>): JsonSchemaFile[] {
  const named: [string, z.ZodType][] = [];
  const seen = new Set<unknown>();
  for (const key of Object.keys(ns).sort()) {
    const v = ns[key];
    if (!key.endsWith('Schema') || !isZodType(v) || seen.has(v)) continue;
    seen.add(v);
    named.push([key.slice(0, -'Schema'.length), v]);
  }
  const byName = new Map(named);
  for (const root of [...OUTPUT_ROOTS, ...INPUT_ROOTS]) {
    if (!byName.has(root)) throw new Error(`gen: ildiz sxema topilmadi: ${root}Schema`);
  }

  const run = (io: 'input' | 'output'): Record<string, AnyRecord> => {
    const reg = z.registry<{ id: string }>();
    for (const [name, schema] of named) reg.add(schema, { id: name });
    const res = z.toJSONSchema(reg, {
      target: 'draft-2020-12',
      io,
      unrepresentable: 'any',
      cycles: 'ref',
      uri: (id: string) => `${id}.json`,
    });
    return res.schemas as Record<string, AnyRecord>;
  };
  const outAll = run('output');
  const inAll = run('input');

  const result = new Map<string, AnyRecord>();
  const visit = (name: string, pool: Record<string, AnyRecord>, fallback: Record<string, AnyRecord>): void => {
    if (result.has(name)) return;
    const raw = pool[name] ?? fallback[name];
    if (!raw) throw new Error(`gen: ${name} JSON Schema'da yo'q`);
    const doc = strip(raw) as AnyRecord;
    const { $schema, $id, ...rest } = doc;
    result.set(name, { $schema, $id: `${name}.json`, title: name, ...rest });
    const deps = new Set<string>();
    refsOf(rest, deps);
    // ichki bog'liqliklar doim output rejimidan (dekodlash uchun to'liq tiplar)
    for (const d of [...deps].sort()) visit(d, outAll, inAll);
  };
  for (const r of OUTPUT_ROOTS) visit(r, outAll, inAll);
  for (const r of INPUT_ROOTS) visit(r, inAll, outAll);

  return [...result.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, schema]) => ({ name, schema }));
}

export function renderJsonSchema(file: JsonSchemaFile): string {
  return JSON.stringify(file.schema, null, 2) + '\n';
}
