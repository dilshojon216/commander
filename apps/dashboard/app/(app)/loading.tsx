import { SkeletonCard } from "@/components/ui/States";

/** Sahifa almashganda darrov ko'rinadi: URL server javobini kutmasdan o'zgaradi, havola "jim" qolmaydi. */
export default function Loading() {
  return (
    <div className="flex w-full flex-col gap-3.5 px-4 py-5 md:px-6" aria-busy="true">
      <SkeletonCard lines={3} />
      <SkeletonCard lines={6} />
    </div>
  );
}
