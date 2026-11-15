import { describe, expect, it } from "vitest";
import { configErrorText, configHttpErrorText } from "@/lib/config-ui";

describe("configErrorText", () => {
  it("config kodlari o'zbekcha; config_not_allowed CLI ko'rsatmasi bilan", () => {
    expect(configErrorText("config_not_allowed")).toContain("agentd policy allow-config");
    expect(configErrorText("config_plan_changed")).toContain("Farqni ko'rish");
    for (const c of ["config_bundle_missing", "config_bundle_invalid", "config_backup_not_found", "config_too_large", "config_write_failed"]) {
      expect(configErrorText(c)).not.toContain(c);
    }
  });
  it("umumiy kodlar control-ui jadvaliga o'tadi; noma'lum kod aytib o'tiladi", () => {
    expect(configErrorText("machine_offline")).toBe("Mashina oflayn");
    expect(configErrorText("step_up_expired")).toContain("vaqti tugadi");
    expect(configErrorText("agent_outdated")).toContain("eski");
    expect(configErrorText("lockdown")).toContain("Lockdown");
    expect(configErrorText("zzz")).toContain("zzz");
    expect(configErrorText(null)).toBe("Buyruq bajarilmadi");
  });
});

describe("configHttpErrorText", () => {
  it("markaz kodi config kodi bo'lsa shu matn", () => {
    expect(configHttpErrorText(409, { error: "config_plan_changed" })).toContain("Farqni ko'rish");
    expect(configHttpErrorText(409, { error: "machine_offline" })).toBe("Mashina oflayn");
  });
  it("kodsiz holatlar", () => {
    expect(configHttpErrorText(404, null)).toContain("topilmadi");
    expect(configHttpErrorText(504, null)).toContain("vaqt tugadi");
    expect(configHttpErrorText(403, { error: "lockdown" })).toContain("Lockdown");
    expect(configHttpErrorText(429, null)).toContain("Juda ko'p");
  });
});
