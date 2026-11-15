import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "../next.config";

const h = (k: string): string => SECURITY_HEADERS.find((x) => x.key === k)?.value ?? "";

describe("M-09: xavfsizlik sarlavhalari", () => {
  it("freymlash yopiq (CSP frame-ancestors + X-Frame-Options)", () => {
    expect(h("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(h("X-Frame-Options")).toBe("DENY");
  });
  it("CSP: default-src 'self', tashqi manba/object/forma yo'q, http uchun upgrade-insecure-requests YO'Q", () => {
    const csp = h("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/https?:\/\/(?!127)/);
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
  it("nosniff va referrer", () => {
    expect(h("X-Content-Type-Options")).toBe("nosniff");
    expect(h("Referrer-Policy")).toBe("no-referrer");
  });
});
