import type { TaskGitInfo } from "@/lib/git-view";
import { PR_STATE_TEXT } from "@/lib/git-view";

/** Doska kartasi: vazifaga bog'langan commitlar (#task:/[id]/branch) va PR'lar. Hammasi matn tugunlari, havola faqat https. */
export function TaskGit({ info }: { info: TaskGitInfo }) {
  const shown = info.commits.slice(0, 3);
  return (
    <div className="flex flex-col gap-1 border-t border-bd pt-1.5 text-[11px]" data-testid="task-git">
      {info.prs.map((p) => (
        <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-blue" data-testid="task-pr">
          <span className="mono">PR #{p.number}</span>
          <span className="text-mu">{PR_STATE_TEXT[p.state]}</span>
        </a>
      ))}
      {info.commits.length > 0 && (
        <details>
          <summary className="cursor-pointer text-mu" data-testid="task-commits-summary">
            {info.commits.length} commit
          </summary>
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
            {shown.map((c) => (
              <li key={`${c.sha}-${c.source}`} className="flex gap-1.5" title={`${c.author} · ${c.source === "branch" ? "branch nomidan taxmin" : "commit sarlavhasidagi ishora"}`}>
                <span className="mono text-fa">{c.sha.slice(0, 7)}</span>
                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                {c.source === "branch" && <span className="text-fa">taxmin</span>}
              </li>
            ))}
            {info.commits.length > shown.length && <li className="text-fa">… yana {info.commits.length - shown.length} ta</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
