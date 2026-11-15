import type { ProjectCommitDto } from "@commander/contracts";
import { formatRelative } from "@/lib/format";

/** Git commitlar (center snapshot'idan, oxirgi 30 ta). */
export function CommitList({ commits }: { commits: ProjectCommitDto[] }) {
  if (commits.length === 0) return <p className="m-0 border-t border-bd px-4 py-3 text-mu">Commit ma&apos;lumoti yo&apos;q.</p>;
  return (
    <ul className="m-0 max-h-[420px] list-none overflow-auto p-0">
      {commits.map((c) => (
        <li key={c.sha} className="flex items-center gap-2.5 border-t border-bd px-4 py-[9px]">
          <code className="mono shrink-0 text-blue">{c.sha.slice(0, 7)}</code>
          <span className="min-w-0 flex-1 truncate" title={c.subject}>
            {c.subject || "(xabarsiz)"}
          </span>
          <time className="mono shrink-0 text-xs text-mu" dateTime={c.ts} title={`${c.author} · ${c.ts}`} suppressHydrationWarning>
            {formatRelative(Date.parse(c.ts) / 1000)}
          </time>
        </li>
      ))}
    </ul>
  );
}
