import type { ListProjectsResponse, RenderTemplateResponse, TemplateDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM,
  TEMPLATE_MODES,
  applyTemplateDefaults,
  buildCreateBody,
  buildUpdateBody,
  formFromDto,
  groupTemplates,
  insertVariable,
  previewSegments,
  previewStatus,
  projectIdForCwd,
  scopeBadge,
  templateHttpErrorText,
  validateForm,
  variableHelpRows,
} from "@/components/templates/template-vm";

const P1 = "11111111-1111-4111-8111-111111111111";
const tpl = (over: Partial<TemplateDto> = {}): TemplateDto => ({
  id: "22222222-2222-4222-8222-222222222222", scope: "global", projectId: null, projectName: null, repoKey: null, name: "B", description: null, body: "x {{project}}", variables: ["project"],
  model: null, permissionMode: null, builtin: false, createdByDeviceId: null, createdAt: "", updatedAt: "", ...over,
});

describe("groupTemplates / scopeBadge", () => {
  it("loyiha, repo, global tartibida; ichida nom bo'yicha; bo'sh guruh tashlanadi", () => {
    const g = groupTemplates([tpl({ name: "Z" }), tpl({ name: "A" }), tpl({ scope: "project", projectId: P1, projectName: "p", name: "M" })]);
    expect(g.map((x) => x.scope)).toEqual(["project", "global"]);
    expect(g[1]!.items.map((t) => t.name)).toEqual(["A", "Z"]);
    expect(groupTemplates([])).toEqual([]);
  });
  it("nishon matni", () => {
    expect(scopeBadge(tpl())).toBe("Global");
    expect(scopeBadge(tpl({ scope: "project", projectName: "cmdr" }))).toBe("Loyiha: cmdr");
    expect(scopeBadge(tpl({ scope: "repo", repoKey: "github.com/a/b" }))).toBe("Repo: github.com/a/b");
  });
});

describe("o'zgaruvchi yordami va qo'shish", () => {
  it("yordam qatorlari contracts'dagi barcha o'zgaruvchilarni qamraydi", () => {
    expect(variableHelpRows().map((r) => r.token)).toEqual(["{{task_key}}", "{{task_title}}", "{{branch}}", "{{project}}", "{{date}}"]);
    expect(variableHelpRows().every((r) => r.help.length > 0)).toBe(true);
  });
  it("insertVariable: kursor va tanlov o'rniga", () => {
    expect(insertVariable("ab", 1, 1, "date")).toEqual({ body: "a{{date}}b", cursor: 9 });
    expect(insertVariable("abcd", 1, 3, "branch")).toEqual({ body: "a{{branch}}d", cursor: 11 });
    expect(insertVariable("ab", 99, 0, "x").body).toBe("ab{{x}}");
  });
});

describe("forma", () => {
  it("validatsiya: nom, matn, ko'lam egasi", () => {
    expect(validateForm(EMPTY_FORM, false)).toEqual({ name: "Nom kiriting", body: "Shablon matni bo'sh" });
    expect(validateForm({ ...EMPTY_FORM, name: "a", body: "b", scope: "project" }, false).projectId).toBeTruthy();
    expect(validateForm({ ...EMPTY_FORM, name: "a", body: "b", scope: "repo" }, false).repoKey).toBeTruthy();
    expect(validateForm({ ...EMPTY_FORM, name: "a", body: "b", scope: "repo" }, true)).toEqual({});
    expect(validateForm({ ...EMPTY_FORM, name: "a", body: "x".repeat(16_001) }, false).body).toContain("16000");
  });
  it("buildCreateBody: ko'lamga mos maydonlar; noma'lum o'zgaruvchi/bypass -> null", () => {
    expect(buildCreateBody({ ...EMPTY_FORM, name: " N ", body: "{{date}}", model: "haiku", permissionMode: "plan" })).toEqual({ scope: "global", name: "N", body: "{{date}}", model: "haiku", permissionMode: "plan" });
    expect(buildCreateBody({ ...EMPTY_FORM, scope: "project", projectId: P1, name: "N", body: "b" })).toMatchObject({ scope: "project", projectId: P1 });
    expect(buildCreateBody({ ...EMPTY_FORM, scope: "repo", repoKey: " github.com/a/b ", name: "N", body: "b" })).toMatchObject({ scope: "repo", repoKey: "github.com/a/b" });
    expect(buildCreateBody({ ...EMPTY_FORM, name: "N", body: "{{secret}}" })).toBeNull();
    expect(buildCreateBody({ ...EMPTY_FORM, name: "N", body: "b", permissionMode: "bypassPermissions" as never })).toBeNull();
    expect(TEMPLATE_MODES).not.toContain("bypassPermissions");
  });
  it("buildUpdateBody: faqat o'zgarganlar, bo'sh = null, o'zgarmasa null", () => {
    const orig = tpl({ name: "N", body: "b", model: "haiku", description: "d" });
    expect(buildUpdateBody(formFromDto(orig), orig)).toBeNull();
    expect(buildUpdateBody({ ...formFromDto(orig), name: "N2", model: "", description: "" }, orig)).toEqual({ name: "N2", model: null, description: null });
    expect(buildUpdateBody({ ...formFromDto(orig), body: "{{bad}}" }, orig)).toBeNull();
  });
});

describe("xato matnlari", () => {
  it("kodlar bo'yicha o'zbekcha", () => {
    expect(templateHttpErrorText(422, { error: "missing_variables", missing: ["task_key", "branch"] })).toBe("Qiymati topilmagan o'zgaruvchilar: {{task_key}}, {{branch}}");
    expect(templateHttpErrorText(422, { error: "secret_detected" })).toContain("sir");
    expect(templateHttpErrorText(422, { error: "prompt_too_long" })).toContain("uzun");
    expect(templateHttpErrorText(409, { error: "template_exists" })).toContain("allaqachon");
    expect(templateHttpErrorText(403, { error: "lockdown" })).toContain("Lockdown");
    expect(templateHttpErrorText(403, null)).toContain("token");
    expect(templateHttpErrorText(404, null)).toContain("topilmadi");
    expect(templateHttpErrorText(0, null)).toBe("Xatolik (tarmoq)");
  });
});

describe("preview", () => {
  const res = (over: Partial<RenderTemplateResponse> = {}): RenderTemplateResponse => ({ templateId: P1, text: "", length: 0, variables: [], missing: [], tooLong: false, model: null, permissionMode: null, ...over });
  it("yetishmayotgan {{nom}} ajratiladi", () => {
    expect(previewSegments("a {{task_key}} b {{ branch }} c", ["task_key", "branch"])).toEqual([
      { text: "a ", missing: false }, { text: "{{task_key}}", missing: true }, { text: " b ", missing: false }, { text: "{{ branch }}", missing: true }, { text: " c", missing: false },
    ]);
    expect(previewSegments("plain", [])).toEqual([{ text: "plain", missing: false }]);
  });
  it("holat: missing / tooLong / ok", () => {
    expect(previewStatus(res({ missing: ["task_key"] }))).toEqual({ ok: false, note: "Qiymat topilmadi: {{task_key}}" });
    expect(previewStatus(res({ tooLong: true })).ok).toBe(false);
    expect(previewStatus(res())).toEqual({ ok: true, note: null });
  });
});

describe("kontekst yordamchilari", () => {
  const projects = { items: [{ id: P1, machineId: "m1", path: "/w/p/" }] } as unknown as ListProjectsResponse;
  it("projectIdForCwd: mashina+papka (oxiridagi / e'tiborsiz)", () => {
    expect(projectIdForCwd(projects, "m1", "/w/p")).toBe(P1);
    expect(projectIdForCwd(projects, "m2", "/w/p")).toBeNull();
    expect(projectIdForCwd(projects, "m1", "/other")).toBeNull();
    expect(projectIdForCwd(null, "m1", "/w/p")).toBeNull();
  });
  it("applyTemplateDefaults: faqat ruxsat etilgan model/rejim", () => {
    expect(applyTemplateDefaults({ model: "haiku", permissionMode: "plan" }, ["default", "plan"], ["haiku", "opus"])).toEqual({ model: "haiku", mode: "plan" });
    expect(applyTemplateDefaults({ model: "gpt", permissionMode: "auto" }, ["default"], ["haiku"])).toEqual({});
    expect(applyTemplateDefaults({ model: null, permissionMode: null }, ["default"], ["haiku"])).toEqual({});
  });
});
