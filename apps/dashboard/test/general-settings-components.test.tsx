import type { MachineDto, PaceSettingsResponse, StepUpExemptionResponse } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { PaceSettingsCard } from "@/components/general-settings/PaceSettingsCard";
import { RemoteControlStateCard } from "@/components/general-settings/RemoteControlStateCard";
import { STEPUP_TOGGLE_LABEL, StepUpExemptionCard } from "@/components/general-settings/StepUpExemptionCard";
import { classifyProxyRequest } from "@/lib/proxy-rules";
import { summaryBody, summaryHeading } from "@/lib/parts-view";

const pace = (over: Partial<PaceSettingsResponse> = {}): PaceSettingsResponse => ({ settings: { enabled: true, softPct: 80, hardPct: 100, enforce: false }, day: "2026-11-15", overriddenToday: false, ...over });
const noop = () => undefined;
const paceProps = { res: pace(), canWrite: true, busy: false, message: null, failure: null, onSave: noop, onOverride: noop };

describe("<PaceSettingsCard />", () => {
  it("yuklanmagan holat", () => {
    expect(renderToStaticMarkup(<PaceSettingsCard {...paceProps} res={null} />)).toContain("Yuklanmoqda");
  });

  it("qiymatlar, tushuntirish va 'Bugun uchun ruxsat' tugmasi; o'zgarishsiz Saqlash o'chiq", () => {
    const html = renderToStaticMarkup(<PaceSettingsCard {...paceProps} />);
    expect(html).toContain('value="80"');
    expect(html).toContain('value="100"');
    expect(html).toContain("kechiktirish");
    expect(html).toContain("Bugun uchun ruxsat berish");
    expect(html).toContain("2026-11-15");
    expect(html).toMatch(/data-testid="pace-save"[^>]*disabled|disabled=""[^>]*data-testid="pace-save"/);
    expect(html).not.toContain('data-testid="pace-override-on"');
  });

  it("ruxsat berilgan bo'lsa belgi va bekor qilish tugmasi", () => {
    const html = renderToStaticMarkup(<PaceSettingsCard {...paceProps} res={pace({ overriddenToday: true })} />);
    expect(html).toContain('data-testid="pace-override-on"');
    expect(html).toContain("Ruxsatni bekor qilish");
    expect(html).not.toContain("Bugun uchun ruxsat berish");
  });

  it("control yo'q: hamma boshqaruv o'chiq va izoh", () => {
    const html = renderToStaticMarkup(<PaceSettingsCard {...paceProps} canWrite={false} />);
    expect(html).toContain("Boshqaruv token");
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("server xatosi ko'rsatiladi", () => {
    expect(renderToStaticMarkup(<PaceSettingsCard {...paceProps} failure="Ruxsat yo'q" />)).toContain("Ruxsat yo&#x27;q");
  });
});

const ex = (over: Partial<StepUpExemptionResponse> = {}): StepUpExemptionResponse => ({ available: true, exempt: false, dashboardDevices: 1, otherExemptDevices: 0, ...over });
const stepProps = { res: ex(), canWrite: true, lockdown: false, busy: false, message: null, failure: null, onChange: noop };

describe("<StepUpExemptionCard />", () => {
  it("belgilangan yozuv, deploy/rollback eslatmasi va qurilmalar soni", () => {
    const html = renderToStaticMarkup(<StepUpExemptionCard {...stepProps} />);
    expect(html).toContain("Dashboard&#x27;dan qilingan amallarga Telegram tasdig&#x27;i kerak emas (passkey/Touch ID yetarli)");
    expect(STEPUP_TOGGLE_LABEL).toBe("Dashboard'dan qilingan amallarga Telegram tasdig'i kerak emas (passkey/Touch ID yetarli)");
    expect(html).toContain("Deploy va orqaga qaytarish");
    expect(html).toContain("Faol dashboard qurilmalari: 1.");
    expect(html).not.toContain("checked");
  });

  it("yoqilgan holat", () => {
    expect(renderToStaticMarkup(<StepUpExemptionCard {...stepProps} res={ex({ exempt: true })} />)).toContain("checked");
  });

  it("dashboard qurilmasi yo'q: yoqib bo'lmaydi; lockdown: yoqib bo'lmaydi, o'chirish mumkin", () => {
    const none = renderToStaticMarkup(<StepUpExemptionCard {...stepProps} res={ex({ available: false, dashboardDevices: 0 })} />);
    expect(none).toContain('data-testid="stepup-unavailable"');
    expect(none).toContain('disabled=""');
    const lock = renderToStaticMarkup(<StepUpExemptionCard {...stepProps} lockdown />);
    expect(lock).toContain("Lockdown yoqiq");
    expect(lock).toContain('disabled=""');
    const lockOn = renderToStaticMarkup(<StepUpExemptionCard {...stepProps} lockdown res={ex({ exempt: true })} />);
    expect(lockOn).not.toContain('disabled=""');
  });

  it("boshqa istisno qurilmalar haqida izoh", () => {
    expect(renderToStaticMarkup(<StepUpExemptionCard {...stepProps} res={ex({ otherExemptDevices: 2 })} />)).toContain("Boshqa 2 ta qurilma");
  });
});

const machine = (over: Partial<MachineDto> = {}): MachineDto =>
  ({
    id: "00000000-0000-4000-8000-000000000001", slug: "mac", hostname: "mac.local", displayName: "Mac Studio", os: "darwin", arch: "arm64", online: true, lastSeenAt: null, connectedAt: null, disconnectedAt: null,
    agentdVersion: "1", claudeVersion: "2", identityStatus: "verified", sessions: { total: 0, active: 0 },
    control: { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false },
    ...over,
  }) as unknown as MachineDto;

describe("<RemoteControlStateCard />", () => {
  it("mashina holati, yo'riqnoma havolasi (/help/remote-control), faqat o'qish", () => {
    const html = renderToStaticMarkup(<RemoteControlStateCard machines={[machine(), machine({ id: "00000000-0000-4000-8000-000000000002", displayName: "Ubuntu", control: null }), machine({ id: "00000000-0000-4000-8000-000000000003", displayName: "Off", control: { ...machine().control!, enabled: false } })]} />);
    expect(html).toContain('href="/help/remote-control"');
    expect(html).toContain("Mac Studio");
    expect(html).toContain('data-tone="ok"');
    expect(html).toContain('data-tone="unknown"');
    expect(html).toContain('data-tone="off"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  it("mashina yo'q", () => {
    expect(renderToStaticMarkup(<RemoteControlStateCard machines={[]} />)).toContain("Mashina yo&#x27;q");
  });
});

describe("kunlik xulosa qism bo'yicha (6.18)", () => {
  it("so'rov tanasi: qism yo'q yoki '' = bo'sh (avvalgidek), aks holda part", () => {
    expect(summaryBody(undefined)).toEqual({});
    expect(summaryBody("")).toEqual({});
    expect(summaryBody("backend-services")).toEqual({ part: "backend-services" });
    expect(summaryBody("apps/web")).toEqual({ part: "apps/web" });
  });

  it("sarlavha qism nomini ko'rsatadi", () => {
    expect(summaryHeading(undefined)).toBe("Claude'ning kun xulosasi");
    expect(summaryHeading("")).toBe("Claude'ning kun xulosasi");
    expect(summaryHeading("apps/web")).toBe("Claude'ning kun xulosasi: web qismi");
  });

  it("proksi: kun xulosasi POST'i (tana bilan) control token; GET daily?part o'qish", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(classifyProxyRequest("POST", ["projects", id, "daily", "2026-11-05", "summary"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(classifyProxyRequest("GET", ["projects", id, "daily"])).toEqual({ ok: true, scope: "read", method: "GET" });
  });
});
