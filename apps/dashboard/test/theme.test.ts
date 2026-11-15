import { describe, expect, it } from "vitest";
import { chordTarget } from "@/lib/shortcuts";
import { THEME_INIT_SCRIPT, THEME_KEY, resolveInitialTheme } from "@/lib/theme";

describe("resolveInitialTheme", () => {
  it("saqlangan qiymat ustun", () => {
    expect(resolveInitialTheme("light", false)).toBe("light");
    expect(resolveInitialTheme("dark", true)).toBe("dark");
  });
  it("birinchi tashrif: tizim sozlamasi; aks holda qorong'i", () => {
    expect(resolveInitialTheme(null, true)).toBe("light");
    expect(resolveInitialTheme(null, false)).toBe("dark");
    expect(resolveInitialTheme("garbage", false)).toBe("dark");
  });
  it("init skript localStorage'ni try/catch bilan o'qiydi va data-theme o'rnatadi", () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_KEY);
    expect(THEME_INIT_SCRIPT).toContain("try{");
    expect(THEME_INIT_SCRIPT).toContain("prefers-color-scheme: light");
    expect(THEME_INIT_SCRIPT).toContain("dataset.theme");
  });
});

describe("klaviatura chord (g + harf)", () => {
  it("sahifalarga xaritalanadi", () => {
    expect(chordTarget("s")).toBe("/sessions");
    expect(chordTarget("p")).toBe("/projects");
    expect(chordTarget("o")).toBe("/");
    expect(chordTarget("t")).toBe("/tokens");
    expect(chordTarget("m")).toBe("/machines");
    expect(chordTarget("x")).toBeNull();
  });
});
