import { describe, expect, it } from "vitest";
import { AskQuestionsSchema } from "@commander/contracts";
import { answeredCount, draftAnswers, emptyDraft, setOtherText, toggleOther, togglePick } from "../lib/question-ui";

const qs = AskQuestionsSchema.parse([
  { question: "Which color?", header: "Color", options: [{ label: "Red (Recommended)" }, { label: "Blue" }], multiSelect: false },
  { question: "Toppings?", header: "T", options: [{ label: "Cheese" }, { label: "Ham" }, { label: "Olives" }], multiSelect: true },
]);

describe("question draft", () => {
  it("boshida hech narsa tanlanmagan (tavsiya avtomatik tanlanmaydi); javoblar to'liq emas", () => {
    const d = emptyDraft(qs);
    expect(d.every((x) => x.picks.length === 0 && !x.useOther)).toBe(true);
    expect(draftAnswers(qs, d)).toBeNull();
    expect(answeredCount(qs, d)).toBe(0);
  });

  it("radio: ikkinchi variant birinchisini almashtiradi; multiSelect: belgilash/olib tashlash", () => {
    let d = togglePick(emptyDraft(qs), qs, 0, 0);
    d = togglePick(d, qs, 0, 1);
    expect(d[0]!.picks).toEqual([1]);
    d = togglePick(d, qs, 1, 2);
    d = togglePick(d, qs, 1, 0);
    expect(d[1]!.picks).toEqual([0, 2]);
    d = togglePick(d, qs, 1, 2);
    expect(d[1]!.picks).toEqual([0]);
    expect(draftAnswers(qs, d)).toEqual([{ q: 0, picks: [1] }, { q: 1, picks: [0] }]);
  });

  it("Boshqa: bir tanlovlida variantni almashtiradi; multiSelect'da variantlar bilan birga; bo'sh matn javob emas", () => {
    let d = togglePick(emptyDraft(qs), qs, 0, 1);
    d = toggleOther(d, qs, 0);
    expect(d[0]).toMatchObject({ picks: [], useOther: true });
    expect(draftAnswers(qs, d)).toBeNull(); // matn yo'q
    d = setOtherText(d, 0, "  Yashil  ");
    d = togglePick(d, qs, 1, 1);
    d = toggleOther(d, qs, 1);
    d = setOtherText(d, 1, "Pepperoni");
    expect(draftAnswers(qs, d)).toEqual([{ q: 0, picks: [], other: "Yashil" }, { q: 1, picks: [1], other: "Pepperoni" }]);
    expect(answeredCount(qs, d)).toBe(2);
  });

  it("Boshqa o'chirilsa matn javobga kirmaydi", () => {
    let d = toggleOther(emptyDraft(qs), qs, 0);
    d = setOtherText(d, 0, "Yashil");
    d = toggleOther(d, qs, 0);
    d = togglePick(d, qs, 0, 0);
    d = togglePick(d, qs, 1, 0);
    expect(draftAnswers(qs, d)).toEqual([{ q: 0, picks: [0] }, { q: 1, picks: [0] }]);
  });

  it("noto'g'ri indeks e'tiborsiz", () => {
    const d = emptyDraft(qs);
    expect(togglePick(d, qs, 0, 9)).toBe(d);
    expect(togglePick(d, qs, 9, 0)).toBe(d);
  });
});
