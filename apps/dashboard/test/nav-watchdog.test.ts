import { describe, expect, it } from "vitest";
import { needsHardNavigation, trackedTarget } from "@/lib/nav-watchdog";

const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
const a = { href: "http://127.0.0.1:4318/queue?x=1#h", target: "", hasDownload: false };

describe("trackedTarget", () => {
  it("oddiy ichki havola: path+search", () => {
    expect(trackedTarget(base, a, "http://127.0.0.1:4318")).toBe("/queue?x=1");
  });
  it("modifikator, o'ng tugma, target=_blank, download, tashqi origin kuzatilmaydi", () => {
    expect(trackedTarget({ ...base, metaKey: true }, a, "http://127.0.0.1:4318")).toBeNull();
    expect(trackedTarget({ ...base, button: 2 }, a, "http://127.0.0.1:4318")).toBeNull();
    expect(trackedTarget(base, { ...a, target: "_blank" }, "http://127.0.0.1:4318")).toBeNull();
    expect(trackedTarget(base, { ...a, hasDownload: true }, "http://127.0.0.1:4318")).toBeNull();
    expect(trackedTarget(base, { ...a, href: "https://example.com/x" }, "http://127.0.0.1:4318")).toBeNull();
  });
});

describe("needsHardNavigation", () => {
  it("URL o'zgarmagan va maqsad boshqa: to'liq navigatsiya", () => {
    expect(needsHardNavigation("/sessions", "/sessions", "/queue")).toBe(true);
  });
  it("navigatsiya bajarilgan yoki foydalanuvchi boshqa joyga o'tgan: yo'q", () => {
    expect(needsHardNavigation("/sessions", "/queue", "/queue")).toBe(false);
    expect(needsHardNavigation("/sessions", "/search", "/queue")).toBe(false);
  });
  it("maqsad joriy sahifaning o'zi: yo'q", () => {
    expect(needsHardNavigation("/sessions", "/sessions", "/sessions")).toBe(false);
  });
});
