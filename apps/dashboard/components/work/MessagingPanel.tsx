"use client";

import type { GroupDto, GroupMember, ListGroupsResponse, MessageKind, ProjectDto } from "@commander/contracts";
import { MESSAGE_KINDS } from "@commander/contracts";
import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { MarkdownView } from "@/components/MarkdownView";
import { StatusPill } from "@/components/ui/StatusPill";
import { ApiCallError, requestJson } from "@/lib/client-api";
import { isStatus } from "@/lib/types";
import {
  EMPTY_COMPOSER,
  EMPTY_RULE,
  KIND_LABEL,
  MCP_NOTICE,
  ROLE_PRESETS,
  buildFeed,
  buildRulesBody,
  buildSendBody,
  contextIssue,
  findProjectGroup,
  linkableFor,
  messagingHttpErrorText,
  messagingWriteReason,
  roleBadge,
  roleBody,
  roleIssue,
  roleSelectValue,
  rowsFromRules,
  ruleIssues,
  slugWorkspace,
  targetOptions,
} from "@/lib/messaging-view";
import type { ComposerState, FeedItem, RuleRow } from "@/lib/messaging-view";
import { useGroupFeed } from "./useMessaging";

const KIND_STYLE: Record<MessageKind, string> = {
  api_change: "bg-blue-bg text-blue",
  question: "bg-yel-bg text-yel",
  request: "bg-org-bg text-org",
  info: "bg-gray-bg text-mu",
  answer: "bg-grn-bg text-grn",
};
const STATUS_STYLE = { pending: "text-yel", delivered: "text-mu", read: "text-grn" } as const;

/** Sessiyalar aloqasi (2.10): guruh sozlamalari, a'zolar va rollar, xabar lentasi, yozuvchi, kontekst va qoidalar. */
export function MessagingPanel({ project, groups, onReload }: { project: Pick<ProjectDto, "id" | "name" | "repoKey">; groups: ListGroupsResponse | null; onReload: () => void }) {
  const { lockdown, canControl } = useLiveData();
  const writeReason = messagingWriteReason({ lockdown, canControl });
  const group = useMemo(() => (groups ? findProjectGroup(groups.groups, project) : null), [groups, project]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onReload();
      return true;
    } catch (e) {
      setError(e instanceof ApiCallError ? messagingHttpErrorText(e.status, e.body) : messagingHttpErrorText(0, null));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!groups) return <div className="sk h-40" aria-busy="true" />;

  return (
    <div className="flex flex-col gap-4" data-testid="messaging-panel">
      <div role="note" className="rounded-lg bg-s2 px-3 py-2 text-xs text-mu" data-testid="mcp-notice">
        {MCP_NOTICE}.
      </div>
      {writeReason && (
        <div role="note" className="rounded-lg bg-org-bg px-3 py-2 text-xs text-org">
          {writeReason}
        </div>
      )}
      {!groups.settings.enabled && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="global-off">
          Xabarlashuv global o&apos;chirgichi o&apos;chiq: hech bir guruhda xabar almashinmaydi.
          <button type="button" className="btn h-7 text-xs" disabled={!!writeReason || busy} title={writeReason ?? undefined} onClick={() => void run(() => requestJson("PUT", "/messaging/settings", { enabled: true }))}>
            Yoqish
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="messaging-error">
          {error}
        </div>
      )}

      {!group ? (
        <section className="card flex flex-col gap-1.5 p-5 text-mu" data-testid="no-group">
          <b className="text-tx">Xabarlashuv guruhi hali yo&apos;q</b>
          <span>Guruh loyihada birinchi Claude sessiyasi boshlangach paydo bo&apos;ladi. U shu loyiha (repo) sessiyalarini bir-biriga bog&apos;laydi.</span>
        </section>
      ) : (
        <GroupBody key={group.key} project={project} group={group} groups={groups} writeReason={writeReason} busy={busy} run={run} />
      )}
    </div>
  );
}

function GroupBody({ project, group, groups, writeReason, busy, run }: { project: Pick<ProjectDto, "id" | "name" | "repoKey">; group: GroupDto; groups: ListGroupsResponse; writeReason: string | null; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const feed = useGroupFeed(group.key);
  const items = useMemo(() => buildFeed(feed.items), [feed.items]);
  const [composer, setComposer] = useState<ComposerState>(EMPTY_COMPOSER);
  const [sendError, setSendError] = useState<string | null>(null);
  const dis = !!writeReason || busy;

  async function send() {
    setSendError(null);
    const b = buildSendBody(group.key, composer);
    if (!b.ok) return setSendError(b.error);
    const ok = await run(() => requestJson("POST", "/messaging/messages", b.body));
    if (ok) {
      setComposer({ ...EMPTY_COMPOSER, to: composer.to, kind: composer.kind });
      feed.reload();
    }
  }

  return (
    <>
      <GroupHeader project={project} group={group} groups={groups} writeReason={writeReason} busy={busy} run={run} />
      <Members group={group} writeReason={writeReason} run={run} />

      <div className="flex flex-wrap items-start gap-4">
        <section className="card min-w-0 flex-[999_1_560px] overflow-hidden" aria-label="Sessiyalararo xabarlar">
          <div className="flex items-center gap-2 px-4 py-3">
            <b className="flex-1">Sessiyalararo xabarlar</b>
            {group.unread > 0 && (
              <span className="pill bg-org text-white" style={{ height: 20 }} data-testid="group-unread">
                {group.unread} o&apos;qilmagan
              </span>
            )}
          </div>
          {feed.error && <p className="m-0 border-t border-bd px-4 py-2 text-xs text-red">{feed.error}</p>}
          {items.length === 0 && !feed.loading && <p className="m-0 border-t border-bd px-4 py-4 text-mu">{group.enabled ? "Hozircha xabar yo'q." : "Xabarlashuv o'chiq: yoqilgach xabarlar shu yerda ko'rinadi."}</p>}
          {items.map((it) => (
            <FeedWithReplies key={it.batchId} item={it} onReply={(i) => setComposer((c) => ({ ...c, to: "all", kind: "answer", replyTo: i.id, subject: i.subject.startsWith("Re: ") ? i.subject : `Re: ${i.subject}`.slice(0, 120) }))} />
          ))}
          {feed.hasMore && (
            <div className="border-t border-bd px-4 py-2.5">
              <button type="button" className="btn h-7 text-xs" disabled={feed.loading} onClick={feed.loadMore}>
                {feed.loading ? "Yuklanmoqda…" : "Oldingi xabarlar"}
              </button>
            </div>
          )}
          <Composer group={group} state={composer} setState={setComposer} onSend={() => void send()} error={sendError} disabled={dis} writeReason={writeReason} />
        </section>

        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-4" aria-label="Kontekst va qoidalar">
          <ContextEditor group={group} writeReason={writeReason} busy={busy} run={run} />
          <RulesEditor group={group} writeReason={writeReason} busy={busy} run={run} />
        </aside>
      </div>
    </>
  );
}

function Toggle({ label, hint, checked, disabled, title, onChange, testId }: { label: string; hint: string; checked: boolean; disabled: boolean; title?: string; onChange: (v: boolean) => void; testId: string }) {
  return (
    <label className="flex items-start gap-2.5" title={title}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" data-testid={testId} />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-mu">{hint}</span>
      </span>
    </label>
  );
}

function GroupHeader({ project, group, groups, writeReason, busy, run }: { project: Pick<ProjectDto, "id" | "name">; group: GroupDto; groups: ListGroupsResponse; writeReason: string | null; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const dis = !!writeReason || busy;
  const linkable = linkableFor(groups, group);
  const [pick, setPick] = useState("");
  const [workspace, setWorkspace] = useState(group.workspace ?? slugWorkspace(project.name));
  const ws = group.workspace ?? slugWorkspace(workspace);
  const patch = (b: { enabled?: boolean; autoWake?: boolean; telegramQuestions?: boolean }) => run(() => requestJson("PATCH", "/messaging/groups", { key: group.key, ...b }));

  async function link() {
    if (!pick || !ws) return;
    const own = group.workspace ? [] : group.baseKeys;
    await run(async () => {
      for (const b of own) await requestJson("PUT", "/messaging/links", { baseKey: b, workspace: ws });
      await requestJson("PUT", "/messaging/links", { baseKey: pick, workspace: ws });
    });
    setPick("");
  }

  return (
    <section className="card flex flex-col gap-3 p-4" aria-label="Guruh" data-testid="group-header">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-sm">Guruh: {group.label}</b>
        <span className={`pill ${group.enabled ? "bg-grn-bg text-grn" : "bg-gray-bg text-mu"}`} data-testid="group-state">
          {group.enabled ? "Yoqilgan" : "O'chiq"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="Bog'langan loyihalar">
        <span className="lbl">Bog&apos;langan loyihalar</span>
        {group.baseKeys.map((b) => (
          <span key={b} className="pill mono bg-s3 text-tx" style={{ height: 22 }}>
            {b.replace(/^github\.com\//, "").replace(/^project:.*$/, group.label)}
            {group.workspace && (
              <button type="button" aria-label={`${b}: bog'lanishni uzish`} title="Bog'lanishni uzish" disabled={dis} className="border-0 bg-transparent p-0 text-mu" style={{ cursor: dis ? "not-allowed" : "pointer" }} onClick={() => void run(() => requestJson("DELETE", `/messaging/links?${new URLSearchParams({ baseKey: b })}`))}>
                ✕
              </button>
            )}
          </span>
        ))}
        {linkable.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            <select className="sel" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Loyiha bog'lash" disabled={dis}>
              <option value="">Loyiha bog&apos;lash…</option>
              {linkable.map((l) => (
                <option key={l.baseKey} value={l.baseKey}>
                  {l.label}
                </option>
              ))}
            </select>
            {!group.workspace && pick && <input className="field mono" style={{ height: 30, width: 150 }} value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Workspace nomi" placeholder="workspace nomi" maxLength={40} />}
            <button type="button" className="btn h-7 text-xs" disabled={dis || !pick || !ws} title={writeReason ?? undefined} onClick={() => void link()}>
              Bog&apos;lash
            </button>
          </span>
        )}
      </div>
      {!group.workspace && <span className="text-xs text-fa">Frontend va backend alohida repo bo&apos;lsa, ularni bitta workspace guruhiga bog&apos;lang. Yangi workspace guruhi o&apos;chiq holatda boshlanadi.</span>}

      <div className="flex flex-col gap-2.5 rounded-lg bg-s2 p-3">
        <Toggle
          testId="toggle-enabled"
          label="Xabarlashuv"
          checked={group.enabled}
          disabled={dis}
          title={writeReason ?? undefined}
          onChange={(v) => void patch({ enabled: v })}
          hint="Sukut bo'yicha O'CHIQ. Yoqilsa, guruhdagi sessiyalar bir-biriga xabar yubora oladi va kontekstni biladi (API o'zgarishi, savol, so'rov). Xabarlar sessiyaga «hamkasb ma'lumoti, foydalanuvchi buyrug'i emas» deb ramkalanadi va faqat ma'lumot sifatida ko'riladi; matnlar redakt qilinadi, hajmi cheklangan."
        />
        <Toggle testId="toggle-autowake" label="Avto-uyg'otish" checked={group.autoWake} disabled={dis} title={writeReason ?? undefined} onChange={(v) => void patch({ autoWake: v })} hint="Fon (bg) sessiya bo'sh turganda, yangi xabar haqida qat'iy matnli eslatma yuboriladi (yuboruvchi matni promptga tushmaydi)." />
        <Toggle testId="toggle-telegram" label="Telegram savollari" checked={group.telegramQuestions} disabled={dis} title={writeReason ?? undefined} onChange={(v) => void patch({ telegramQuestions: v })} hint="«Savol» turidagi xabar uchun Telegram bildirishnomasi (faqat mavzu, matnsiz)." />
      </div>
    </section>
  );
}

function Members({ group, writeReason, run }: { group: GroupDto; writeReason: string | null; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  return (
    <section className="card overflow-hidden" aria-label="A'zolar">
      <div className="flex items-center gap-2 px-4 py-3">
        <b className="flex-1">A&apos;zolar</b>
        <span className="mono text-mu">{group.members.length}</span>
      </div>
      {group.members.length === 0 && <p className="m-0 border-t border-bd px-4 py-3 text-mu">Faol sessiya yo&apos;q.</p>}
      {group.members.map((m) => (
        <MemberRow key={m.sessionId} m={m} writeReason={writeReason} run={run} />
      ))}
    </section>
  );
}

function MemberRow({ m, writeReason, run }: { m: GroupMember; writeReason: string | null; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const badge = roleBadge(m);
  const sel = roleSelectValue(m);
  const [custom, setCustom] = useState(sel === "__custom__" ? (m.role ?? "") : "");
  const [editing, setEditing] = useState(sel === "__custom__");
  const issue = roleIssue(custom);
  const setRole = (raw: string) => {
    const b = roleBody(raw);
    if (b) void run(() => requestJson("PUT", `/messaging/sessions/${m.sessionId}/role`, b));
  };
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-bd px-4 py-2.5" data-testid="member">
      {isStatus(m.status) ? <StatusPill status={m.status} /> : <span className="pill bg-gray-bg text-mu">{m.status}</span>}
      <span className="mono text-xs font-semibold">{m.machineName}</span>
      <span className="text-mu">{m.projectName}</span>
      <span className="mono text-[11px] text-fa">{m.shortId}</span>
      {m.taskKey && (
        <span className="pill mono bg-s3 text-mu" style={{ height: 18, fontSize: 10 }}>
          {m.taskKey}
        </span>
      )}
      {m.unread > 0 && (
        <span className="pill bg-org text-white" style={{ height: 18, fontSize: 11 }} title="O'qilmagan xabarlar">
          {m.unread}
        </span>
      )}
      <span className="flex-1" />
      <span className={`pill ${badge.guess ? "text-mu" : "bg-blue-bg text-blue"}`} style={badge.guess ? { border: "1px dashed var(--mu)" } : undefined} data-testid="role-pill" title={badge.guess ? "Loyiha nomidan taxmin qilingan rol" : "Belgilangan rol"}>
        {badge.text}
        {badge.guess && <span className="text-[10px]">taxmin</span>}
      </span>
      <select
        className="sel"
        aria-label={`${m.shortId}: rol`}
        disabled={!!writeReason}
        title={writeReason ?? undefined}
        value={editing ? "__custom__" : sel}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__custom__") setEditing(true);
          else {
            setEditing(false);
            setRole(v);
          }
        }}
      >
        <option value="">(taxmin)</option>
        {ROLE_PRESETS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
        <option value="__custom__">boshqa…</option>
      </select>
      {editing && (
        <span className="flex items-center gap-1.5">
          <input className="field mono" style={{ height: 30, width: 130 }} value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Rol nomi" maxLength={32} placeholder="rol" />
          <button type="button" className="btn h-7 text-xs" disabled={!!writeReason || !custom.trim() || !!issue} title={issue ?? writeReason ?? undefined} onClick={() => setRole(custom)}>
            Saqlash
          </button>
        </span>
      )}
    </div>
  );
}

function FeedCard({ item, onReply, nested = false }: { item: FeedItem; onReply: (i: FeedItem) => void; nested?: boolean }) {
  return (
    <div className={`flex gap-3 border-t border-bd px-4 py-3 ${nested ? "bg-s2 pl-10" : ""}`} data-testid="feed-item" data-kind={item.kind}>
      <span className="mono w-11 shrink-0 text-xs text-mu" suppressHydrationWarning>
        {item.time}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="pill bg-blue-bg text-blue" style={{ height: 20 }} title={item.fromLabel}>
            {item.fromRole}
          </span>
          <span className="text-mu">→</span>
          <span className="pill bg-grn-bg text-grn" style={{ height: 20 }}>
            {item.toSummary}
          </span>
          <span className={`pill ${KIND_STYLE[item.kind]}`} style={{ height: 20 }}>
            {item.kindLabel}
          </span>
          {item.replyRef && <span className="mono text-[11px] text-fa">{item.replyRef}</span>}
        </div>
        <b>{item.subject}</b>
        <MarkdownView content={item.body} className="text-[13px]" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {item.recipients.map((r) => (
            <span key={r.messageId} className={STATUS_STYLE[r.status]} data-testid="recipient" data-status={r.status} title={r.deliveredAt ? `Yetkazildi: ${r.deliveredAt}${r.readAt ? ` · O'qildi: ${r.readAt}` : ""}` : "Hali yetkazilmagan"}>
              {r.status === "read" ? "✓✓" : r.status === "delivered" ? "✓" : "◷"} {r.role ?? r.label}: {r.statusLabel}
            </span>
          ))}
          <button type="button" className="border-0 bg-transparent p-0 text-blue" style={{ cursor: "pointer", font: "inherit" }} onClick={() => onReply(item)}>
            Javob berish
          </button>
        </div>
      </div>
    </div>
  );
}

function FeedWithReplies({ item, onReply }: { item: FeedItem; onReply: (i: FeedItem) => void }) {
  return (
    <>
      <FeedCard item={item} onReply={onReply} />
      {item.replies.map((r) => (
        <FeedCard key={r.batchId} item={r} onReply={onReply} nested />
      ))}
    </>
  );
}

function Composer({ group, state, setState, onSend, error, disabled, writeReason }: { group: GroupDto; state: ComposerState; setState: (f: (c: ComposerState) => ComposerState) => void; onSend: () => void; error: string | null; disabled: boolean; writeReason: string | null }) {
  const opts = targetOptions(group.members);
  const off = !group.enabled;
  return (
    <div className="flex flex-col gap-2 border-t border-bd bg-s2 px-4 py-3" data-testid="composer">
      {off && <span className="text-xs text-org">Xabarlashuv o&apos;chiq: yuborish uchun avval guruhda yoqing.</span>}
      {state.replyTo && (
        <span className="flex items-center gap-2 text-xs text-mu">
          Javob: #{state.replyTo.slice(0, 8)}
          <button type="button" className="border-0 bg-transparent p-0 text-blue" style={{ cursor: "pointer", font: "inherit" }} onClick={() => setState((c) => ({ ...c, replyTo: null }))}>
            bekor
          </button>
        </span>
      )}
      <div className="flex flex-wrap gap-2">
        <select className="sel" value={state.to} onChange={(e) => setState((c) => ({ ...c, to: e.target.value }))} aria-label="Qabul qiluvchi">
          {opts.map((o) => (
            <option key={`${o.group}-${o.value}`} value={o.value}>
              → {o.label}
            </option>
          ))}
        </select>
        <select className="sel" value={state.kind} onChange={(e) => setState((c) => ({ ...c, kind: e.target.value as MessageKind }))} aria-label="Xabar turi">
          {MESSAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input className="field min-w-[200px] flex-1" style={{ height: 32, fontFamily: "var(--font-sans)" }} value={state.subject} onChange={(e) => setState((c) => ({ ...c, subject: e.target.value }))} placeholder="Mavzu" aria-label="Mavzu" maxLength={120} />
      </div>
      <textarea
        rows={3}
        value={state.body}
        onChange={(e) => setState((c) => ({ ...c, body: e.target.value }))}
        placeholder="Sessiyaga kontekst yoki ko'rsatma yuboring…"
        aria-label="Xabar matni"
        maxLength={4000}
        className="resize-y rounded-lg border border-bd bg-s1 px-3 py-2 text-tx"
        style={{ font: "13px/1.5 var(--font-sans)" }}
      />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-fa">Xabar sessiyaga keyingi prompt oldidan «foydalanuvchi xabari» sifatida kontekstga qo&apos;shiladi. {state.body.length}/4000</span>
        {error && (
          <span role="alert" className="text-xs text-red" data-testid="send-error">
            {error}
          </span>
        )}
        <button type="button" className="btn btn-pri" disabled={disabled || off} title={writeReason ?? (off ? "Xabarlashuv o'chiq" : undefined)} onClick={onSend}>
          Yuborish
        </button>
      </div>
    </div>
  );
}

function ContextEditor({ group, writeReason, busy, run }: { group: GroupDto; writeReason: string | null; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  // Tahrirlanmaguncha markazdagi joriy matn ko'rinadi (jonli yangilanadi); tahrir boshlangach foydalanuvchi matni
  const [edited, setEdited] = useState<string | null>(null);
  const saved = group.context ?? "";
  const text = edited ?? saved;
  const dirty = edited !== null && edited !== saved;
  const issue = contextIssue(text);
  return (
    <section className="card flex flex-col gap-2 p-4" aria-label="Umumiy kontekst" data-testid="context-editor">
      <span className="lbl">Umumiy kontekst</span>
      <span className="text-xs text-mu">
        Guruh sessiyalari `commander_context` orqali o&apos;qiydi (markdown, ≤16 KB, maxfiy qiymatlar redakt qilinadi).
        {group.contextUpdatedAt ? ` Oxirgi yangilanish: ${group.contextUpdatedAt.slice(0, 16).replace("T", " ")} UTC.` : ""}
      </span>
      <textarea rows={8} value={text} onChange={(e) => setEdited(e.target.value)} aria-label="Umumiy kontekst matni" placeholder="# Loyiha konteksti&#10;- API: openapi.yaml&#10;- Kelishuvlar…" className="resize-y rounded-lg border border-bd bg-s1 px-3 py-2 text-tx" style={{ font: "12px/1.5 var(--font-mono)" }} />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-fa">{text.length}/16000{dirty ? " · saqlanmagan" : ""}</span>
        {issue && <span className="text-xs text-red">{issue}</span>}
        {dirty && (
          <button type="button" className="btn" disabled={busy} onClick={() => setEdited(null)}>
            Bekor
          </button>
        )}
        <button
          type="button"
          className="btn btn-pri"
          disabled={!!writeReason || busy || !!issue || !dirty}
          title={writeReason ?? undefined}
          onClick={() => {
            void run(() => requestJson("PUT", "/messaging/groups/context", { key: group.key, context: text })).then((ok) => {
              if (ok) setEdited(null);
            });
          }}
        >
          Saqlash
        </button>
      </div>
    </section>
  );
}

function RulesEditor({ group, writeReason, busy, run }: { group: GroupDto; writeReason: string | null; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [rows, setRows] = useState<RuleRow[]>(() => rowsFromRules(group.rules));
  const [dirty, setDirty] = useState(false);
  const issues = ruleIssues(rows);
  const body = buildRulesBody(group.key, rows);
  const roles = [...new Set([...ROLE_PRESETS, ...group.members.map((m) => m.role).filter((r): r is string => !!r)])];
  const patch = (i: number, p: Partial<RuleRow>) => {
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));
    setDirty(true);
  };
  return (
    <section className="card flex flex-col gap-2 p-4" aria-label="Avto-yo'naltirish qoidalari" data-testid="rules-editor">
      <span className="lbl">Avto-yo&apos;naltirish qoidalari</span>
      <span className="text-xs text-mu">Xabar manzili «Avto» bo&apos;lsa, qoidalar tartib bilan tekshiriladi: birinchi mos kelgani ishlaydi (tur va/yoki kalit so&apos;z → rol).</span>
      <datalist id="rule-roles">
        {roles.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-1" data-testid="rule-row">
          <div className="flex flex-wrap items-center gap-1.5">
            <select className="sel" value={r.kind} onChange={(e) => patch(i, { kind: e.target.value as RuleRow["kind"] })} aria-label="Tur">
              <option value="">har qanday tur</option>
              {MESSAGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <input className="field" style={{ height: 30, width: 130, fontFamily: "var(--font-sans)" }} value={r.keyword} onChange={(e) => patch(i, { keyword: e.target.value })} placeholder="kalit so'z" aria-label="Kalit so'z" maxLength={60} />
            <span className="text-mu">→</span>
            <input className="field mono" list="rule-roles" style={{ height: 30, width: 100 }} value={r.toRole} onChange={(e) => patch(i, { toRole: e.target.value })} placeholder="rol" aria-label="Qabul qiluvchi rol" maxLength={32} />
            <button
              type="button"
              className="btn h-7 w-7 p-0"
              aria-label="Qoidani o'chirish"
              onClick={() => {
                setRows((rs) => rs.filter((_, k) => k !== i));
                setDirty(true);
              }}
            >
              ✕
            </button>
          </div>
          {issues.filter((x) => x.index === i).map((x) => (
            <span key={x.message} className="text-[11px] text-red">
              {x.message}
            </span>
          ))}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn h-7 text-xs"
          disabled={rows.length >= 20}
          onClick={() => {
            setRows((rs) => [...rs, { ...EMPTY_RULE }]);
            setDirty(true);
          }}
        >
          + Qoida
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-pri"
          disabled={!!writeReason || busy || !body || !dirty}
          title={writeReason ?? undefined}
          onClick={() => {
            if (body) void run(() => requestJson("PUT", "/messaging/groups/rules", body)).then((ok) => ok && setDirty(false));
          }}
        >
          Saqlash
        </button>
      </div>
    </section>
  );
}
