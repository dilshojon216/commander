/**
 * Sintetik transcript yozuvlari: haqiqiy Claude Code transcript tuzilmasiga o'xshash (kalitlar real fayldan olingan:
 * `uuid`, `timestamp`, `isSidechain`, `isMeta`, `requestId`, `message{id,model,content,usage}`, `type`, `subtype`).
 * Mazmun to'liq to'qilgan; hech qanday real ma'lumot yo'q.
 */
let n = 0;
const uid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const iso = (t: number): string => new Date(1_700_000_000_000 + t * 1000).toISOString();

export const line = (o: unknown): string => JSON.stringify(o);

export function userPrompt(text: string, t = 1, extra: Record<string, unknown> = {}) {
  return { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: uid(), timestamp: iso(t), sessionId: 's1', ...extra };
}

export function userBlocks(blocks: unknown[], t = 1, extra: Record<string, unknown> = {}) {
  return { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: blocks }, uuid: uid(), timestamp: iso(t), sessionId: 's1', ...extra };
}

export function toolResult(toolUseId: string, content: unknown, isError = false, t = 3) {
  return userBlocks([{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }], t, { toolUseResult: { stdout: 'x' } });
}

export function assistant(blocks: unknown[], opts: { requestId?: string; msgId?: string; model?: string; usage?: Record<string, number>; t?: number; extra?: Record<string, unknown> } = {}) {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    requestId: opts.requestId ?? 'req_A',
    message: {
      id: opts.msgId ?? 'msg_A',
      type: 'message',
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-5-5',
      content: blocks,
      stop_reason: null,
      usage: opts.usage ?? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
    },
    uuid: uid(),
    timestamp: iso(opts.t ?? 2),
    sessionId: 's1',
    ...(opts.extra ?? {}),
  };
}

export const text = (t: string) => ({ type: 'text', text: t });
export const thinking = (t: string) => ({ type: 'thinking', thinking: t, signature: 'sig' });
export const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

export function system(subtype: string, extra: Record<string, unknown> = {}, t = 4) {
  return { parentUuid: null, isSidechain: false, type: 'system', subtype, uuid: uid(), timestamp: iso(t), sessionId: 's1', ...extra };
}

/** Chat bo'lmagan shovqin yozuvlari (real faylda ko'p). */
export const noise = [
  { type: 'permission-mode', permissionMode: 'default', sessionId: 's1' },
  { type: 'file-history-snapshot', messageId: 'x', snapshot: {}, isSnapshotUpdate: false },
  { type: 'api-request', sessionId: 's1', id: 'r', params: {} },
  { type: 'attachment', uuid: uid(), timestamp: iso(1), attachment: { type: 'hook_success' } },
];
