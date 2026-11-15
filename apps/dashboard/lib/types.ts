import { isSessionStatus } from "@commander/contracts";
import type { SessionStatus } from "@commander/contracts";

// Wire tiplari yagona manbadan (libs/contracts); bu fayl faqat re-export qiladi.
export type { SessionDto, SessionEventDto, SessionStatus, MachineDto, ApprovalDto } from "@commander/contracts";

/** Ko'rsatish tartibi (awaiting_approval va waiting eng yuqorida). */
export const STATUSES = ["awaiting_approval", "waiting", "working", "done", "idle", "ended"] as const satisfies readonly SessionStatus[];

export const isStatus = isSessionStatus;
