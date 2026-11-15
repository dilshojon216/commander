/**
 * Prompt shablonlarini render qilish (3.4): sof funksiyalar, IO yo'q. Markaz (haqiqiy render), dashboard (o'zgaruvchilar
 * yordami) va Telegram bir xil qoidadan foydalanadi.
 *
 * Sintaksis: `{{nom}}` (atrofida bo'sh joy mumkin: `{{ nom }}`). Literal `{{` kerak bo'lsa `\{{` yoziladi (natijada `{{`).
 * Render BIR O'TISHLI: o'zgaruvchi qiymati ichidagi `{{...}}` qayta kengaytirilmaydi (qiymatdagi matn orqali in'ektsiya yo'q).
 */

export const TEMPLATE_VARIABLES = ['task_key', 'task_title', 'branch', 'project', 'date'] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** O'zbekcha izoh (dashboard yordam jadvali va Telegram). */
export const TEMPLATE_VARIABLE_HELP: Record<TemplateVariable, string> = {
  task_key: 'Vazifa id\'si (masalan 3.4)',
  task_title: 'Vazifa sarlavhasi (TASKS.md dan)',
  branch: 'Joriy git branch',
  project: 'Loyiha nomi',
  date: 'Bugungi sana (YYYY-MM-DD, Toshkent)',
};

export const TEMPLATE_VALUE_MAX_CHARS: Record<TemplateVariable, number> = { task_key: 64, task_title: 300, branch: 200, project: 120, date: 10 };

const TOKEN_RE = /\\\{\{|\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export const isTemplateVariable = (name: string): name is TemplateVariable => (TEMPLATE_VARIABLES as readonly string[]).includes(name);

/** Shablonda ishlatilgan o'zgaruvchi nomlari (takrorsiz, birinchi uchrash tartibida). Escape qilinganlar hisobga olinmaydi. */
export function extractTemplateVariables(body: string): { known: TemplateVariable[]; unknown: string[] } {
  const known: TemplateVariable[] = [];
  const unknown: string[] = [];
  for (const m of body.matchAll(TOKEN_RE)) {
    const name = m[1];
    if (name === undefined) continue; // `\{{`
    if (isTemplateVariable(name)) {
      if (!known.includes(name)) known.push(name);
    } else if (!unknown.includes(name)) unknown.push(name);
  }
  return { known, unknown };
}

/** Qiymatni xavfsizlash: yangi qator va boshqaruv belgilari bo'sh joyga, uzunlik chegarasi (kod nuqtalari bo'yicha), chetlari kesiladi. */
export function sanitizeTemplateValue(name: TemplateVariable, raw: string): string {
  const flat = raw
    .replace(/[\r\n\u2028\u2029\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
  const cps = Array.from(flat);
  const max = TEMPLATE_VALUE_MAX_CHARS[name];
  return cps.length > max ? cps.slice(0, max).join('') : flat;
}

export type TemplateValues = Partial<Record<TemplateVariable, string | null | undefined>>;

export interface RenderedTemplate {
  text: string;
  /** Qiymati berilmagan (yoki bo'sh) o'zgaruvchilar + noma'lum nomlar: matnda `{{nom}}` ko'rinishida qoladi. */
  missing: string[];
  /** Matnda ishlatilgan va qiymati topilgan o'zgaruvchilar. */
  used: TemplateVariable[];
}

export function renderTemplate(body: string, values: TemplateValues): RenderedTemplate {
  const missing: string[] = [];
  const used: TemplateVariable[] = [];
  const text = body.replace(TOKEN_RE, (whole: string, name: string | undefined) => {
    if (name === undefined) return '{{';
    if (isTemplateVariable(name)) {
      const raw = values[name];
      const v = typeof raw === 'string' ? sanitizeTemplateValue(name, raw) : '';
      if (v !== '') {
        if (!used.includes(name)) used.push(name);
        return v;
      }
    }
    if (!missing.includes(name)) missing.push(name);
    return whole;
  });
  return { text, missing, used };
}
