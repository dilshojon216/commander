/** `js-yaml` 4.x uchun minimal tip e'loni (paketda tiplar yo'q; `@types/js-yaml` o'rnatilmagan). Faqat xavfsiz `load` + `CORE_SCHEMA`. */
declare module 'js-yaml' {
  export const CORE_SCHEMA: unknown;
  export function load(input: string, opts?: { schema?: unknown; filename?: string; json?: boolean }): unknown;
}
