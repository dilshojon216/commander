import { open } from 'node:fs/promises';
import { SUMMARY_LIMITS, buildSessionSummaryPrompt } from '@commander/contracts';
import type { ChatItem, SessionSummaryPromptInput } from '@commander/contracts';
import { ChatItemConverter, capChars, isSensitivePath } from './chat-items.js';
import { redact, redactChatText } from './redact.js';

/**
 * Sessiya xulosasi uchun KIRISH quruvchi (6.1; sof mantiq + bitta fayl o'qish). Transcript mashinadan chiqmaydi: bu modul
 * faqat LOKAL haiku'ga beriladigan qisqartirilgan matnni quradi.
 *
 * Kirishga FAQAT: foydalanuvchi promptlarining birinchi qatorlari, vosita chaqiruvlarining qisqa ko'rinishi (natijasiz),
 * o'zgargan fayl yo'llari va oxirgi assistant xabari tushadi. `tool_result` (xom natijalar), thinking, usage matni,
 * `.env`/kalit fayllariga tegadigan chaqiruvlar HECH QACHON kirmaydi. Har matn qo'shimcha `redact` dan o'tadi
 * (konverter ham redakt qiladi: ikki qavatli); jami hajm `SUMMARY_LIMITS.inputMaxChars` bilan cheklanadi.
 */

/** Transcript to'liq o'qiladigan eng katta hajm; kattaroq bo'lsa bosh + dum o'qiladi. */
export const MAX_FULL_READ_BYTES = 24 * 1024 * 1024;
const HEAD_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;

const PROMPT_FIRST_LINE_CHARS = 240;
const MAX_PROMPTS = 24;
const MAX_TOOL_LINES = 60;
const TOOL_LINE_CHARS = 200;
const LAST_ASSISTANT_CHARS = 3000;
const MUTATING = /^(Edit|Write|NotebookEdit): (.+?)(?: \(\+\d+(?: -\d+)?\))?$/;
const SENSITIVE_BASH = /(^|[\s'"=<>/\\])\.env\b|\b(printenv|id_rsa|id_ed25519|credentials)\b|\.pem\b|\.npmrc\b|\.netrc\b|\.aws[\\/]/;

export interface SummaryStats {
  promptCount: number;
  /** kirish + chiqish + kesh yozish (kesh o'qish KIRMAYDI). */
  tokens: number;
}

export interface SummaryInputResult {
  input: SessionSummaryPromptInput;
  /** Tayyor prompt (`buildSessionSummaryPrompt`), <= `inputMaxChars`. */
  prompt: string;
  stats: SummaryStats;
}

const firstLine = (s: string): string => s.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

/** `ChatItem[]` (allaqachon redakt qilingan) -> kirish (sof, testlanadi). */
export function buildSummaryInput(items: readonly ChatItem[], project: string): SummaryInputResult {
  const prompts: string[] = [];
  const toolLines: Array<{ text: string; mutating: boolean }> = [];
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const usage = new Map<string, number>();
  let promptCount = 0;
  let lastAssistant = '';

  for (const it of items) {
    switch (it.kind) {
      case 'user': {
        if (it.variant === 'shell' || it.variant === 'task') break;
        promptCount += 1;
        if (prompts.length < MAX_PROMPTS) {
          const line = capChars(redact(firstLine(it.text)), PROMPT_FIRST_LINE_CHARS);
          if (line !== '') prompts.push(line);
        }
        break;
      }
      case 'assistant':
        if (it.text.trim() !== '') lastAssistant = it.text;
        break;
      case 'tool_use': {
        const summary = redact(it.summary);
        const m = MUTATING.exec(summary);
        if (m) {
          const path = m[2] ?? '';
          if (isSensitivePath(path)) break;
          if (!seenFiles.has(path) && files.length < SUMMARY_LIMITS.filesMaxItems * 2) {
            seenFiles.add(path);
            files.push(capChars(path, SUMMARY_LIMITS.fileMaxChars));
          }
          toolLines.push({ text: capChars(summary, TOOL_LINE_CHARS), mutating: true });
          break;
        }
        if (summary.startsWith('Read: ') && isSensitivePath(summary.slice(6))) break;
        if (summary.startsWith('Bash: ') && SENSITIVE_BASH.test(summary)) break;
        const prev = toolLines[toolLines.length - 1];
        if (prev && prev.text === summary) break;
        toolLines.push({ text: capChars(summary, TOOL_LINE_CHARS), mutating: false });
        break;
      }
      case 'usage':
        // so'rov bo'yicha maksimum (oqim davomida o'sadi)
        usage.set(it.requestId, Math.max(usage.get(it.requestId) ?? 0, it.inputTokens + it.outputTokens + it.cacheCreationTokens));
        break;
      default:
        break; // tool_result, thinking, notice: kirishga KIRMAYDI
    }
  }

  let tokens = 0;
  for (const v of usage.values()) tokens += v;

  // O'zgartirish chaqiruvlari ustuvor; qolganlardan oxirgilari.
  const mutating = toolLines.filter((t) => t.mutating).map((t) => t.text);
  const other = toolLines.filter((t) => !t.mutating).map((t) => t.text);
  let tools = [...mutating.slice(-40), ...other.slice(-(MAX_TOOL_LINES - Math.min(40, mutating.length)))].slice(0, MAX_TOOL_LINES);
  let shownPrompts = prompts;
  let last = capChars(redactChatText(lastAssistant), LAST_ASSISTANT_CHARS);
  const shownFiles = files.slice(-SUMMARY_LIMITS.filesMaxItems);

  const make = (): { input: SessionSummaryPromptInput; prompt: string } => {
    const input: SessionSummaryPromptInput = { project: capChars(redact(project), 120), prompts: shownPrompts, tools, files: shownFiles, lastAssistant: last, promptCount };
    return { input, prompt: buildSessionSummaryPrompt(input) };
  };
  let built = make();
  // Hajmga sig'dirish: avval vosita qatorlari, so'ng promptlar, so'ng oxirgi javob qisqaradi.
  while (built.prompt.length > SUMMARY_LIMITS.inputMaxChars && (tools.length > 8 || shownPrompts.length > 6 || last.length > 600)) {
    if (tools.length > 8) tools = tools.slice(-Math.max(8, Math.floor(tools.length * 0.7)));
    else if (shownPrompts.length > 6) shownPrompts = [...shownPrompts.slice(0, 3), ...shownPrompts.slice(-Math.max(3, Math.floor((shownPrompts.length - 3) * 0.7)))];
    else last = capChars(last, Math.max(600, Math.floor(last.length * 0.6)));
    built = make();
  }
  const prompt = built.prompt.length > SUMMARY_LIMITS.inputMaxChars ? built.prompt.slice(0, SUMMARY_LIMITS.inputMaxChars) : built.prompt;
  return { input: built.input, prompt, stats: { promptCount, tokens } };
}

/** Transcript JSONL'ni (kattasi bo'lsa bosh + dum) `ChatItem[]`ga aylantiradi. Fayl o'qilmasa `null`. */
export async function readTranscriptItems(path: string): Promise<{ items: ChatItem[]; size: number } | null> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = (await fh.stat()).size;
    const conv = new ChatItemConverter({ includeThinking: false });
    const items: ChatItem[] = [];
    const requestIds = new Set<string>();
    const feed = (buf: Buffer, dropFirstPartial: boolean): void => {
      let start = 0;
      if (dropFirstPartial) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        start = nl + 1;
      }
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        const end = nl === -1 ? buf.length : nl;
        if (end - start > 1 && end - start <= MAX_LINE_BYTES) {
          const e = conv.convertLine(buf.toString('utf8', start, end));
          items.push(...e.items);
          for (const r of e.requestIds) requestIds.add(r);
        }
        if (nl === -1) break;
        start = nl + 1;
      }
    };
    const readAt = async (pos: number, len: number): Promise<Buffer> => {
      const b = Buffer.alloc(len);
      const { bytesRead } = await fh.read(b, 0, len, pos);
      return b.subarray(0, bytesRead);
    };
    if (size <= MAX_FULL_READ_BYTES) feed(await readAt(0, size), false);
    else {
      feed(await readAt(0, HEAD_BYTES), false);
      feed(await readAt(size - TAIL_BYTES, TAIL_BYTES), true);
    }
    items.push(...conv.usageItems(requestIds));
    return { items, size };
  } finally {
    await fh.close();
  }
}
