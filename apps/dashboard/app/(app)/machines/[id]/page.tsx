import { notFound } from "next/navigation";
import { MachineDetailView } from "@/components/machines/MachineDetailView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mashina" };

const UUID = /^[0-9a-fA-F-]{36}$/;

export default async function MachinePage({ params }: PageProps<"/machines/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <MachineDetailView machineId={id} />;
}
