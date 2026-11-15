import { PERMISSION_DEADLINE } from '@commander/contracts/ipc';
import { readStdin, resolveSocketPath, sendToAgentd } from './socket.js';

/**
 * `cc-hook`: Claude Code hook'ining stdin JSON'ini agentd socket'iga uzatadi.
 *
 * FAIL-SAFE (CLAUDE.md qoida 4): har qanday xatoda (socket yo'q, agentd javob bermaydi, noto'g'ri JSON) jim chiqadi,
 * exit kodi har doim 0, status hook'lari stdout'ga HECH NARSA yozmaydi. Hech qachon `allow` chiqarmaydi.
 *
 * Rejimlar:
 *   cc-hook            status hook (SessionStart, UserPromptSubmit, PreToolUse, Notification, Stop, SessionEnd)
 *   cc-hook --inbox   UserPromptSubmit (SINXRON, 5 s, task 2.10): agentd'dan shu sessiyaga yetkazilmagan hamkasb xabarlarini oladi va
 *                      `hookSpecificOutput.additionalContext` sifatida (ramkali: "foydalanuvchi buyrug'i emas") chiqaradi.
 *                      Xato/offline/xabar yo'q = stdout BO'SH + exit 0 (tez, fail-safe).
 *   cc-hook --inbox-stop   Stop (SINXRON, 5 s): auto-wake yoqilgan guruhda yetkazilmagan xabar bo'lsa BIR MARTA
 *                      `{"decision":"block","reason":...}` chiqaradi (xabarlar center'da shu paytda "yetkazildi" bo'ladi, shuning uchun
 *                      ikkinchi Stop'da bloklanmaydi). `stop_hook_active=true` bo'lsa umuman so'ramaydi (sikl yo'q).
 *   cc-hook --permission [--deadline-ms=N]   PermissionRequest hook (remote permission, task 1.7): so'rovni agentd'ga
 *                      yuboradi va markaz qarorini deadline'gacha (sukut 300 s, `COMMANDER_PERMISSION_DEADLINE_MS` yoki
 *                      `--deadline-ms`) kutadi. FAQAT center'dan kelgan aniq `allow`/`deny` stdout'ga chiqadi; boshqa hamma
 *                      holatda (deadline, offline, agentd yo'q, buzuq javob) stdout BO'SH + exit 0 = Claude lokal promptga qaytadi.
 *                      "Always allow" / updatedPermissions HECH QACHON chiqarilmaydi. `updatedInput` FAQAT AskUserQuestion uchun
 *                      (task 6.13): center'dan kelgan javob indekslari O'Z xom `tool_input`imizga (asl savol/yorliqlar) moslanib
 *                      `answers` xaritasi yasaladi; moslashmasa/yetarli bo'lmasa stdout BO'SH (lokal dialog). Hech qachon avto-javob yo'q.
 *
 * UserPromptSubmit stdout sxemasi (code.claude.com/docs/en/hooks; Claude Code 2.1.304'da jonli tekshirilgan):
 *   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}
 * Stop stdout sxemasi: {"decision":"block","reason":"..."}
 *
 * PermissionRequest stdout sxemasi (code.claude.com/docs/en/hooks, 2026-11-13 tekshirilgan; CC 2.1.304):
 *   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
 *   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"..."}}}
 *   AskUserQuestion (JONLI TEKSHIRILGAN 2.1.304): decision {"behavior":"allow","updatedInput":{...tool_input,"answers":{"<savol>":"<javob>"}}}
 */
export type HookMode = 'status' | 'permission' | 'inbox' | 'inbox-stop';

export const STATUS_TIMEOUT_MS = 400;
const STDIN_TIMEOUT_MS = 2000;
const STDIN_MAX_BYTES = 1024 * 1024;

export function parseMode(argv: string[]): HookMode {
  if (argv.includes('--permission')) return 'permission';
  if (argv.includes('--inbox-stop')) return 'inbox-stop';
  if (argv.includes('--inbox')) return 'inbox';
  return 'status';
}

/** Kontekstga tushadigan matnning mutlaq chegarasi (center ~6 KB beradi; bu himoya). */
const INBOX_MAX_CHARS = 8000;
const INBOX_TIMEOUT_MS = 4500;
const STOP_REASON_PREFIX = "Yangi hamkasb xabarlari keldi. Ularni ko'rib chiqing va kerak bo'lsa commander_send_message bilan javob bering, so'ng ishni davom ettiring:\n";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** agentd javobidagi matn (`ok:true`, `data.text` bo'sh emas, `data.count > 0`) yoki `null`. */
function inboxText(reply: unknown): string | null {
  if (!isObj(reply) || reply['ok'] !== true || !isObj(reply['data'])) return null;
  const { text, count } = reply['data'];
  if (typeof text !== 'string' || text.trim() === '' || typeof count !== 'number' || count <= 0) return null;
  return text.length > INBOX_MAX_CHARS ? `${text.slice(0, INBOX_MAX_CHARS)}…` : text;
}

/** UserPromptSubmit chiqishi: faqat tekshirilgan matn `additionalContext`ga tushadi. */
export function renderInboxOutput(reply: unknown): string | null {
  const text = inboxText(reply);
  return text === null ? null : JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
}

/** Stop chiqishi: bir martalik blok (sabab = ramkali matn). */
export function renderInboxStopOutput(reply: unknown): string | null {
  const text = inboxText(reply);
  return text === null ? null : JSON.stringify({ decision: 'block', reason: `${STOP_REASON_PREFIX}${text}` });
}

const MAX_DENY_MESSAGE = 1000;

const QUESTION_TOOL = 'AskUserQuestion';

/**
 * AskUserQuestion javoblarini (indekslar) xom `tool_input`ga moslab `answers` xaritasini (savol matni -> javob matni) yasaydi.
 * Qat'iy: har savolga aniq bitta javob, indekslar chegarada va takrorsiz, bir tanlovli savolda faqat bitta tanlov (variant
 * YOKI erkin matn), savol matnlari takrorlanmaydi (xarita kaliti noaniq bo'lmasin). Birortasi buzilsa `null` (lokal dialog).
 * multiSelect javobi "A, B" (vergul + bo'sh joy): jonli tekshirilgan format; erkin matn oxirida qo'shiladi.
 */
export function buildQuestionAnswers(toolInput: unknown, answers: unknown): Record<string, string> | null {
  if (!isObj(toolInput) || !Array.isArray(toolInput['questions']) || !Array.isArray(answers)) return null;
  const questions: unknown[] = toolInput['questions'];
  if (questions.length === 0 || answers.length !== questions.length) return null;
  const seenQ = new Set<number>();
  const byQ = new Map<number, Record<string, unknown>>();
  for (const a of answers as unknown[]) {
    if (!isObj(a) || typeof a['q'] !== 'number' || !Number.isInteger(a['q']) || a['q'] < 0 || a['q'] >= questions.length || seenQ.has(a['q'])) return null;
    seenQ.add(a['q']);
    byQ.set(a['q'], a);
  }
  const out: Record<string, string> = {};
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const a = byQ.get(i);
    if (!isObj(q) || !a || typeof q['question'] !== 'string' || q['question'] === '' || !Array.isArray(q['options'])) return null;
    if (Object.hasOwn(out, q['question'])) return null;
    const options: unknown[] = q['options'];
    const picks = a['picks'];
    if (!Array.isArray(picks)) return null;
    const parts: string[] = [];
    const seenPick = new Set<number>();
    for (const p of [...(picks as unknown[])].sort((x, y) => Number(x) - Number(y))) {
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p >= options.length || seenPick.has(p)) return null;
      seenPick.add(p);
      const o = options[p];
      if (!isObj(o) || typeof o['label'] !== 'string' || o['label'] === '') return null;
      parts.push(o['label']);
    }
    const other = a['other'];
    if (other !== undefined) {
      if (typeof other !== 'string') return null;
      const t = other.trim();
      if (t !== '') parts.push(t);
    }
    if (parts.length === 0 || (q['multiSelect'] !== true && parts.length > 1)) return null;
    out[q['question']] = parts.join(', ');
  }
  return out;
}

/**
 * agentd javobini Claude Code kutadigan stdout JSON'iga aylantiradi. QAT'IY: faqat `ok === true` va
 * `decision.behavior` aynan 'allow' | 'deny' bo'lsa matn qaytadi; boshqa HAR QANDAY kirish (null, buzuq, noma'lum maydon,
 * `ok:false`) `null` = chiqish yo'q = lokal prompt. Chiqish faqat behavior (+ deny uchun message) dan quriladi:
 * agentd javobidagi boshqa maydonlar (updatedPermissions, interrupt) hech qachon o'tmaydi.
 * ISTISNO (6.13): AskUserQuestion `allow` faqat to'g'ri `answers` bilan chiqadi (`updatedInput` = xom tool_input + `answers`);
 * javobsiz yoki mos kelmaydigan `allow` = chiqish yo'q (lokal dialog): savol hech qachon jim `allow` qilinmaydi.
 */
export function renderPermissionOutput(reply: unknown, hookPayload?: unknown): string | null {
  if (typeof reply !== 'object' || reply === null) return null;
  const r = reply as Record<string, unknown>;
  if (r['ok'] !== true) return null;
  const d = r['decision'];
  if (typeof d !== 'object' || d === null) return null;
  const behavior = (d as Record<string, unknown>)['behavior'];
  if (behavior === 'allow') {
    if (isObj(hookPayload) && hookPayload['tool_name'] === QUESTION_TOOL) {
      const toolInput = hookPayload['tool_input'];
      const map = buildQuestionAnswers(toolInput, (d as Record<string, unknown>)['answers']);
      if (map === null || !isObj(toolInput)) return null;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...toolInput, answers: map } } } });
    }
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  }
  if (behavior === 'deny') {
    const m = (d as Record<string, unknown>)['message'];
    const message = typeof m === 'string' && m.trim() ? m.slice(0, MAX_DENY_MESSAGE) : 'Commander: masofadan rad etildi';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } });
  }
  return null;
}

/** `--deadline-ms=N` > env > sukut; chegaralangan (agentd ham xuddi shunday chegaralaydi). */
export function resolveDeadlineMs(argv: string[], env: NodeJS.ProcessEnv): number {
  const arg = argv.find((a) => a.startsWith('--deadline-ms='))?.slice('--deadline-ms='.length);
  const raw = Number(arg ?? env['COMMANDER_PERMISSION_DEADLINE_MS']);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : PERMISSION_DEADLINE.defaultMs;
  return Math.min(PERMISSION_DEADLINE.maxMs, Math.max(PERMISSION_DEADLINE.minMs, n));
}

/** agentd o'z deadline'ida javob beradi; bu zaxira: agentd qotib qolsa ham cc-hook deadline + shu vaqtdan keyin chiqadi. */
export const PERMISSION_SLACK_MS = 2000;

export interface RunHookIo {
  stdin: NodeJS.ReadableStream;
  stdout: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  socketPath?: string;
}

/** Natija har doim exit kodi 0. */
export async function runCcHook(argv: string[], io: RunHookIo): Promise<0> {
  try {
    const mode = parseMode(argv);
    const raw = await readStdin(io.stdin, STDIN_MAX_BYTES, STDIN_TIMEOUT_MS);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return 0;
    }
    const socketPath = io.socketPath ?? resolveSocketPath(io.env);
    if (mode === 'inbox' || mode === 'inbox-stop') {
      if (!isObj(payload)) return 0;
      const event = payload['hook_event_name'];
      const sessionId = payload['session_id'];
      if (typeof sessionId !== 'string' || !sessionId) return 0;
      if (payload['agent_id']) return 0; // subagent
      if (mode === 'inbox' && event !== 'UserPromptSubmit') return 0;
      // Sikl himoyasi: Stop-hook avval davom ettirgan bo'lsa qayta bloklamaymiz (so'ramaymiz ham).
      if (mode === 'inbox-stop' && (event !== 'Stop' || payload['stop_hook_active'] === true)) return 0;
      const cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : undefined;
      const reply = await sendToAgentd(
        socketPath,
        { v: 1, kind: 'mailbox', payload: { sessionId, ...(cwd ? { cwd } : {}), call: { op: mode === 'inbox' ? 'deliver' : 'stop_check' } } },
        { timeoutMs: INBOX_TIMEOUT_MS, waitReply: true },
      );
      const out = mode === 'inbox' ? renderInboxOutput(reply) : renderInboxStopOutput(reply);
      if (out) io.stdout.write(out);
      return 0;
    }
    if (mode === 'permission') {
      const deadlineMs = resolveDeadlineMs(argv, io.env);
      const reply = await sendToAgentd(
        socketPath,
        { v: 1, kind: 'permission', payload, deadlineMs },
        { timeoutMs: deadlineMs + PERMISSION_SLACK_MS, waitReply: true },
      );
      const out = renderPermissionOutput(reply, payload);
      if (out) io.stdout.write(out);
      return 0;
    }
    await sendToAgentd(socketPath, { v: 1, kind: 'hook', payload }, { timeoutMs: STATUS_TIMEOUT_MS, waitReply: false });
  } catch {
    /* fail-safe */
  }
  return 0;
}
