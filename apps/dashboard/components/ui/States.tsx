import type { ReactNode } from "react";
import { IconAlert, IconTerminal } from "./icons";

/** Bo'sh holat (Komponentlar -> "Sessiya yo'q"). */
export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2.5 p-7 text-center">
      <span className="text-fa">{icon ?? <IconTerminal size={36} strokeWidth={1} />}</span>
      <b>{title}</b>
      {children && <span className="text-mu">{children}</span>}
      {action}
    </div>
  );
}

/** Markazga ulanib bo'lmadi kabi xato holat. */
export function ErrorState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="card flex flex-col items-center gap-2.5 border-red p-7 text-center">
      <span className="text-red">
        <IconAlert size={32} strokeWidth={1.3} />
      </span>
      <b>{title}</b>
      {children && <span className="text-mu">{children}</span>}
      {action}
    </div>
  );
}

/** Ingichka xato satri (API xatosi banneri). */
export function ApiErrorBar({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-center gap-2 rounded-md bg-red-bg px-3 py-2 text-red">
      <IconAlert />
      <span>
        <b>Commander API:</b> {error}
      </span>
    </div>
  );
}

export function SkeletonCard({ lines = 4 }: { lines?: number }) {
  return (
    <div className="card flex flex-col gap-3 p-5" aria-busy="true" aria-label="Yuklanmoqda">
      <div className="sk h-3.5 w-2/5" />
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="sk h-9" style={{ width: i === lines - 1 ? "80%" : undefined }} />
      ))}
    </div>
  );
}
