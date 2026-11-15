import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalRuleDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { ApprovalRulesPanelView } from "@/components/rules/ApprovalRulesPanel";
import type { ApprovalRulesPanelViewProps } from "@/components/rules/ApprovalRulesPanel";
import { initialRuleForm, rulesCollapsedSummary } from "@/lib/rules-ui";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const noop = () => undefined;
const rule = (over: Partial<ApprovalRuleDto> = {}): ApprovalRuleDto => ({
  id: 5,
  scope: "session",
  scopeRef: "11111111-1111-4111-8111-111111111111",
  scopeLabel: "demo",
  tools: ["Edit", "Write"],
  pathGlobs: ["src/**"],
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
  createdByDeviceId: "22222222-2222-4222-8222-222222222222",
  createdAt: new Date(NOW).toISOString(),
  revokedAt: null,
  status: "active",
  autoCount: 4,
  ...over,
});
const props = (over: Partial<ApprovalRulesPanelViewProps> = {}): ApprovalRulesPanelViewProps => ({
  title: "Avto-ruxsat qoidalari",
  scope: "session",
  rules: [],
  loadError: null,
  now: NOW,
  form: initialRuleForm(),
  formError: null,
  canCreate: true,
  disabledHint: null,
  submitting: false,
  revokingId: null,
  onFormChange: noop,
  onCreate: noop,
  onRevoke: noop,
  ...over,
});
const render = (over: Partial<ApprovalRulesPanelViewProps> = {}) => renderToStaticMarkup(<ApprovalRulesPanelView {...props(over)} />);

describe("<ApprovalRulesPanelView />", () => {
  it("forma: vosita belgilari (Edit/Write/MultiEdit tanlangan), Bash YO'Q, muddatlar 15m/1h/8h/1d/7d, xavfsizlik izohi", () => {
    const html = render();
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep"]) expect(html).toContain(`>${t}</span>`);
    expect(html).not.toContain(">Bash<");
    expect(html).toMatch(/<input type="checkbox" checked=""[^>]*\/><span class="mono">Edit</);
    expect(html).not.toMatch(/<input type="checkbox" checked=""[^>]*\/><span class="mono">Read</);
    for (const d of ["15 daqiqa", "1 soat", "8 soat", "1 kun", "7 kun"]) expect(html).toContain(d);
    expect(html).toContain("Bash va shell vositalari hech qachon avto-ruxsat olmaydi");
    expect(html).toContain("Faol qoida yo&#x27;q");
  });
  it("faol qoidalar: id, qolgan vaqt, ishlagan soni, yo'l andozalari, bekor qilish tugmasi; bekor qilingani ko'rsatilmaydi", () => {
    const html = render({ rules: [rule(), rule({ id: 6, status: "revoked", revokedAt: new Date(NOW).toISOString() })] });
    expect(html.match(/data-testid="rule-row"/g)).toHaveLength(1);
    expect(html).toContain("#5");
    expect(html).toContain("1 soat 0 daq qoldi");
    expect(html).toContain("4 marta ishladi");
    expect(html).toContain("Edit, Write: src/**");
    expect(html).toContain('data-testid="rule-revoke"');
  });
  it("o'chirilgan forma (lockdown/token yo'q): yaratish tugmasi disabled, sabab ko'rinadi; bekor qilish faol qoladi", () => {
    const html = render({ rules: [rule()], canCreate: false, disabledHint: "Lockdown: yangi qoida yaratib bo'lmaydi (bekor qilish mumkin)" });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="rule-create"/);
    expect(html).toContain("Lockdown: yangi qoida yaratib bo&#x27;lmaydi");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="rule-revoke"/);
  });
  it("forma xatosi va yuklash xatosi alert sifatida", () => {
    const html = render({ formError: "Kamida bitta vosita tanlang", loadError: "Xatolik (502)" });
    expect(html).toContain('data-testid="rule-error"');
    expect(html).toContain("Kamida bitta vosita tanlang");
    expect(html).toContain("Xatolik (502)");
  });
  it("bekor qilinayotgan qoida tugmasi o'chiq", () => {
    expect(render({ rules: [rule()], revokingId: 5 })).toMatch(/<button[^>]*disabled=""[^>]*data-testid="rule-revoke"/);
  });
  it("yig'iladigan rejim: yopiq = faqat xulosa, ochiq = qoidalar va forma", () => {
    const closed = renderToStaticMarkup(<ApprovalRulesPanelView {...props({ rules: [rule(), rule({ id: 6 })], collapsible: true, open: false })} />);
    expect(closed).toContain("2 ta faol qoida");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("rule-create");
    const open = renderToStaticMarkup(<ApprovalRulesPanelView {...props({ rules: [], collapsible: true, open: true })} />);
    expect(open).toContain("Faol qoida yo&#x27;q");
    expect(open).toContain("rule-create");
    expect(rulesCollapsedSummary(null)).toBeNull();
    expect(rulesCollapsedSummary([{ status: "revoked" }])).toBe("Faol qoida yo'q");
  });
});
