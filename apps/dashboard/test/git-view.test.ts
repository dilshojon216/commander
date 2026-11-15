import type { CommandDto, ProjectCiDto, ProjectPrDto, TaskCommitDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { BASE_CHOICES, ciBadge, commitsByTask, diffSummaryText, gitErrorText, gitHttpErrorText, parsePatchLines, pickCi, prBlockReason, prFormDefaults, prResultOf, prsForTask, taskGitInfo, validatePrForm } from "@/lib/git-view";

const PATCH = ["diff --git a/a.ts b/a.ts", "index 1..2 100644", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,4 @@", " keep", "-old", "--- dashed text", "+new", "+<script>alert(1)</script>", " tail", "\\ No newline at end of file", ""].join("\n");

describe("parsePatchLines", () => {
  it("sarlavha meta; hunk ichida qator raqamlari; '---' matni o'chirilgan qator", () => {
    const { lines, truncated } = parsePatchLines(PATCH);
    expect(truncated).toBe(false);
    expect(lines.slice(0, 4).map((l) => l.kind)).toEqual(["meta", "meta", "meta", "meta"]);
    expect(lines[4]).toMatchObject({ kind: "hunk" });
    const body = lines.slice(5);
    expect(body.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 1, 1],
      ["del", 2, null],
      ["del", 3, null], // "--- dashed text": hunk ichida oddiy o'chirilgan qator
      ["add", null, 2],
      ["add", null, 3],
      ["ctx", 4, 4],
      ["meta", null, null],
    ]);
  });
  it("matn o'zgarmaydi (HTML qochirish React'ga qoldiriladi: matn tugun)", () => {
    const { lines } = parsePatchLines(PATCH);
    expect(lines.find((l) => l.text.includes("<script>"))!.text).toBe("+<script>alert(1)</script>");
  });
  it("ikkinchi fayl bloki hunk holatini qayta boshlaydi; uzun patch kesiladi", () => {
    const two = `${PATCH}\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -5 +5 @@\n-x\n+y\n`;
    const { lines } = parsePatchLines(two);
    const second = lines.slice(lines.findIndex((l) => l.text === "diff --git a/b b/b"));
    expect(second.map((l) => l.kind)).toEqual(["meta", "meta", "meta", "hunk", "del", "add"]);
    expect(second[4]).toMatchObject({ oldNo: 5 });
    const big = parsePatchLines(Array.from({ length: 50 }, (_, i) => `+l${i}`).join("\n"), 10);
    expect(big.truncated).toBe(true);
    expect(big.lines).toHaveLength(10);
  });
});

describe("CI va PR ko'rinishi", () => {
  const ci = (branch: string, state: ProjectCiDto["state"]): ProjectCiDto => ({ branch, state, prNumber: null, prUrl: null, checks: [], run: null, checkedAt: "2026-11-13T00:00:00Z" });
  it("ciBadge va pickCi", () => {
    expect(ciBadge("failure")).toMatchObject({ label: "CI: xato" });
    expect(ciBadge("success").cls).toContain("grn");
    expect(ciBadge("unknown").label).toContain("noma'lum");
    const list = [ci("a", "success"), ci("b", "failure")];
    expect(pickCi(list, "b")!.state).toBe("failure");
    expect(pickCi(list, "zzz")!.branch).toBe("a");
    expect(pickCi([], "a")).toBeNull();
  });
  const pr = (number: number, branch: string, title: string): ProjectPrDto => ({ id: `id${number}`, projectId: "p", number, url: "https://github.com/a/b/pull/1", title, branch, base: "main", draft: false, state: "open", openedVia: "web", createdAt: "2026-11-13T00:00:00Z" });
  const tc = (sha: string, taskKey: string, ts: string): TaskCommitDto => ({ sha, taskKey, source: "subject", subject: "s", author: "a", ts });
  it("vazifaga bog'lash: branch yoki [id] sarlavha; commitlar yangidan eskiga", () => {
    const prs = [pr(1, "feat/3.5-git", "Git"), pr(2, "x", "[3.4] Shablon"), pr(3, "y", "Boshqa")];
    expect(prsForTask(prs, "3.5").map((p) => p.number)).toEqual([1]);
    expect(prsForTask(prs, "3.4").map((p) => p.number)).toEqual([2]);
    const by = commitsByTask([tc("a", "3.5", "2026-11-01T00:00:00Z"), tc("b", "3.5", "2026-11-03T00:00:00Z"), tc("c", "3.4", "2026-11-02T00:00:00Z")]);
    expect(by.get("3.5")!.map((c) => c.sha)).toEqual(["b", "a"]);
    expect(taskGitInfo("3.5", by, prs)).toMatchObject({ commits: [{ sha: "b" }, { sha: "a" }], prs: [{ number: 1 }] });
    expect(taskGitInfo("9.9", by, prs)).toBeNull();
  });
});

describe("PR formasi", () => {
  it("default: vazifa + commitlar; base main; head branch", () => {
    const f = prFormDefaults({ branch: "feat/3.5-git", taskKey: "3.5", taskTitle: "Git/PR", commitSubjects: ["feat: diff"] });
    expect(f).toMatchObject({ title: "[3.5] Git/PR", base: "main", head: "feat/3.5-git", draft: false });
    expect(f.body).toContain("feat: diff");
    expect(BASE_CHOICES).toContain("main");
  });
  it("tekshiruv: markaz sxemasi bilan bir xil; maydon xatolari", () => {
    const f = prFormDefaults({ branch: "feat/x", commitSubjects: [] });
    expect(validatePrForm(f).ok).toBe(true);
    const bad = validatePrForm({ ...f, title: "  ", base: "--web", head: "a..b", body: "x\u0000" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["base", "body", "head", "title"]);
    const noHead = validatePrForm({ ...f, head: "" });
    expect(noHead.ok && "head" in noHead.body).toBe(false);
  });
  it("bloklash sabablari", () => {
    expect(prBlockReason({ canControl: true, lockdown: false, hasProject: true })).toBeNull();
    expect(prBlockReason({ canControl: true, lockdown: true, hasProject: true })).toContain("Lockdown");
    expect(prBlockReason({ canControl: false, lockdown: false, hasProject: true })).toContain("token");
    expect(prBlockReason({ canControl: true, lockdown: false, hasProject: false })).toContain("loyihaga");
  });
  it("PR natijasi faqat https URL bilan", () => {
    const c = (status: string, pr: unknown) => ({ status, result: { pr } }) as unknown as CommandDto;
    expect(prResultOf(c("done", { url: "https://github.com/a/b/pull/7", number: 7, existing: true }))).toEqual({ url: "https://github.com/a/b/pull/7", number: 7, existing: true });
    expect(prResultOf(c("done", { url: "javascript:alert(1)", number: 7 }))).toBeNull();
    expect(prResultOf(c("running", { url: "https://x/y", number: 1 }))).toBeNull();
  });
});

describe("xato matnlari", () => {
  it("kodlar o'zbekcha; noma'lum kod ko'rsatiladi; HTTP holatlari", () => {
    expect(gitErrorText("gh_unavailable")).toContain("gh");
    expect(gitErrorText("zzz")).toBe("Bajarilmadi (zzz)");
    expect(gitErrorText(null)).toBe("Bajarilmadi");
    expect(gitHttpErrorText(409, { error: "dirty_worktree" })).toContain("commit");
    expect(gitHttpErrorText(403, {})).toContain("token");
    expect(gitHttpErrorText(0, null)).toContain("tarmoq");
  });
  it("diff xulosa", () => {
    expect(diffSummaryText({ filesTotal: 0 } as never)).toBe("O'zgarish yo'q");
    expect(diffSummaryText({ filesTotal: 2, totalAdditions: 5, totalDeletions: 1 } as never)).toBe("2 fayl · +5 / −1");
  });
});
