import type { CommandDto, DiffFile, ProjectTaskDto, TokenTotals } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilePatch } from "@/components/git/DiffPanel";
import { PrStatus } from "@/components/git/OpenPrDialog";
import { TaskGit } from "@/components/git/TaskGit";
import { BoardTab } from "@/components/work/BoardTab";
import { prResultOf } from "@/lib/git-view";

const file = (over: Partial<DiffFile> = {}): DiffFile => ({ path: "src/a.ts", oldPath: null, status: "modified", additions: 2, deletions: 1, binary: false, patch: null, truncated: false, hidden: null, ...over });

describe("<FilePatch />", () => {
  it("qo'shilgan/o'chirilgan qatorlar; HTML belgilari matn sifatida qochiriladi (XSS yo'q)", () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-const a = '<img src=x onerror=alert(1)>';\n+<script>alert(1)</script>\n ctx";
    const html = renderToStaticMarkup(<FilePatch file={file({ patch })} />);
    expect(html).toContain('data-kind="add"');
    expect(html).toContain('data-kind="del"');
    expect(html).toContain('data-kind="hunk"');
    expect(html).toContain("+&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });
  it("matn yo'q: maxfiy / binar sababi ko'rsatiladi", () => {
    const secret = renderToStaticMarkup(<FilePatch file={file({ path: ".env", hidden: "secret" })} />);
    expect(secret).toContain('data-testid="patch-hidden"');
    expect(secret).toContain("Maxfiy");
    expect(renderToStaticMarkup(<FilePatch file={file({ hidden: "binary", binary: true })} />)).toContain("Binar fayl");
  });
  it("qisqartirilgan patch belgisi", () => {
    expect(renderToStaticMarkup(<FilePatch file={file({ patch: "@@ -1 +1 @@\n+x", truncated: true })} />)).toContain("qisqartirilgan");
  });
});

describe("<PrStatus />", () => {
  const cmd = (over: Partial<CommandDto>): CommandDto => ({ id: "c1", type: "project.open_pr", status: "sent", errorCode: null, result: null, ...over }) as CommandDto;
  it("natija: PR havolasi (https, noopener); xato o'zbekcha; tasdiq kutilmoqda", () => {
    const done = cmd({ status: "done", result: { pr: { url: "https://github.com/a/b/pull/7", number: 7, existing: false } } });
    const html = renderToStaticMarkup(<PrStatus command={done} result={prResultOf(done)} />);
    expect(html).toContain("PR #7 ochildi");
    expect(html).toContain('href="https://github.com/a/b/pull/7"');
    expect(html).toContain('rel="noopener noreferrer"');
    const bad = cmd({ status: "done", result: { pr: { url: "javascript:alert(1)", number: 7 } } });
    expect(renderToStaticMarkup(<PrStatus command={bad} result={prResultOf(bad)} />)).not.toContain("javascript:");
    const failed = cmd({ status: "failed", errorCode: "gh_unavailable" });
    const fh = renderToStaticMarkup(<PrStatus command={failed} result={null} />);
    expect(fh).toContain("GitHub CLI");
    expect(fh).toContain('data-status="failed"');
    expect(renderToStaticMarkup(<PrStatus command={cmd({ status: "awaiting_confirmation" })} result={null} />)).toContain("Telegram");
  });
});

const tok = (n: number): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: n, cacheCreationTokens: 0, totalTokens: n, costUsd: null, requests: 1 });
const task = (key: string): ProjectTaskDto => ({
  part: "",
  key, title: `Vazifa ${key}`, phase: "Faza 1", status: "todo", rawStatus: null, order: 1, size: null,
  stats: { tokens: tok(0), sessions: 0, activeSeconds: 0, firstActivityAt: null, lastActivityAt: null, source: null },
  column: "todo", columnSource: "derived", plan: { estimateHours: null, estimateSource: null, actualHours: 0, ratio: null }, score: null,
});

describe("doska kartasi: bog'langan commit va PR", () => {
  const info = {
    commits: [
      { sha: "a".repeat(40), taskKey: "3.5", source: "subject" as const, subject: "feat: diff <b>x</b>", author: "Ali", ts: "2026-11-13T00:00:00Z" },
      { sha: "b".repeat(40), taskKey: "3.5", source: "branch" as const, subject: "wip", author: "Ali", ts: "2026-11-12T00:00:00Z" },
    ],
    prs: [{ id: "p1", projectId: "x", number: 42, url: "https://github.com/a/b/pull/42", title: "t", branch: "feat/3.5-x", base: "main", draft: false, state: "open" as const, openedVia: "web", createdAt: "2026-11-13T00:00:00Z" }],
  };
  it("TaskGit: PR havolasi, commit soni, taxmin belgisi, subject matn sifatida", () => {
    const html = renderToStaticMarkup(<TaskGit info={info} />);
    expect(html).toContain("PR #42");
    expect(html).toContain("2 commit");
    expect(html).toContain("aaaaaaa");
    expect(html).toContain("taxmin");
    expect(html).toContain("feat: diff &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
  it("BoardTab: faqat bog'lanishi bor kartada ko'rsatiladi", () => {
    const props = { activeByTask: new Map(), attachable: [], writeReason: null, onMove: () => undefined, onAttach: () => undefined, onNewSession: () => undefined, attachReason: null, newReason: null, error: null };
    const html = renderToStaticMarkup(<BoardTab {...props} tasks={[task("3.5"), task("9.9")]} gitByTask={(k) => (k === "3.5" ? info : null)} />);
    expect((html.match(/data-testid="task-git"/g) ?? []).length).toBe(1);
    const none = renderToStaticMarkup(<BoardTab {...props} tasks={[task("3.5")]} />);
    expect(none).not.toContain("task-git");
  });
});
