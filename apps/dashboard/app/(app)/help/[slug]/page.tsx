import { notFound } from "next/navigation";
import { HelpDocView } from "@/components/help/HelpDocView";
import { HELP_DOCS, isHelpSlug, loadHelpDoc } from "@/lib/help-docs";

export const dynamic = "force-dynamic";

interface HelpProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: HelpProps) {
  const { slug } = await params;
  return { title: isHelpSlug(slug) ? HELP_DOCS[slug].title : "Yo'riqnoma" };
}

/** Server komponent: docs/<slug>.md ni (faqat ro'yxatdagi slug) o'qib, xavfsiz markdown sifatida ko'rsatadi. */
export default async function HelpPage({ params }: HelpProps) {
  const { slug } = await params;
  if (!isHelpSlug(slug)) notFound();
  const doc = await loadHelpDoc(slug);
  return <HelpDocView title={doc.title} content={doc.ok ? doc.content : null} />;
}
