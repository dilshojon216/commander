import type { IncidentKind, IncidentSeverity } from '@commander/contracts';
import { conditionKey } from './health-rules.js';
import type { Condition } from './health-rules.js';

export interface OpenIncident {
  id: string;
  kind: IncidentKind;
  subject: string;
  severity: IncidentSeverity;
}

export interface IncidentPlan {
  /** Yangi hodisa: DB'ga yoziladi va Telegram'ga BIR marta yuboriladi. */
  open: Condition[];
  /** warn -> critical: DB yangilanadi va qayta xabar beriladi (jiddiyroq holat). */
  escalate: Array<{ id: string; condition: Condition }>;
  /** critical -> warn: jim yangilanadi (xabarsiz). */
  downgrade: Array<{ id: string; condition: Condition }>;
  /** Shart yo'qoldi: yopiladi va "tiklandi" xabari yuboriladi. */
  resolve: OpenIncident[];
  /** O'zgarmagan (matn yangilanishi mumkin, xabarsiz). */
  keep: number;
}

/**
 * Hodisa holat mashinasi (sof). `evaluated` = shu tekshiruvda hisobga olingan turlar: faqat shu turlardagi ochiq hodisalar
 * yopilishi mumkin (docker mavjud bo'lmasa konteyner hodisalari "tiklandi" bo'lib qolmaydi). `offline` bu yerda hech qachon
 * yopilmaydi: uni alohida supurgich boshqaradi.
 */
export function planIncidents(open: readonly OpenIncident[], desired: readonly Condition[], evaluated: ReadonlySet<IncidentKind>): IncidentPlan {
  const byKey = new Map(open.map((o) => [conditionKey(o.kind, o.subject), o]));
  const want = new Map(desired.map((c) => [conditionKey(c.kind, c.subject), c]));
  const plan: IncidentPlan = { open: [], escalate: [], downgrade: [], resolve: [], keep: 0 };
  for (const [key, c] of want) {
    const cur = byKey.get(key);
    if (!cur) plan.open.push(c);
    else if (cur.severity === 'warn' && c.severity === 'critical') plan.escalate.push({ id: cur.id, condition: c });
    else if (cur.severity === 'critical' && c.severity === 'warn') plan.downgrade.push({ id: cur.id, condition: c });
    else plan.keep += 1;
  }
  for (const [key, cur] of byKey) {
    if (want.has(key) || !evaluated.has(cur.kind) || cur.kind === 'offline') continue;
    plan.resolve.push(cur);
  }
  return plan;
}
