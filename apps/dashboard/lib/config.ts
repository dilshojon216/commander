import "server-only";

export interface DashboardConfig {
  apiUrl: string;
  /** `read` scope token (faqat server tomonda). */
  apiToken: string | null;
  /** `read,approve` scope token: faqat approval qarorlari uchun (faqat server tomonda). */
  approveToken: string | null;
  /** `read,control` scope token: faqat masofaviy boshqaruv (buyruqlar) uchun (faqat server tomonda). */
  controlToken: string | null;
  /** Ko'rsatilmaydigan mashinalar (hostname yoki slug aniq mosligi, kichik harf). */
  hideMachines: string[];
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getConfig(): DashboardConfig {
  const apiUrl = (process.env.COMMANDER_API_URL?.trim() || "http://127.0.0.1:4317").replace(/\/+$/, "");
  const token = process.env.COMMANDER_API_TOKEN?.trim();
  const approve = process.env.COMMANDER_APPROVE_TOKEN?.trim();
  const control = process.env.COMMANDER_CONTROL_TOKEN?.trim();
  return {
    apiUrl,
    apiToken: token ? token : null,
    approveToken: approve ? approve : null,
    controlToken: control ? control : null,
    hideMachines: splitList(process.env.DASHBOARD_HIDE_MACHINES).map((m) => m.toLowerCase()),
  };
}
