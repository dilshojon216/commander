"use client";

import type { DiffResponse } from "@commander/contracts";
import { useEffect, useState } from "react";
import { DiffResultView } from "@/components/git/DiffResultView";
import { DIFF_UNTRACKED_NOTE } from "@/lib/checkpoints-view";

/**
 * Joriy ishchi daraxt vs checkpoint commit'i diff'i (mavjud `POST /projects/:id/diff` `base=<sha>`). Mount bo'lganda bir marta olinadi
 * (har so'rov audit qilinadigan masofaviy buyruq: avto-yangilanmaydi). `key={sha}` bilan qayta yarating.
 */
export function CheckpointDiffPanel({ load }: { load: () => Promise<DiffResponse> }) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Xatolik");
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bir marta (mount)
  }, []);
  return (
    <div className="flex flex-col gap-2" data-testid="checkpoint-diff">
      <span className="text-xs text-mu">{DIFF_UNTRACKED_NOTE}</span>
      {error && (
        <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="checkpoint-diff-error">
          {error}
        </div>
      )}
      {!data && !error && <div className="sk h-24" aria-busy="true" />}
      {data && <DiffResultView data={data} />}
    </div>
  );
}
