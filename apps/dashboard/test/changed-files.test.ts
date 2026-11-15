import { describe, expect, it } from "vitest";
import type { ChatItem as WireItem } from "@commander/contracts";
import { changedFiles, editPath } from "../lib/chat-map";

const use = (id: string, toolName: string, summary: string, ts: number, lines?: { added: number; removed: number }): WireItem =>
  ({ kind: "tool_use", id, ts, toolUseId: id, toolName, summary, ...(lines ? { lines } : {}) }) as WireItem;

describe("changedFiles", () => {
  it("Edit/Write bo'yicha fayllarni jamlaydi, eng so'nggisi birinchi; Read/Bash hisobga olinmaydi", () => {
    const raw = [
      use("1", "Edit", "Edit: src/a.ts (+3 -1)", 10, { added: 3, removed: 1 }),
      use("2", "Read", "Read: src/b.ts", 11),
      use("3", "Write", "Write: src/b.ts (+20)", 12, { added: 20, removed: 0 }),
      use("4", "MultiEdit", "Edit: src/a.ts (+2 -2)", 13, { added: 2, removed: 2 }),
      use("5", "Bash", "Bash: npm test", 14),
    ];
    expect(changedFiles(raw)).toEqual([
      { path: "src/a.ts", added: 5, removed: 3, edits: 2, lastTs: 13 },
      { path: "src/b.ts", added: 20, removed: 0, edits: 1, lastTs: 12 },
    ]);
  });
  it("yo'l bo'lmasa o'tkazib yuboradi", () => {
    expect(editPath("Edit", "Edit: ")).toBeNull();
    expect(changedFiles([use("1", "Edit", "Edit:  (+1 -0)", 1, { added: 1, removed: 0 })])).toEqual([]);
  });
});
