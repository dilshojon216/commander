import { notFound } from "next/navigation";
import { ScanDetailView } from "@/components/security/ScanDetailView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tekshiruv natijasi" };

const UUID = /^[0-9a-fA-F-]{36}$/;

export default async function ScanPage({ params }: { params: Promise<{ scanId: string }> }) {
  const { scanId } = await params;
  if (!UUID.test(scanId)) notFound();
  return <ScanDetailView scanId={scanId} />;
}
