import type { HeadlineSegment } from "@/lib/search-view";

/** Qidiruv parchasi: moslik `<mark>` bilan; matn har doim React matni (HTML in'ektsiyasi yo'q). */
export function HeadlineText({ segments }: { segments: HeadlineSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.hit ? (
          <mark key={i} className="rounded-sm bg-yel-bg px-0.5 text-tx">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
