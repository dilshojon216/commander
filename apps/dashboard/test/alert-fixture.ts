import type { AlertDto } from "@commander/contracts";

export const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const alert = (n: number, over: Partial<AlertDto> = {}): AlertDto => ({
  id: U(n),
  kind: "waiting",
  state: "open",
  sessionId: U(100 + n),
  machineId: U(200),
  projectId: U(300),
  sessionName: "sess",
  projectName: "demo",
  title: "Sessiya kutmoqda",
  detail: "",
  metrics: { minutes: 20 },
  remindersSent: 0,
  autoStopped: false,
  createdAt: new Date(Date.parse("2026-11-13T10:00:00Z") + n * 60_000).toISOString(),
  updatedAt: "2026-11-13T10:00:00Z",
  resolvedAt: null,
  ...over,
});

