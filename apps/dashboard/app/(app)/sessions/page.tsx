import { SessionsView } from "@/components/sessions/SessionsView";

export const metadata = { title: "Sessiyalar" };

export default async function SessionsPage({ searchParams }: PageProps<"/sessions">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 200) : "";
  return <SessionsView initialQuery={q} />;
}
