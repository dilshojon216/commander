import { notFound } from "next/navigation";
import { ReportDetailView } from "@/components/reports/ReportDetailView";

export const metadata = { title: "Hisobot" };

const UUID = /^[0-9a-fA-F-]{36}$/;

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <ReportDetailView id={id} />;
}
