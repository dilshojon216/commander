import { notFound } from "next/navigation";
import { SessionView } from "@/components/sessions/SessionView";
import { ErrorState } from "@/components/ui/States";
import { fetchSession, fetchSessionEvents } from "@/lib/snapshots";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sessiya" };

const UUID = /^[0-9a-fA-F-]{36}$/;

export default async function SessionPage({ params }: PageProps<"/sessions/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [session, events] = await Promise.all([fetchSession(id), fetchSessionEvents(id)]);
  if (!session.data) {
    if (session.error?.includes("404")) notFound();
    return (
      <div className="p-6">
        <ErrorState title="Sessiyani olib bo'lmadi">{session.error}</ErrorState>
      </div>
    );
  }
  return <SessionView initialSession={session.data} initialEvents={events.data?.items ?? []} initialError={events.error} />;
}
