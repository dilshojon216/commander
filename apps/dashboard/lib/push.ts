import {
  AlertCreatedMessageSchema,
  AlertUpdatedMessageSchema,
  ApprovalCreatedMessageSchema,
  ApprovalResolvedMessageSchema,
  CommandUpdatedMessageSchema,
  ProjectUpdatedMessageSchema,
  MessageCreatedMessageSchema,
  MessageUpdatedMessageSchema,
  LimitsUpdatedMessageSchema,
  MachineUpdatedMessageSchema,
  SessionUpdatedMessageSchema,
  UsageTickMessageSchema,
} from "@commander/contracts";
import type { AlertDto, ApprovalDto, CommandDto, MessageDto, ProjectUpdatedPayload, LimitsResponse, MachineDto, SessionDto, UsageTickPayload } from "@commander/contracts";

export type PushEvent =
  | { type: "session.updated"; session: SessionDto }
  | { type: "machine.updated"; machine: MachineDto }
  | { type: "limits.updated"; limits: LimitsResponse }
  | { type: "approval.created" | "approval.resolved"; approval: ApprovalDto }
  | { type: "usage.tick"; tick: UsageTickPayload }
  | { type: "command.updated"; command: CommandDto }
  | { type: "project.updated"; project: ProjectUpdatedPayload["project"] }
  | { type: "message.created" | "message.updated"; message: MessageDto }
  | { type: "alert.created" | "alert.updated"; alert: AlertDto };

/** SSE'dan kelgan push payload'ini kontrakt sxemalari bilan tekshiradi (noto'g'ri bo'lsa null). */
export function parsePush(type: string, payload: unknown): PushEvent | null {
  switch (type) {
    case "session.updated": {
      const r = SessionUpdatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, session: r.data.session } : null;
    }
    case "machine.updated": {
      const r = MachineUpdatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, machine: r.data.machine } : null;
    }
    case "limits.updated": {
      const r = LimitsUpdatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, limits: r.data.limits } : null;
    }
    case "approval.created": {
      const r = ApprovalCreatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, approval: r.data.approval } : null;
    }
    case "approval.resolved": {
      const r = ApprovalResolvedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, approval: r.data.approval } : null;
    }
    case "usage.tick": {
      const r = UsageTickMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, tick: r.data } : null;
    }
    case "command.updated": {
      const r = CommandUpdatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, command: r.data.command } : null;
    }
    case "project.updated": {
      const r = ProjectUpdatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, project: r.data.project } : null;
    }
    case "message.created": {
      const r = MessageCreatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, message: r.data.message } : null;
    }
    case "message.updated": {
      const r = MessageUpdatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, message: r.data.message } : null;
    }
    case "alert.created": {
      const r = AlertCreatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, alert: r.data.alert } : null;
    }
    case "alert.updated": {
      const r = AlertUpdatedMessageSchema.shape.payload.safeParse(payload);
      return r.success ? { type, alert: r.data.alert } : null;
    }
    default:
      return null;
  }
}

/** id bo'yicha almashtirish yoki boshiga qo'shish. */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
}
