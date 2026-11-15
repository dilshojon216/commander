import { Injectable } from '@nestjs/common';

export interface AgentSender {
  /** Qurilma (agentd) id'si: diagnostika uchun. */
  deviceId: string;
  /** Xabarni agentd ulanishiga yuboradi; ulanish ochiq bo'lmasa `false`. */
  send(type: string, payload: unknown): boolean;
}

/**
 * center -> agentd yuborish nuqtasi. `AgentChannelService` har tasdiqlangan ulanishni shu yerga ro'yxatdan
 * o'tkazadi; approvals (va keyin commands) moduli `AgentModule`ga bog'lanmasdan (modul sikli yo'q) shu orqali yuboradi.
 */
export type PresenceListener = (machineId: string, online: boolean) => void;

@Injectable()
export class AgentDispatchService {
  private readonly senders = new Map<string, AgentSender>();
  private readonly listeners = new Set<PresenceListener>();

  register(machineId: string, sender: AgentSender): void {
    this.senders.set(machineId, sender);
    this.notify(machineId, true);
  }

  /** Faqat `sender` hali joriy bo'lsa o'chiriladi (almashtirilgan ulanish yangisini o'chirib yubormasin). */
  unregister(machineId: string, sender: AgentSender): void {
    if (this.senders.get(machineId) !== sender) return;
    this.senders.delete(machineId);
    this.notify(machineId, false);
  }

  /** Mashina agentd ulanishi paydo bo'lganda/uzilganda (chat relay oqimlarni qayta boshlaydi/offline qiladi). */
  onPresence(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private notify(machineId: string, online: boolean): void {
    for (const l of this.listeners) {
      try {
        l(machineId, online);
      } catch {
        /* tinglovchi xatosi ulanish hayotiy siklini buzmasin */
      }
    }
  }

  /** Mashinaning hozirgi tasdiqlangan agentd qurilmasi (buyruq imzosi shu qurilmaga bog'lanadi); offline bo'lsa `null`. */
  deviceIdFor(machineId: string): string | null {
    return this.senders.get(machineId)?.deviceId ?? null;
  }

  isOnline(machineId: string): boolean {
    return this.senders.has(machineId);
  }

  /** `true`: ulanishga yozildi (yetkazish kafolati emas: agent ack qaytarmaydi). */
  send(machineId: string, type: string, payload: unknown): boolean {
    return this.senders.get(machineId)?.send(type, payload) ?? false;
  }
}
