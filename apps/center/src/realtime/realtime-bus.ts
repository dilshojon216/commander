import { Injectable, Logger } from '@nestjs/common';
import type { AlertDto } from '@commander/contracts';

/** Sessiyaga ishora: ingest `(machineId, claudeSessionId)` ni biladi, uuid'ni emas. */
export interface SessionRef {
  machineId: string;
  claudeSessionId: string;
}

/** Bitta yangi usage yozuvi (faqat DB'ga HAQIQATAN yozilganlari; dublikat kirmaydi). */
export interface UsageDelta {
  machineId: string;
  projectId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
}

/** Jarayon ichidagi domen hodisalari (ingest/presence/approvals -> realtime hub). DB COMMIT'dan KEYIN e'lon qilinadi. */
export type DomainEvent =
  /** Watchdog ogohlantirishi yaratildi/yangilandi (3.2): hub `alert.created|updated` push qiladi (DTO tayyor, DB'ga qayta murojaat yo'q). */
  | { type: 'alert.changed'; alert: AlertDto; created: boolean }
  | { type: 'sessions.changed'; refs: SessionRef[] }
  | { type: 'machine.changed'; machineId: string }
  | { type: 'usage.recorded'; rows: UsageDelta[] }
  | { type: 'limits.changed' }
  | { type: 'approval.created'; approvalId: string }
  | { type: 'approval.resolved'; approvalId: string }
  /** Buyruq holati o'zgardi (2.3): hub `command.updated` push qiladi, Telegram step-up xabarini yangilaydi. */
  | { type: 'command.changed'; commandId: string }
  /** Loyiha snapshot'i yangilandi (2.1/2.2): hub `project.updated` push qiladi. */
  | { type: 'project.changed'; projectId: string }
  /** Sessiyalararo xabar (2.10): yaratildi (`created`) yoki holati o'zgardi (delivered/read). Hub `message.created|updated` push qiladi. */
  | { type: 'message.changed'; messageId: string; created: boolean }
  /** Navbat elementi yaratildi/o'zgardi (3.1): hub `queue.updated` push qiladi. */
  | { type: 'queue.changed'; queueId: string }
  /** Orkestratsiya (3.9) yaratildi/o'zgardi: hub `orchestration.updated` push qiladi. */
  | { type: 'orchestration.changed'; orchestrationId: string }
  /** Mashina salomatligi snapshot'i yangilandi (3.8): hub `machine.health` push qiladi (throttle bilan). */
  | { type: 'health.changed'; machineId: string }
  /**
   * Qurilma hodisasi (5.1): DB `NOTIFY commander_device_events` dan (CLI jarayoni, o'zini revoke qilish, Telegram o'chirish...).
   * `revoked` -> mos `/ws/agent` va `/ws/client` ulanishlari 4010 bilan darhol yopiladi; `rotation_required` -> agentga so'rov;
   * `center_key_rotated` -> imzo kaliti qayta yuklanadi.
   */
  | { type: 'device.event'; kind: 'revoked' | 'rotation_required'; deviceId: string }
  | { type: 'device.event'; kind: 'center_key_rotated'; deviceId: null };

export type DomainListener = (event: DomainEvent) => void | Promise<void>;

/**
 * Sodda jarayon ichidagi hodisa shinasi (bitta center jarayoni deb faraz qilingan: PLAN 1.4 cheklovi).
 * Tinglovchi xatosi publisher'ga ta'sir qilmaydi (ingest ack'i fan-out xatosi sababli yiqilmasin), lekin log qilinadi.
 */
@Injectable()
export class RealtimeBus {
  private readonly logger = new Logger(RealtimeBus.name);
  private readonly listeners = new Set<DomainListener>();

  subscribe(listener: DomainListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  publish(event: DomainEvent): void {
    for (const listener of this.listeners) {
      try {
        const r = listener(event);
        if (r instanceof Promise) {
          r.catch((err: unknown) => this.logger.error(`listener failed for ${event.type}: ${err instanceof Error ? err.message : String(err)}`));
        }
      } catch (err) {
        this.logger.error(`listener failed for ${event.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
