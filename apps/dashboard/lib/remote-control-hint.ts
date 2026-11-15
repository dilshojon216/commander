import type { MachineDto } from "@commander/contracts";

/** Yo'riqnoma sahifasi (docs/remote-control.md). */
export const REMOTE_CONTROL_HELP_HREF = "/help/remote-control";

/**
 * Mashinada masofaviy boshqaruv o'chiq (agentd yangi, lekin siyosat `enabled: false`) -> true.
 * `control` yo'q (eski agentd) yoki mashina oflayn bo'lsa yoqish buyrug'i foydasiz: false.
 */
export function needsRemoteEnable(m: Pick<MachineDto, "online" | "control">): boolean {
  return m.online && m.control != null && !m.control.enabled;
}

/** Sabab matni masofaviy boshqaruv o'chiqligini bildiradimi (yo'riqnoma havolasini ko'rsatish uchun). */
export function isPolicyOffReason(reason: string | null | undefined): boolean {
  return !!reason && reason.includes("masofaviy boshqaruv o'chiq") && !reason.startsWith("Lockdown");
}

/** Shell uchun xavfsiz so'z: faqat harf/raqam/`-_.` bo'lsa o'zi, aks holda bitta tirnoqda. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_.@:~\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Izoh qatori uchun xavfsiz nom (yangi qator va boshqaruv belgilarisiz). */
function commentSafe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/**
 * Egasi Mac'da ishga tushiradigan buyruq. ssh alias center'ga noma'lum, shuning uchun `<ssh-alias>` o'rin belgisi;
 * mashina nomi izohda (qaysi mashina ekanini eslatish uchun). `--root` — foydalanuvchi tuzatadigan misol.
 */
export function buildEnableCommand(machineName?: string | null, root = "~/project"): string {
  const name = commentSafe(machineName ?? "");
  const head = name ? `# ${name}: <ssh-alias> o'rniga shu mashinaning ssh nomini yozing\n` : "";
  return `${head}./ops/remote-control.sh <ssh-alias> enable --root ${shellWord(root)}`;
}
