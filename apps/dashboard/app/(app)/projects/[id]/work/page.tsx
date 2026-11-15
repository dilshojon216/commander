import { notFound } from "next/navigation";
import { WorkView } from "@/components/work/WorkView";
import { ErrorState } from "@/components/ui/States";
import { machineLabel, shortSlug } from "@/lib/machines";
import { fetchMachines, fetchProjectDetail, fetchProjectSessions, fetchProjectTasks } from "@/lib/snapshots";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ish maydoni" };

const UUID = /^[0-9a-fA-F-]{36}$/;

export default async function ProjectWorkPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { id } = await params;
  const q = (await searchParams).part;
  const initialPart = typeof q === "string" && q.length <= 200 ? q : undefined;
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
  return <WorkView project={project} machineName={machineName} initialTasks={tasks.data} initialSessions={sessions.data?.items ?? []} {...(initialPart !== undefined ? { initialPart } : {})} />;
}
