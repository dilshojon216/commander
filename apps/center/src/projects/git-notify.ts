/**
 * Git bildirishnomalari reestri (3.5): markaz modullari (CI natijasi) `TelegramService`ga bog'lanmasdan (modul sikli yo'q)
 * xabar beradi. Tinglovchi xatosi chaqiruvchiga ta'sir qilmaydi.
 */
export interface CiFailureNotice {
  projectId: string;
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
  runName: string;
  runUrl: string | null;
  /** Muvaffaqiyatsiz tekshiruv nomlari (<= 5). */
  failing: string[];
}

export type GitNotice = { kind: 'ci_failed'; notice: CiFailureNotice };
type Listener = (n: GitNotice) => void | Promise<void>;

const listeners = new Set<Listener>();

export const gitNotifications = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  async emit(n: GitNotice): Promise<void> {
    for (const l of [...listeners]) {
      try {
        await l(n);
      } catch {
        /* tinglovchi xatosi: bildirishnoma yo'qolishi mumkin, lekin natija saqlangan */
      }
    }
  },
};
