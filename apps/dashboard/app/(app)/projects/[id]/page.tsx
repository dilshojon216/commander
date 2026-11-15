import { notFound } from "next/navigation";
import { ProjectDetailView } from "@/components/projects/ProjectDetailView";
import { ErrorState } from "@/components/ui/States";
import { machineLabel, shortSlug } from "@/lib/machines";
import { fetchMachines, fetchProjectDetail, fetchProjectSessions, fetchProjectTasks } from "@/lib/snapshots";

export const dynamic = "force-dynamic";
export const metadata = { title: "Loyiha" };

const UUID = /^[0-9a-fA-F-]{36}$/;

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const [detail, tasks, machines, sessions] = await Promise.all([fetchProjectDetail(id), fetchProjectTasks(id), fetchMachines(), fetchProjectSessions(id)]);
  if (!detail.data) {
    if (detail.error?.includes("404")) notFound();
    return (
      <div className="p-6">
        <ErrorState title="Loyihani olib bo'lmadi">{detail.error}</ErrorState>
      </div>
    );
  }
  const project = detail.data.project;
  const machine = machines.data?.items.find((m) => m.id === project.machineId);
  const machineName = machine ? machineLabel(machine) : shortSlug(project.machineSlug);

  return <ProjectDetailView initialDetail={detail.data} initialTasks={tasks.data} machineName={machineName} initialSessions={sessions.data?.items ?? []} sessionsError={sessions.error} />;
}
