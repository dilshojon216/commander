/**
 * Deploy bildirishnomalari reestri (6.5): markaz modullari (`CommandsService`) `TelegramService`ga bog'lanmasdan (modul sikli yo'q)
 * deploy boshlandi/tugadi haqida xabar beradi. Tinglovchi (Telegram) buyruq DTO'sini o'zi o'qiydi. Tinglovchi xatosi chaqiruvchiga
 * ta'sir qilmaydi. Chiqish matni bu yerdan o'tmaydi (faqat commandId).
 */
export type DeployNotice = { kind: 'started' | 'finished'; commandId: string };
type Listener = (n: DeployNotice) => void | Promise<void>;

const listeners = new Set<Listener>();

export const deployNotifications = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  async emit(n: DeployNotice): Promise<void> {
    for (const l of [...listeners]) {
      try {
        await l(n);
      } catch {
        /* tinglovchi xatosi: bildirishnoma yo'qolishi mumkin, natija saqlangan */
      }
    }
  },
};
