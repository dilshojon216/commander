import type { UsageRecord } from '@commander/contracts';

/** Har sessiya uchun eng so'nggi (ts bo'yicha) token yozuvidagi model; bo'sh va `<synthetic>` modellar hisobga olinmaydi. */
export function latestModelBySession(records: ReadonlyArray<Pick<UsageRecord, 'claudeSessionId' | 'model' | 'ts'>>): Map<string, string> {
  const best = new Map<string, { ts: number; model: string }>();
  for (const r of records) {
    const model = r.model?.trim();
    if (!model || model.startsWith('<')) continue;
    const prev = best.get(r.claudeSessionId);
    if (!prev || r.ts >= prev.ts) best.set(r.claudeSessionId, { ts: r.ts, model });
  }
  return new Map([...best].map(([k, v]) => [k, v.model]));
}
