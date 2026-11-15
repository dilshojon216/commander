import Link from "next/link";
import { HELP_DOCS } from "@/lib/help-docs";

export const metadata = { title: "Yo'riqnoma" };

/** Yo'riqnomalar ro'yxati: `HELP_DOCS` dagi har bir hujjatga havola. */
export default function HelpIndexPage() {
  const docs = Object.entries(HELP_DOCS) as [keyof typeof HELP_DOCS, (typeof HELP_DOCS)[keyof typeof HELP_DOCS]][];
  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold text-tx">Yo&apos;riqnoma</h1>
      <ul className="flex flex-col gap-2">
        {docs.map(([slug, d]) => (
          <li key={slug}>
            <Link href={`/help/${slug}`} className="card block p-4 text-tx hover:underline">
              {d.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
