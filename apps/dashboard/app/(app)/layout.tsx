import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { availableMethods } from "@/lib/auth/service";
import { requireSessionOrNull } from "@/lib/auth/server-session";
import { getAuthSettings } from "@/lib/auth/settings";
import { canApprove, canControl, fetchApprovals, fetchLimits, fetchMachines, fetchOpenAlerts, fetchProjects, fetchSessions, fetchSummary, hideRules } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // H-01: ikkinchi qatlam (proxy.ts birinchisi). Sessiyasiz hech qanday center ma'lumoti o'qilmaydi.
  const session = await requireSessionOrNull();
  if (!session) redirect("/login");

  // Birinchi bo'yash uchun SSR snapshot; keyin LiveDataProvider SSE orqali jonli yangilaydi.
  const [sessions, machines, approvals, limits, summary, projects] = await Promise.all([
    fetchSessions({ active: true }),
    fetchMachines(),
    fetchApprovals(),
    fetchLimits(),
    fetchSummary(),
    fetchProjects(),
  ]);
  // Ogohlantirishlar muhim emas: xato bo'lsa sahifa buzilmaydi
  const alerts = await fetchOpenAlerts();
  const error = sessions.error ?? machines.error ?? approvals.error ?? limits.error ?? summary.error ?? projects.error;

  return (
    <AuthProvider
      initial={{
        authenticated: true,
        csrf: session.csrf,
        method: session.method,
        elevatedUntil: session.elevatedUntil,
        expiresAt: session.expiresAt,
        elevationMs: getAuthSettings().elevationMs,
        methods: availableMethods(),
      }}
    >
      <AppShell
        initial={{
          sessions: sessions.data?.items ?? [],
          machines: machines.data?.items ?? [],
          approvals: approvals.data,
          limits: limits.data,
          summary: summary.data,
          projects: projects.data,
          alerts: alerts.data?.items ?? [],
          error,
        }}
        hide={hideRules()}
        canApprove={canApprove()}
        canControl={canControl()}
      >
        {children}
      </AppShell>
    </AuthProvider>
  );
}
