import { taskPill } from "@/lib/tasks-view";

/** Sessiyaga bog'langan vazifa belgisi (taxmin bo'lsa "~"). */
export function TaskPill({ session }: { session: { taskKey?: string | null; taskSource?: "explicit" | "branch" | null } }) {
  const p = taskPill(session);
  if (!p) return null;
  return (
    <span className="pill mono bg-s3 text-mu" style={{ height: 18, fontSize: 10 }} title={p.title} data-testid="task-pill">
      {p.text}
    </span>
  );
}
