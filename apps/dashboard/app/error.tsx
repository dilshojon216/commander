"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/States";
import { isChunkLoadError, reloadOnChunkError } from "@/lib/chunk-reload";

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  // Dashboard yangilangandan keyin eski chunk'lar yo'q: sahifani to'liq qayta yuklab yangi build'ni olamiz.
  useEffect(() => {
    reloadOnChunkError(error);
  }, [error]);

  // Chunk xatosida `reset` o'sha eski faylni qayta so'raydi — shuning uchun to'liq qayta yuklash.
  const retry = () => (isChunkLoadError(error) ? window.location.reload() : reset());

  return (
    <div className="p-6">
      <ErrorState
        title="Xatolik yuz berdi"
        action={
          <button type="button" onClick={retry} className="btn">
            Qayta urinish
          </button>
        }
      >
        Sahifani yuklab bo&apos;lmadi.
      </ErrorState>
    </div>
  );
}
