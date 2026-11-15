/**
 * Ota jarayon o'lsa (masalan Windows'da `Stop-ScheduledTask` wscript ishga tushiruvchini o'ldiradi, lekin bola node'ni emas)
 * agentd tartibli to'xtaydi: yetim jarayon qolmaydi. `process.kill(pid, 0)` signal yubormaydi, faqat mavjudlikni tekshiradi
 * (ESRCH = yo'q; EPERM = bor, lekin ruxsat yo'q = tirik).
 */
export function isAlive(pid: number, kill: (pid: number, sig: 0) => unknown = (p, s) => process.kill(p, s)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Qaytaradi: to'xtatish funksiyasi. `onGone` bir marta chaqiriladi. Taymer `unref` (jarayonni ushlab turmaydi). */
export function watchParent(ppid: number, onGone: () => void, intervalMs = 5000, alive: (pid: number) => boolean = isAlive): () => void {
  let fired = false;
  const t = setInterval(() => {
    if (fired || alive(ppid)) return;
    fired = true;
    clearInterval(t);
    onGone();
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
