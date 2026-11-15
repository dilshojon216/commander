import { CHAT_LIMITS, ChatItemSchema } from '@commander/contracts';
import type { ChatItem } from '@commander/contracts';
import { redact, redactChatText } from './redact.js';

/**
 * Claude Code transcript yozuvi (bitta JSONL qatori) -> `ChatItem[]` (sof mantiq, fayl/tarmoqsiz).
 *
 * Haqiqiy transcript'da tekshirilgan tuzilma (faqat kalitlar, matn emas):
 *  - `user`: `message.content` satr YOKI blok massivi (`text`, `tool_result{tool_use_id, content: satr | [{type:text}], is_error}`);
 *    `isMeta`, `isSidechain`, `isCompactSummary`, `uuid`, `timestamp`;
 *  - `assistant`: `message{id, model, content[thinking|text|tool_use{id,name,input}], usage{...}}`, `requestId`;
 *    BITTA so'rov bir necha yozuvga bo'linadi (bir xil `requestId`/`message.id`), usage har yozuvda (oxirgisi yakuniy);
 *  - `system/compact_boundary`; qolgan turlar (`attachment`, `api-request*`, `permission-mode`, `file-history-*`, ...) chat emas.
 *
 * MAXFIYLIK: har matn maydoni `redact*` dan o'tadi va KESISH redaktdan KEYIN bajariladi (sir chegarada bo'linmasin).
 * Hech narsa logga yozilmaydi.
 */

const TRUNC_MARK = '…[truncated]';

/** Redaktdan keyin belgilar bo'yicha kesish. */
export function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - TRUNC_MARK.length)) + TRUNC_MARK;
}

/** UTF-8 bayt bo'yicha kesish (surrogat/ko'p baytli belgi o'rtasida bo'linmaydi). */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  const mark = Buffer.from(TRUNC_MARK, 'utf8');
  let end = Math.max(0, maxBytes - mark.length);
  // UTF-8 davomiy baytlarini (10xxxxxx) tashlab, belgi chegarasiga qaytamiz
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8') + TRUNC_MARK, truncated: true };
}

const SENSITIVE_PATH =
  /(^|[\\/])(\.env(\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|[\w.-]*\.(pem|key|p12|pfx|keystore|jks)|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|\.aws[\\/]credentials)$/i;
const SAFE_ENV_SUFFIX = /\.(example|sample|template|dist)$/i;
/** Bash buyrug'i `.env` / kalit fayllarini o'qiydimi yoki muhitni chiqaradimi. */
const SENSITIVE_COMMAND =
  /(^|[\s'"=<>/\\])\.env(\.(?!example|sample|template|dist)[\w.-]+)?(?=$|[\s'";|&)])|(^|[\s;&|(])(printenv|env)(\s*$|\s*[|;&>])|\bexport\s+-p\b|id_(rsa|dsa|ecdsa|ed25519)\b|\.pem\b|\.aws[\\/]credentials|\.npmrc\b|\.netrc\b|\.git-credentials/;

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH.test(path) && !SAFE_ENV_SUFFIX.test(path);
}

export function isSensitiveToolUse(name: string, input: unknown): boolean {
  const o = asRecord(input);
  if (!o) return false;
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = str(o['file_path']) ?? str(o['notebook_path']) ?? str(o['path']);
      return p !== undefined && isSensitivePath(p);
    }
    case 'Bash': {
      const c = str(o['command']);
      return c !== undefined && SENSITIVE_COMMAND.test(c);
    }
    case 'Grep':
    case 'Glob': {
      const p = str(o['path']) ?? str(o['pattern']);
      return p !== undefined && isSensitivePath(p);
    }
    default:
      return false;
  }
}

const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const lineCount = (s: string | undefined): number => (s === undefined || s === '' ? 0 : s.split('\n').length);
const firstLine = (s: string): string => s.split('\n', 1)[0] ?? '';

/** Tool kiritmasining QISQA, redakt qilingan ko'rinishi (xom kiritma hech qachon yuborilmaydi). */
export function summarizeToolUse(name: string, input: unknown): { summary: string; lines?: { added: number; removed: number } } {
  const o = asRecord(input) ?? {};
  const cap = (s: string): string => capChars(redact(s), CHAT_LIMITS.maxSummaryChars);
  const withPath = (label: string, extra = ''): string => {
    const p = str(o['file_path']) ?? str(o['notebook_path']) ?? str(o['path']) ?? '';
    return cap(`${label}: ${p}${extra}`);
  };
  switch (name) {
    case 'Bash': {
      const cmd = str(o['command']) ?? '';
      const more = cmd.includes('\n') ? ' …' : '';
      return { summary: cap(`Bash: ${firstLine(cmd)}${more}`) };
    }
    case 'Read':
      return { summary: withPath('Read') };
    case 'Edit': {
      const added = lineCount(str(o['new_string']));
      const removed = lineCount(str(o['old_string']));
      return { summary: withPath('Edit', ` (+${added} -${removed})`), lines: { added, removed } };
    }
    case 'MultiEdit': {
      let added = 0;
      let removed = 0;
      const edits = Array.isArray(o['edits']) ? o['edits'] : [];
      for (const e of edits.slice(0, 200)) {
        const r = asRecord(e);
        if (!r) continue;
        added += lineCount(str(r['new_string']));
        removed += lineCount(str(r['old_string']));
      }
      return { summary: withPath('Edit', ` (+${added} -${removed})`), lines: { added, removed } };
    }
    case 'Write': {
      const added = lineCount(str(o['content']));
      return { summary: withPath('Write', ` (+${added})`), lines: { added, removed: 0 } };
    }
    case 'NotebookEdit':
      return { summary: withPath('NotebookEdit') };
    case 'Glob':
      return { summary: cap(`Glob: ${str(o['pattern']) ?? ''}`) };
    case 'Grep': {
      const where = str(o['path']);
      return { summary: cap(`Grep: ${str(o['pattern']) ?? ''}${where ? ` in ${where}` : ''}`) };
    }
    case 'WebFetch': {
      const raw = str(o['url']) ?? '';
      let shown = raw;
      try {
        const u = new URL(raw);
        shown = `${u.origin}${u.pathname}`; // so'rov qatori/hash tokenlari tashlanadi
      } catch {
        /* URL emas: redakt bilan qoladi */
      }
      return { summary: cap(`WebFetch: ${shown}`) };
    }
    case 'WebSearch':
      return { summary: cap(`WebSearch: ${str(o['query']) ?? ''}`) };
    case 'Task':
    case 'Agent': {
      const d = str(o['description']) ?? str(o['subagent_type']) ?? '';
      return { summary: cap(`${name}: ${d}`) };
    }
    case 'TodoWrite':
      return { summary: `TodoWrite: ${Array.isArray(o['todos']) ? o['todos'].length : 0} items` };
    default:
      // MCP va noma'lum tool'lar: faqat nom (argumentlar sirli bo'lishi mumkin)
      return { summary: cap(name) };
  }
}

interface UsageAcc {
  requestId: string;
  ts: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ConvertOptions {
  includeThinking: boolean;
}

export interface ConvertedEntry {
  items: ChatItem[];
  /** Shu yozuv usage'ini yangilagan so'rovlar (usage elementi shular uchun chiqariladi). */
  requestIds: string[];
}

const MAX_TOOL_MEMORY = 2000;
const MAX_USAGE_MEMORY = 1000;

/** `<system-reminder>...</system-reminder>` bloklarini olib tashlaydi (indexOf bilan chiziqli: regex `[\s\S]*?` yopilmagan teglarda kvadratik edi). */
function stripSystemReminders(text: string): string {
  const open = '<system-reminder>';
  const close = '</system-reminder>';
  let out = '';
  let i = 0;
  for (;;) {
    const a = text.indexOf(open, i);
    if (a < 0) return out + text.slice(i);
    const b = text.indexOf(close, a + open.length);
    if (b < 0) return out + text.slice(i); // yopilmagan: matn o'z holicha (avvalgi xatti-harakat)
    out += text.slice(i, a);
    i = b + close.length;
  }
}
const DENIED = /^(The user doesn't want to proceed|Permission to use .{1,80} has been denied|User rejected|The user rejected)/i;

function tag(text: string, name: string): string | undefined {
  const open = `<${name}>`;
  const a = text.indexOf(open);
  if (a < 0) return undefined;
  const b = text.indexOf(`</${name}>`, a + open.length);
  return b < 0 ? undefined : text.slice(a + open.length, b);
}

/**
 * Holatli konverter: bitta oqim (yoki bitta o'qish oynasi) uchun. `toolMemory` tool_use -> tool_result juftlash va
 * nozik fayl natijalarini yashirish uchun; `usage` so'rovlar bo'yicha maksimum token (oqim davomida o'sadi).
 */
export class ChatItemConverter {
  private readonly tools = new Map<string, { name: string; sensitive: boolean }>();
  private readonly usage = new Map<string, UsageAcc>();

  constructor(private readonly opts: ConvertOptions) {}

  convertLine(line: string): ConvertedEntry {
    const empty: ConvertedEntry = { items: [], requestIds: [] };
    if (line.length < 2) return empty;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return empty;
    }
    const e = asRecord(json);
    if (!e) return empty;
    if (e['isSidechain'] === true) return empty; // subagent yozuvlari asosiy oqimga kirmaydi
    const uuid = str(e['uuid']);
    if (!uuid || uuid.length > 100) return empty;
    const ts = typeof e['timestamp'] === 'string' ? Date.parse(e['timestamp']) : NaN;
    const at = Number.isFinite(ts) ? ts : 0;
    switch (e['type']) {
      case 'user':
        return { items: defined(this.user(e, uuid, at)), requestIds: [] };
      case 'assistant':
        return this.assistant(e, uuid, at);
      case 'system':
        return { items: defined(this.system(e, uuid, at)), requestIds: [] };
      default:
        return empty;
    }
  }

  /** Berilgan so'rovlar uchun joriy `usage` elementlari (yangilangan qiymat bilan qayta yuboriladi). */
  usageItems(requestIds: Iterable<string>): ChatItem[] {
    const out: MaybeItem[] = [];
    const seen = new Set<string>();
    for (const rid of requestIds) {
      if (seen.has(rid)) continue;
      seen.add(rid);
      const u = this.usage.get(rid);
      if (!u) continue;
      out.push(
        validated({
          kind: 'usage',
          id: `usage:${rid}`.slice(0, CHAT_LIMITS.maxIdChars),
          ts: u.ts,
          requestId: rid,
          ...(u.model ? { model: u.model } : {}),
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheCreationTokens: u.cacheCreationTokens,
        }),
      );
    }
    return defined(out);
  }

  // --- user ---

  private user(e: Record<string, unknown>, uuid: string, ts: number): MaybeItem[] {
    if (e['isMeta'] === true) return [];
    if (e['isCompactSummary'] === true) return []; // compact_boundary notice'i allaqachon bor
    const message = asRecord(e['message']);
    const content = message?.['content'];
    const out: MaybeItem[] = [];
    const id = (i: number): string => (i === 0 ? uuid : `${uuid}:${i}`);

    if (typeof content === 'string') {
      out.push(...this.userText(content, id(0), ts));
      return out;
    }
    if (!Array.isArray(content)) return out;
    content.slice(0, 50).forEach((raw, i) => {
      const b = asRecord(raw);
      if (!b) return;
      if (b['type'] === 'text' && typeof b['text'] === 'string') out.push(...this.userText(b['text'], id(i), ts));
      else if (b['type'] === 'tool_result') out.push(...this.toolResult(b, id(i), ts));
    });
    return out;
  }

  private userText(raw: string, id: string, ts: number): MaybeItem[] {
    const text = stripSystemReminders(raw).trim();
    if (text === '') return [];
    if (text.startsWith('[Request interrupted by user')) {
      return [validated({ kind: 'notice', id, ts, code: 'interrupted', level: 'info', text: 'Foydalanuvchi to\'xtatdi' })];
    }
    if (text.startsWith('<local-command-') || text.startsWith('<bash-stdout') || text.startsWith('<bash-stderr')) return [];
    if (text.startsWith('<ide_') || text.startsWith('<browser') || text.startsWith('<ide')) return []; // IDE/brauzer konteksti
    if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
      const name = tag(text, 'command-name') ?? '';
      const args = tag(text, 'command-args') ?? '';
      const shown = `${name} ${args}`.trim();
      if (shown === '') return [];
      return [validated({ kind: 'user', id, ts, variant: 'command', text: capChars(redactChatText(shown), CHAT_LIMITS.maxTextChars) })];
    }
    if (text.startsWith('<bash-input>')) {
      const cmd = tag(text, 'bash-input') ?? '';
      return [validated({ kind: 'user', id, ts, variant: 'shell', text: capChars(redactChatText(`!${cmd}`), CHAT_LIMITS.maxTextChars) })];
    }
    if (text.startsWith('<task-notification')) {
      const summary = tag(text, 'summary') ?? 'Fon vazifa bildirishnomasi';
      return [validated({ kind: 'user', id, ts, variant: 'task', text: capChars(redactChatText(summary.trim()), 500) })];
    }
    return [validated({ kind: 'user', id, ts, text: capChars(redactChatText(text), CHAT_LIMITS.maxTextChars) })];
  }

  private toolResult(b: Record<string, unknown>, id: string, ts: number): MaybeItem[] {
    const toolUseId = str(b['tool_use_id']);
    if (!toolUseId) return [];
    const known = this.tools.get(toolUseId);
    const ok = b['is_error'] !== true;
    const content = b['content'];
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .slice(0, 50)
        .map((c) => {
          const r = asRecord(c);
          return r && r['type'] === 'text' && typeof r['text'] === 'string' ? r['text'] : '';
        })
        .filter((s) => s !== '')
        .join('\n');
    }
    const out: MaybeItem[] = [];
    if (!ok && DENIED.test(text.trim())) {
      out.push(validated({ kind: 'notice', id: `${id}:denied`, ts, code: 'denied', level: 'info', text: 'Ruxsat rad etildi' }));
    }
    let shown: string;
    if (known?.sensitive) shown = '[REDACTED: sensitive file or environment output]';
    else shown = redactChatText(stripSystemReminders(text));
    // Avval redakt, KEYIN baytga kesish
    const capped = capBytes(shown, CHAT_LIMITS.maxToolResultBytes);
    out.push(
      validated({
        kind: 'tool_result',
        id,
        ts,
        toolUseId: toolUseId.slice(0, CHAT_LIMITS.maxIdChars),
        ...(known ? { toolName: known.name.slice(0, CHAT_LIMITS.maxToolNameChars) } : {}),
        ok,
        text: capped.text,
        truncated: capped.truncated,
      }),
    );
    return out;
  }

  // --- assistant ---

  private assistant(e: Record<string, unknown>, uuid: string, ts: number): ConvertedEntry {
    const message = asRecord(e['message']);
    if (!message) return { items: [], requestIds: [] };
    const model = str(message['model']);
    const content = message['content'];
    const items: MaybeItem[] = [];
    const id = (i: number): string => (i === 0 ? uuid : `${uuid}:${i}`);

    if (model === '<synthetic>') {
      // API xatosi xabari bo'lsa foydalanuvchiga ko'rsatiladi, boshqa sintetik yozuvlar (masalan "No response requested") tashlanadi
      if (e['isApiErrorMessage'] === true) {
        const t = Array.isArray(content) ? content.map((c) => str(asRecord(c)?.['text']) ?? '').join('\n') : (str(content) ?? '');
        if (t.trim() !== '') items.push(validated({ kind: 'notice', id: uuid, ts, code: 'error', level: 'error', text: capChars(redactChatText(t.trim()), CHAT_LIMITS.maxNoticeChars) }));
      }
      return { items: defined(items), requestIds: [] };
    }

    const requestId = (str(e['requestId']) ?? str(message['id']))?.slice(0, CHAT_LIMITS.maxIdChars);
    const reqField = requestId ? { requestId } : {};
    const modelField = model ? { model: model.slice(0, 128) } : {};

    if (typeof content === 'string') {
      if (content.trim() !== '') items.push(validated({ kind: 'assistant', id: id(0), ts, text: capChars(redactChatText(content), CHAT_LIMITS.maxTextChars), ...reqField, ...modelField }));
    } else if (Array.isArray(content)) {
      content.slice(0, 50).forEach((raw, i) => {
        const b = asRecord(raw);
        if (!b) return;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          if (b['text'].trim() === '') return;
          items.push(validated({ kind: 'assistant', id: id(i), ts, text: capChars(redactChatText(b['text']), CHAT_LIMITS.maxTextChars), ...reqField, ...modelField }));
        } else if (b['type'] === 'thinking' && this.opts.includeThinking && typeof b['thinking'] === 'string') {
          if (b['thinking'].trim() === '') return;
          items.push(validated({ kind: 'thinking', id: id(i), ts, text: capChars(redactChatText(b['thinking']), CHAT_LIMITS.maxThinkingChars), ...reqField }));
        } else if (b['type'] === 'tool_use') {
          const toolUseId = str(b['id']);
          const name = str(b['name']);
          if (!toolUseId || !name) return;
          this.rememberTool(toolUseId, name, isSensitiveToolUse(name, b['input']));
          const s = summarizeToolUse(name, b['input']);
          items.push(
            validated({
              kind: 'tool_use',
              id: id(i),
              ts,
              toolUseId: toolUseId.slice(0, CHAT_LIMITS.maxIdChars),
              toolName: name.slice(0, CHAT_LIMITS.maxToolNameChars),
              summary: s.summary,
              ...(s.lines ? { lines: s.lines } : {}),
              ...reqField,
            }),
          );
        }
      });
    }

    const requestIds: string[] = [];
    const usage = asRecord(message['usage']);
    if (requestId && usage) {
      this.mergeUsage(requestId, ts, model, usage);
      requestIds.push(requestId);
    }
    return { items: defined(items), requestIds };
  }

  private mergeUsage(requestId: string, ts: number, model: string | undefined, u: Record<string, unknown>): void {
    const n = (k: string): number => {
      const v = u[k];
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    };
    const prev = this.usage.get(requestId);
    const next: UsageAcc = {
      requestId,
      ts: Math.max(prev?.ts ?? 0, ts),
      ...(model ? { model: model.slice(0, 128) } : prev?.model ? { model: prev.model } : {}),
      inputTokens: Math.max(prev?.inputTokens ?? 0, n('input_tokens')),
      outputTokens: Math.max(prev?.outputTokens ?? 0, n('output_tokens')),
      cacheReadTokens: Math.max(prev?.cacheReadTokens ?? 0, n('cache_read_input_tokens')),
      cacheCreationTokens: Math.max(prev?.cacheCreationTokens ?? 0, n('cache_creation_input_tokens')),
    };
    this.usage.delete(requestId);
    this.usage.set(requestId, next); // eng yangi oxirida (LRU)
    if (this.usage.size > MAX_USAGE_MEMORY) {
      const oldest = this.usage.keys().next().value;
      if (oldest !== undefined) this.usage.delete(oldest);
    }
  }

  private rememberTool(id: string, name: string, sensitive: boolean): void {
    this.tools.set(id, { name, sensitive });
    if (this.tools.size > MAX_TOOL_MEMORY) {
      const oldest = this.tools.keys().next().value;
      if (oldest !== undefined) this.tools.delete(oldest);
    }
  }

  // --- system ---

  private system(e: Record<string, unknown>, uuid: string, ts: number): MaybeItem[] {
    const sub = str(e['subtype']);
    if (sub === 'compact_boundary') {
      return [validated({ kind: 'notice', id: uuid, ts, code: 'compact', level: 'info', text: 'Kontekst siqildi (compact)' })];
    }
    if (sub === 'api_error' || (sub === 'informational' && e['level'] === 'error')) {
      const t = str(e['content']) ?? 'Xato';
      return [validated({ kind: 'notice', id: uuid, ts, code: 'error', level: 'error', text: capChars(redactChatText(t), CHAT_LIMITS.maxNoticeChars) })];
    }
    return [];
  }
}

/** Kontrakt bo'yicha tekshiradi; yaroqsiz bo'lsa `undefined` (qator tashlanadi, markaz xabarni butunlay rad etmasin). */
function validated(item: unknown): ChatItem | undefined {
  const r = ChatItemSchema.safeParse(item);
  return r.success ? r.data : undefined;
}

type MaybeItem = ChatItem | undefined;
const defined = (list: MaybeItem[]): ChatItem[] => list.filter((x): x is ChatItem => x !== undefined);
