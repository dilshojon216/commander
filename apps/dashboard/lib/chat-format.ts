import type { TokenFootnote } from "./chat-types";
import { formatTokens } from "./format";

/** Tool nomi -> rang (dizayn: Read ko'k, Bash sariq, Edit yashil). */
export function toolColor(tool: string): string {
  switch (tool) {
    case "Read":
    case "Grep":
    case "Glob":
      return "var(--blue)";
    case "Bash":
      return "var(--yel)";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "var(--grn)";
    default:
      return "var(--mu)";
  }
}

/** "↳ 1.2M token · cache read 1.18M · output 3.4K · 41 s". */
export function footnoteText(f: TokenFootnote): string {
  const parts = [`${formatTokens(f.totalTokens)} token`];
  if (f.cacheReadTokens !== undefined) parts.push(`cache read ${formatTokens(f.cacheReadTokens)}`);
  if (f.outputTokens !== undefined) parts.push(`output ${formatTokens(f.outputTokens)}`);
  if (f.durationMs !== undefined) parts.push(`${Math.round(f.durationMs / 1000)} s`);
  return `↳ ${parts.join(" · ")}`;
}

/** Natijada `[REDACTED]` bor-yo'qligi (ochish tugmasi taklif qilinmaydi, matn o'zgarmaydi). */
export function hasRedaction(text: string | undefined): boolean {
  return !!text && text.includes("[REDACTED]");
}

/** `/Users/me/work/x` -> `~/work/x`. */
export function shortenPath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}
