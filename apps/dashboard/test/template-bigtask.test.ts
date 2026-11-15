import { describe, expect, it } from "vitest";
import { EMPTY_FORM, buildCreateBody, buildUpdateBody, formFromDto, isBigTaskTemplate } from "@/components/templates/template-vm";
import type { TemplateDto } from "@commander/contracts";

const dto = (over: Partial<TemplateDto> = {}): TemplateDto => ({
  id: "11111111-1111-4111-8111-111111111111", scope: "global", projectId: null, projectName: null, repoKey: null, name: "N", description: null, body: "b", variables: [],
  model: null, permissionMode: null, builtin: false, createdByDeviceId: null, createdAt: "", updatedAt: "", ...over,
});

describe("shablon: katta vazifa (6.9)", () => {
  it("forma: standart o'chiq; DTO'dan o'qiladi", () => {
    expect(EMPTY_FORM.bigTask).toBe(false);
    expect(formFromDto(dto()).bigTask).toBe(false);
    expect(formFromDto(dto({ bigTask: true })).bigTask).toBe(true);
  });
  it("yaratish tanasi: faqat yoqilganda bigTask: true", () => {
    expect(buildCreateBody({ ...EMPTY_FORM, name: "N", body: "b" })).not.toHaveProperty("bigTask");
    expect(buildCreateBody({ ...EMPTY_FORM, name: "N", body: "b", bigTask: true })).toMatchObject({ bigTask: true });
  });
  it("yangilash tanasi: faqat o'zgarganda", () => {
    const orig = dto();
    expect(buildUpdateBody(formFromDto(orig), orig)).toBeNull();
    expect(buildUpdateBody({ ...formFromDto(orig), bigTask: true }, orig)).toEqual({ bigTask: true });
    const big = dto({ bigTask: true });
    expect(buildUpdateBody(formFromDto(big), big)).toBeNull();
    expect(buildUpdateBody({ ...formFromDto(big), bigTask: false }, big)).toEqual({ bigTask: false });
  });
  it("isBigTaskTemplate", () => {
    expect(isBigTaskTemplate(dto({ bigTask: true }))).toBe(true);
    expect(isBigTaskTemplate(dto())).toBe(false);
    expect(isBigTaskTemplate(null)).toBe(false);
  });
});
