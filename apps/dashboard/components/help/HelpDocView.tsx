import { MarkdownView } from "@/components/MarkdownView";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";

/** Yo'riqnoma sahifasi tanasi. `content === null` — hujjat fayli topilmadi. */
export function HelpDocView({ title, content }: { title: string; content: string | null }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="px-4 py-5 md:px-6">
        {content === null ? (
          <EmptyState title="Hujjat topilmadi">Yo&apos;riqnoma fayli (docs/) o&apos;qib bo&apos;lmadi. Repo&apos;dagi docs/remote-control.md ni to&apos;g&apos;ridan-to&apos;g&apos;ri oching.</EmptyState>
        ) : (
          <article className="card mx-auto max-w-3xl" data-testid="help-doc">
            <MarkdownView content={content} className="px-5 py-4" />
          </article>
        )}
      </div>
    </>
  );
}
