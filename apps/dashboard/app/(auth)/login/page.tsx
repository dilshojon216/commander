import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/LoginForm";
import { safeNextPath } from "@/lib/auth/paths";
import { requireSessionOrNull } from "@/lib/auth/server-session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Kirish" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const next = safeNextPath(raw);
  // Allaqachon kirgan bo'lsa to'g'ridan-to'g'ri ichkariga
  if (await requireSessionOrNull()) redirect(next);
  return <LoginForm next={next} />;
}
