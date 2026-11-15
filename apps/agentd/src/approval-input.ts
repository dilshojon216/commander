import { createHash } from 'node:crypto';
import { APPROVAL_LIMITS, AskQuestionsSchema, PLAN_TOOL_NAME, QUESTION_LIMITS, QUESTION_TOOL_NAME } from '@commander/contracts';
import type { AskQuestion } from '@commander/contracts';
import { redact } from './redact.js';

const TRUNCATION_MARK = '…[kesildi]';

/** Xom tool kiritmasining barqaror matn ko'rinishi (hash va redakt shundan). */
export function serializeToolInput(toolInput: unknown): string {
  if (typeof toolInput === 'string') return toolInput;
  try {
    return JSON.stringify(toolInput ?? null) ?? 'null';
  } catch {
    return '[serializatsiya xatosi]';
  }
}

/**
 * Markazga ketadigan kiritma: AVVAL redact() (to'liq matnda: sir kesish chegarasida bo'linib qolmasin),
 * KEYIN 8192 belgigacha kesish. Hash xom matndan (sha256 hex): yaxlitlik belgisi, sir emas.
 */
export function prepareToolInput(toolInput: unknown, maxChars: number = APPROVAL_LIMITS.toolInputMaxChars): { redacted: string; hash: string } {
  const raw = serializeToolInput(toolInput);
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  let redacted = redact(raw);
  if (redacted.length > maxChars) {
    let cut = maxChars - TRUNCATION_MARK.length;
    // surrogat juftligini bo'lmaslik
    const code = redacted.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    redacted = redacted.slice(0, cut) + TRUNCATION_MARK;
  }
  return { redacted, hash };
}

/** Redakt qilingan matnni `maxChars`gacha kesadi (surrogat juftligi buzilmaydi). */
function capRedacted(redacted: string, maxChars: number): string {
  if (redacted.length <= maxChars) return redacted;
  let cut = maxChars - TRUNCATION_MARK.length;
  const code = redacted.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return redacted.slice(0, cut) + TRUNCATION_MARK;
}

/**
 * Reja matni (2.14): AVVAL redact() (to'liq matnda), KEYIN `planMaxChars` (16 KB) gacha kesish.
 * Bo'sh yoki matn bo'lmagan reja: `null`.
 */
export function preparePlan(plan: unknown, maxChars: number = APPROVAL_LIMITS.planMaxChars): string | null {
  if (typeof plan !== 'string' || plan.trim().length === 0) return null;
  return capRedacted(redact(plan), maxChars);
}

/**
 * ExitPlanMode so'rovi: `tool_input = {plan, planFilePath, ...}`. Qaytaradi: redakt qilingan reja va reja'siz (qolgan maydonlar)
 * kiritma nusxasi (reja ikki marta saqlanmasin); hash HAR DOIM to'liq xom kiritmadan (`prepareToolInput`).
 */
export function preparePlanRequest(toolName: string, toolInput: unknown): { plan: string; restInput: unknown } | null {
  if (toolName !== PLAN_TOOL_NAME || typeof toolInput !== 'object' || toolInput === null) return null;
  const { plan, ...rest } = toolInput as Record<string, unknown>;
  const prepared = preparePlan(plan);
  return prepared === null ? null : { plan: prepared, restInput: rest };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Matn maydoni: AVVAL redact(), KEYIN `max` gacha kesish (sir chegarada bo'linmasin). Matn bo'lmasa `undefined`. */
function textField(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? capRedacted(redact(v), max) : undefined;
}

/**
 * AskUserQuestion (6.13): `tool_input.questions` ni markazga ketadigan redakt qilingan, kesilgan, kontrakt shaklidagi
 * savollarga aylantiradi. Hech narsa taxmin qilinmaydi: tuzilma kutilganidan farq qilsa (savol/variant soni, matn yo'q,
 * bo'sh yorliq, noma'lum tip) `null` = masofaviy javob YO'Q, sessiya lokal dialogda qoladi.
 */
export function prepareQuestionRequest(toolName: string, toolInput: unknown): { questions: AskQuestion[] } | null {
  if (toolName !== QUESTION_TOOL_NAME || !isObj(toolInput) || !Array.isArray(toolInput['questions'])) return null;
  const rawQuestions: unknown[] = toolInput['questions'];
  if (rawQuestions.length < 1 || rawQuestions.length > QUESTION_LIMITS.maxQuestions) return null;
  const out: unknown[] = [];
  for (const rq of rawQuestions) {
    if (!isObj(rq) || !Array.isArray(rq['options'])) return null;
    const options: unknown[] = rq['options'];
    if (options.length < QUESTION_LIMITS.minOptions || options.length > QUESTION_LIMITS.maxOptions) return null;
    const question = textField(rq['question'], QUESTION_LIMITS.questionChars);
    if (!question || question.trim() === '') return null;
    const outOptions: unknown[] = [];
    for (const ro of options) {
      if (!isObj(ro)) return null;
      const label = textField(ro['label'], QUESTION_LIMITS.labelChars);
      if (!label || label.trim() === '') return null;
      const preview = textField(ro['preview'], QUESTION_LIMITS.previewChars);
      outOptions.push({
        label,
        description: textField(ro['description'], QUESTION_LIMITS.descriptionChars) ?? '',
        ...(preview !== undefined && preview !== '' ? { preview } : {}),
      });
    }
    if (rq['multiSelect'] !== undefined && typeof rq['multiSelect'] !== 'boolean') return null;
    out.push({ question, header: textField(rq['header'], QUESTION_LIMITS.headerChars) ?? '', options: outOptions, multiSelect: rq['multiSelect'] === true });
  }
  const parsed = AskQuestionsSchema.safeParse(out);
  return parsed.success ? { questions: parsed.data } : null;
}
