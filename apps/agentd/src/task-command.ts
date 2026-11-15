import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `/task <id>` buyrug'i (task 2.9). Jonli tekshiruv (Claude Code 2.1.304, macOS): ANIQLANMAGAN slash buyruq interaktiv
 * rejimda "Unknown command" bo'ladi va UserPromptSubmit hook'i UMUMAN ISHLAMAYDI (`claude -p` da esa xom matn bilan ishlaydi).
 * Shuning uchun foydalanuvchi darajasidagi buyruq fayli kerak: `~/.claude/commands/task.md` bo'lsa hook xom `/task 1.4` ni ko'radi
 * (tasdiqlangan), Claude esa faqat qisqa tasdiq beradi. agentd uni ishga tushganda yaratadi (yo'q bo'lsa) yoki eski managed
 * versiyani yangilaydi; foydalanuvchining o'z `task.md`siga tegmaydi.
 */
export const TASK_COMMAND_VERSION = 1;
export const TASK_COMMAND_MARKER = 'commander:managed task-command';

export const TASK_COMMAND_TEXT = `---
description: Commander - joriy vazifa id'sini belgilash (token statistikasi shu vazifaga yoziladi)
argument-hint: <vazifa id, masalan 1.4>
---
<!-- ${TASK_COMMAND_MARKER} v${TASK_COMMAND_VERSION} (agentd yangilaydi; qo'lda o'zgartirsangiz agentd tegmaydi) -->
Foydalanuvchi joriy vazifani belgiladi: $ARGUMENTS

Faqat bitta qisqa qator bilan tasdiqlang ("Vazifa $ARGUMENTS belgilandi") va foydalanuvchining keyingi so'rovini kuting. Hech qanday asbob ishlatmang va fayllarni o'qimang.
`;

export type TaskCommandResult = 'created' | 'updated' | 'kept' | 'error';

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
}

/** Idempotent. Xato tashlamaydi (agentd ishga tushishiga to'sqinlik qilmasin): `error` qaytaradi. */
export function ensureTaskCommand(claudeDir: string = claudeConfigDir()): TaskCommandResult {
  try {
    const dir = join(claudeDir, 'commands');
    const file = join(dir, 'task.md');
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, TASK_COMMAND_TEXT, 'utf8');
      return 'created';
    }
    const current = readFileSync(file, 'utf8');
    const m = new RegExp(`${TASK_COMMAND_MARKER} v(\\d+)`).exec(current);
    if (!m) return 'kept'; // foydalanuvchining o'z buyrug'i
    if (Number(m[1]) >= TASK_COMMAND_VERSION) return 'kept';
    writeFileSync(file, TASK_COMMAND_TEXT, 'utf8');
    return 'updated';
  } catch {
    return 'error';
  }
}
