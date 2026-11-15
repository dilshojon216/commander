import { describe, expect, it } from "vitest";
import { parseTasksMarkdown, summarizeTasks } from "@/lib/tasks-md";

const SAMPLE = `# Ish ro'yxati

## Faza 0 — Poydevor

Matn.

| # | Task | Nega | Hajm |
|---|---|---|---|
| 0.1 | ✅ **(2026-11-13 bajarildi, PLAN.md)** **Spike: imkoniyatlarni tekshirish** — (a) hook; (b) OTel | Sabab | M |
| 0.2 | ✅ **(2026-11-13 bajarildi)** Nx monorepo: \`server/\`→\`apps/center\` | Sabab | S |

## Faza 2 — Boshqaruv

| # | Task | Nega | Hajm |
|---|---|---|---|
| 2.1 | agentd project reporter | Sabab | M |
| 2.2 | 🚧 Center \`projects\` | Sabab | L |

Boshqa jadval (ahamiyatsiz):

| Nom | Qiymat |
|---|---|
| a | b |
`;

describe("parseTasksMarkdown", () => {
  const rows = parseTasksMarkdown(SAMPLE);
  it("faqat # | Task jadvallarini o'qiydi", () => {
    expect(rows.map((r) => r.id)).toEqual(["0.1", "0.2", "2.1", "2.2"]);
  });
  it("✅ = bajarilgan, 🚧 = jarayonda, boshqasi = qoldi", () => {
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "todo", "doing"]);
  });
  it("sarlavha tozalanadi (izoh va markdown belgilarsiz)", () => {
    expect(rows[0].title).toBe("Spike: imkoniyatlarni tekshirish");
    expect(rows[1].title).toBe("Nx monorepo: server/→apps/center");
    expect(rows[3].title).toBe("Center projects");
  });
  it("faza va hajm", () => {
    expect(rows[0].phase).toBe("Faza 0 — Poydevor");
    expect(rows[2].phase).toBe("Faza 2 — Boshqaruv");
    expect(rows[0].size).toBe("M");
  });
  it("alohida 'Holat' ustuni bo'lsa undan o'qiladi", () => {
    const md = "| # | Vazifa | Holat |\n|---|---|---|\n| T-1 | Birinchi | Bajarildi |\n| T-2 | Ikkinchi | Jarayonda |\n| T-3 | Uchinchi | Qoldi |\n";
    expect(parseTasksMarkdown(md).map((r) => r.status)).toEqual(["done", "doing", "todo"]);
  });
  it("jadval yo'q / buzuq kiritma: bo'sh ro'yxat", () => {
    expect(parseTasksMarkdown("")).toEqual([]);
    expect(parseTasksMarkdown("faqat matn\n| a | b |\n")).toEqual([]);
  });
});

describe("summarizeTasks", () => {
  it("foizlar", () => {
    const s = summarizeTasks([{ status: "done" }, { status: "done" }, { status: "doing" }, { status: "todo" }]);
    expect(s).toMatchObject({ done: 2, doing: 1, todo: 1, total: 4, donePct: 50, doingPct: 25 });
    expect(summarizeTasks([]).donePct).toBe(0);
  });
});
