"use client";

import { ListSessionEventsResponseV1Schema, SessionDtoSchema } from "@commander/contracts";
import type { ApprovalDto, SessionDto, SessionEventDto } from "@commander/contracts";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { ApprovalRulesPanel } from "@/components/rules/ApprovalRulesPanel";
import { SummaryCard } from "@/components/intelligence/SummaryCard";
import { ChatStream } from "@/components/chat/ChatStream";
import { PromptBox } from "@/components/chat/PromptBox";
import { useLiveData } from "@/components/LiveData";
import { IconBack, IconStop, IconTerminal } from "@/components/ui/icons";
import { LivePill } from "@/components/ui/PageHeader";
import { ApiErrorBar } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { TaskPill } from "@/components/TaskPill";
import { getJson } from "@/lib/client-api";
import { shortenPath } from "@/lib/chat-format";
import { formatClock, formatCost, formatCount, formatTokens } from "@/lib/format";
import { shortMachineName } from "@/lib/machines";
import { MODE_OPTIONS, kindLabel, otherPermissionMode, readPermissionMode } from "@/lib/permission-mode";
import { buildHistory } from "@/lib/session-history";
import { trailingApprovals } from "@/lib/session-approvals";
import { useNow } from "@/lib/use-now";
import { STATUS_COLOR, displayStatus } from "@/lib/status";
import { useSessionChat } from "@/lib/use-session-chat";
import type { ChatErrorCode, ChatState } from "@/lib/chat-types";
import { useLiveSync } from "@/lib/use-live-sync";
import { CommandProgress } from "@/components/control/CommandProgress";
import { ResumeButton } from "@/components/control/ResumeButton";
import { SessionExtraActions } from "@/components/control/SessionExtraActions";
import { useCommandRunner, useSessionCommandBootstrap, useTrackedCommand } from "@/components/control/useControl";
import { Dialog } from "@/components/ui/Dialog";
import { SET_MODE_HINT, isInFlight, promptBoxState, stopState } from "@/lib/control-ui";
import { DiffPanel } from "@/components/git/DiffPanel";
import { OpenPrDialog } from "@/components/git/OpenPrDialog";
import { prBlockReason } from "@/lib/git-view";

interface Snapshot {
  session: SessionDto;
  events: SessionEventDto[];
}

const PHASE2 = "2-bosqichda";

export function SessionView({ initialSession, initialEvents, initialError }: { initialSession: SessionDto; initialEvents: SessionEventDto[]; initialError: string | null }) {
  const id = initialSession.id;
  const [session, setSession] = useState(initialSession);
  const [events, setEvents] = useState(initialEvents);
  const [error, setError] = useState(initialError);
  const { approvals, projects, error: apiError, lockdown, canControl } = useLiveData();
  const runner = useCommandRunner();
  const [cmdId, setCmdId] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  // 3.5: Diff tabi va "PR ochish"
  const [tab, setTab] = useState<"chat" | "diff">("chat");
  const [prOpen, setPrOpen] = useState(false);
  const cmd = useTrackedCommand(cmdId);
  useSessionCommandBootstrap(id, (c) => setCmdId((cur) => cur ?? c.id));
  const busy = runner.submitting || isInFlight(cmd);
  const chat = useSessionChat(id);

  const refetchEvents = useCallback(() => {
    getJson(`/sessions/${id}/events?limit=100`, ListSessionEventsResponseV1Schema)
      .then((r) => setEvents(r.items))
      .catch(() => undefined);
  }, [id]);

  const fetchSnapshot = useCallback(
    async (signal: AbortSignal): Promise<Snapshot> => {
      const [s, e] = await Promise.all([getJson(`/sessions/${id}`, SessionDtoSchema, signal), getJson(`/sessions/${id}/events?limit=100`, ListSessionEventsResponseV1Schema, signal)]);
      return { session: s, events: e.items };
    },
    [id],
  );

  useLiveSync<Snapshot>({
    fetchSnapshot,
    onSnapshot: (d) => {
      setSession(d.session);
      setEvents(d.events);
    },
    onError: setError,
    onPush: (e) => {
      if (e.type === "session.updated" && e.session.id === id) {
        setSession(e.session);
        refetchEvents();
      }
    },
  });

  const ds = displayStatus(session);
  const mode = readPermissionMode(session);
  const otherMode = otherPermissionMode(session);
  const history = useMemo(() => buildHistory(session, events), [session, events]);

  // Shu sessiyaning ruxsat so'rovlari: kutayotganlar + oxirgi hal qilinganlar
  const sessionApprovals = useMemo(() => {
    const all: ApprovalDto[] = [...(approvals?.pending ?? []), ...(approvals?.recent ?? [])];
    const seen = new Set<string>();
    return all
      .filter((a) => (a.sessionId === session.id || a.claudeSessionId === session.claudeSessionId) && !seen.has(a.id) && seen.add(a.id))
      .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
      .slice(-6);
  }, [approvals, session.id, session.claudeSessionId]);

  const project = projects?.items.find((p) => p.id === session.projectId) ?? null;
  const approvalById = useMemo(() => new Map(sessionApprovals.map((a) => [a.id, a])), [sessionApprovals]);
  const now = useNow();
  const extraApprovals = trailingApprovals(
    sessionApprovals,
    new Set(chat.items.flatMap((i) => (i.kind === "approval" ? [i.approvalId] : []))),
    now,
  );

  const machine = shortMachineName(session.machineName);
  const promptState = promptBoxState(session, { lockdown, canControl, machine });
  const stop = stopState(session, { lockdown, canControl });
  const gitBlock = prBlockReason({ canControl, lockdown, hasProject: session.projectId !== null });

  async function sendPrompt(text: string): Promise<boolean> {
    const c = await runner.submit({ type: "session.prompt", sessionId: session.id, text });
    if (!c) return false;
    setCmdId(c.id);
    return c.status !== "rejected" && c.status !== "failed";
  }
  async function doStop() {
    setConfirmStop(false);
    const c = await runner.submit({ type: "session.stop", sessionId: session.id });
    if (c) setCmdId(c.id);
  }

  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b border-bd px-4 py-3 md:px-6">
        <Link href="/sessions" aria-label="Sessiyalarga qaytish" className="flex text-mu">
          <IconBack size={18} />
        </Link>
        <div className="flex min-w-0 flex-[1_1_auto] flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="m-0 text-[17px] font-semibold">{session.projectName}</h1>
            <StatusPill status={ds} />
            <TaskPill session={session} />
            {session.pendingApprovals > 0 && (
              <span className="pill bg-org text-white" style={{ height: 20 }}>
                {session.pendingApprovals} ruxsat
              </span>
            )}
          </div>
          <span className="mono break-all text-xs text-mu">
            {machine} · {shortenPath(session.cwd)} · {session.model ?? "model noma'lum"} · <span suppressHydrationWarning>{formatClock(Date.parse(session.startedAt))}</span> da boshlangan · {kindLabel(session.kind)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-mu" id="mode-label">
            Rejim
          </span>
          <div role="group" aria-labelledby="mode-label" className="inline-flex gap-0.5 rounded-lg bg-s3 p-[3px]" title={SET_MODE_HINT}>
            {MODE_OPTIONS.map((m) => {
              const on = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  disabled
                  aria-pressed={on}
                  title={`${m.hint}. ${SET_MODE_HINT}`}
                  className={`h-[26px] rounded-md border-0 px-[11px] text-xs font-semibold disabled:cursor-not-allowed ${on ? "bg-s1 text-tx" : "bg-transparent text-mu"}`}
                  style={{ fontFamily: "var(--font-sans)", opacity: on ? 1 : 0.8 }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
          {otherMode && (
            <span className="pill mono bg-gray-bg text-mu" title="Hook'dagi oxirgi permission_mode">
              {otherMode}
            </span>
          )}
        </div>
        <LivePill />
        <button type="button" className="btn" disabled={!!gitBlock} title={gitBlock ?? "Branch'dan GitHub PR ochish"} onClick={() => setPrOpen(true)} data-testid="session-open-pr">
          PR ochish
        </button>
        <button type="button" className="btn btn-stop" disabled={!stop.enabled || busy} title={stop.hint} onClick={() => setConfirmStop(true)}>
          <IconStop />
          To&apos;xtatish
        </button>
        <button type="button" className="btn w-8 p-0" disabled aria-label="Boshqa amallar" title="Boshqa amallar yo'q">
          ⋯
        </button>
      </header>

      <div className="flex flex-1 flex-wrap items-stretch">
        <section className="flex min-w-0 flex-[999_1_520px] flex-col">
          <div role="tablist" aria-label="Sessiya ko'rinishi" className="flex gap-1 border-b border-bd px-4 pt-2 md:px-6">
            {(["chat", "diff"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-t-md border-0 px-3 py-1.5 text-xs font-semibold ${tab === t ? "bg-s3 text-tx" : "bg-transparent text-mu"}`} style={{ cursor: "pointer", font: "inherit", fontWeight: 600 }} data-testid={`tab-${t}`}>
                {t === "chat" ? "Suhbat" : "Diff"}
              </button>
            ))}
          </div>
          <div className={`${tab === "diff" ? "flex flex-1 flex-col" : "hidden"}`}>
            <DiffPanel sessionId={session.id} active={tab === "diff"} blockReason={gitBlock} />
          </div>
          <div className={`mx-auto w-full max-w-[860px] flex-1 flex-col gap-[18px] p-4 md:p-6 ${tab === "diff" ? "hidden" : "flex"}`}>
            <ApiErrorBar error={error ?? apiError} />
            {chat.items.length > 0 && chat.state !== "live" && <ChatBanner state={chat.state} code={chat.code} />}
            {chat.items.length > 0 ? (
              <ChatStream
                hasOlder={chat.hasOlder}
                loadingOlder={chat.loadingOlder}
                onLoadOlder={chat.loadOlder}
                items={chat.items}
                renderApproval={(aid) => {
                  const a = approvalById.get(aid);
                  return a ? <ApprovalCard approval={a} variant="card" /> : null;
                }}
              />
            ) : (
              <ChatPlaceholder state={chat.state} code={chat.code} />
            )}
            {extraApprovals.length > 0 && (
              <section aria-label="Ruxsat so'rovlari" className="flex flex-col gap-3">
                {chat.items.length === 0 && <span className="lbl">Ruxsat so&apos;rovlari</span>}
                {extraApprovals.map((a) => (
                  <ApprovalCard key={a.id} approval={a} variant="card" />
                ))}
              </section>
            )}
          </div>
          <div className={`sticky bottom-0 border-t border-bd bg-bg px-4 pb-[18px] pt-3 md:px-6 ${tab === "diff" ? "hidden" : ""}`}>
            <div className="mx-auto max-w-[860px]">
              {(cmd || runner.error) && (
                <div className="mb-2">
                  {cmd && <CommandProgress command={cmd} />}
                  {!cmd && runner.error && (
                    <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
                      {runner.error}
                    </div>
                  )}
                </div>
              )}
              {session && !session.endedAt && (
                <div className="mb-2">
                  <SessionExtraActions session={session} />
                </div>
              )}
              {session && session.endedAt && (
                <div className="mb-2">
                  <ResumeButton session={session} />
                </div>
              )}
              <PromptBox state={promptState} busy={busy} onSend={sendPrompt} />
            </div>
          </div>
        </section>

        <aside className="flex max-w-full flex-[1_1_280px] flex-col gap-[22px] border-l border-bd bg-s1 p-5 lg:sticky lg:top-0 lg:h-screen lg:max-w-[320px] lg:self-start lg:overflow-y-auto" aria-label="Sessiya ma'lumoti">
          <div className="flex flex-col gap-2.5">
            <span className="lbl">Loyiha tokenlari · bugun</span>
            {project ? (
              <>
                <span className="mono text-2xl font-semibold" title={`${formatCount(project.today.totalTokens)} token`}>
                  {formatTokens(project.today.totalTokens)}
                </span>
                <dl className="m-0 grid grid-cols-2 gap-2 text-xs">
                  <Row k="cache read" v={formatTokens(project.today.cacheReadTokens)} />
                  <Row k="cache write" v={formatTokens(project.today.cacheCreationTokens)} />
                  <Row k="output" v={formatTokens(project.today.outputTokens)} />
                  <Row k="input" v={formatTokens(project.today.inputTokens)} />
                  <Row k="so'rovlar" v={formatCount(project.today.requests)} />
                </dl>
                <span className="text-[11px] text-fa">{project.today.costUsd === null ? "API ekv.: narx yo'q" : `≈ ${formatCost(project.today.costUsd)} API ekvivalenti`}</span>
              </>
            ) : (
              <span className="text-xs text-mu">Loyiha ma&apos;lumoti yo&apos;q.</span>
            )}
            <span className="text-[11px] text-fa">Sessiya bo&apos;yicha alohida hisob: {PHASE2}.</span>
          </div>

          <SummaryCard sessionId={session.id} refreshKey={session.endedAt ?? session.status} />

          <ApprovalRulesPanel title="Avto-ruxsat qoidalari" scope="session" scopeRef={session.id} />

          <div className="flex flex-col">
            <span className="lbl mb-2.5">Holat tarixi</span>
            {history.map((h) => (
              <div key={h.key} className="flex gap-2.5">
                <div className="flex flex-col items-center">
                  <span className="dot mt-[5px]" style={{ color: h.status ? STATUS_COLOR[h.status] : "var(--mu)" }} />
                  <span className="min-h-[18px] w-px flex-1 bg-bd" />
                </div>
                <div className="pb-2.5">
                  <div className="font-medium">{h.label}</div>
                  <div className="mono text-[11px] text-mu" suppressHydrationWarning>
                    {h.time}
                    {h.detail && <span className="text-fa"> · {h.detail}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <span className="lbl">O&apos;zgargan fayllar</span>
            {chat.changedFiles.length === 0 ? (
              <span className="text-xs text-mu">Yuklangan chatda fayl o&apos;zgarishi yo&apos;q.</span>
            ) : (
              <ul className="flex flex-col gap-1">
                {chat.changedFiles.slice(0, 30).map((f) => (
                  <li key={f.path} className="flex items-baseline gap-2 text-xs" title={`${f.edits} marta o'zgartirildi`}>
                    <span className="mono min-w-0 flex-1 truncate" dir="rtl">{f.path}</span>
                    <span className="mono text-grn">+{f.added}</span>
                    <span className="mono text-red">−{f.removed}</span>
                  </li>
                ))}
                {chat.changedFiles.length > 30 && <li className="text-xs text-mu">… yana {chat.changedFiles.length - 30} ta</li>}
              </ul>
            )}
            <span className="text-[11px] text-fa">Faqat yuklangan chat bo&apos;yicha; eskiroqlari uchun «Oldingi xabarlar».</span>
          </div>
        </aside>
      </div>

      {prOpen && session.projectId && <OpenPrDialog projectId={session.projectId} sessionName={session.name} taskKey={session.taskKey ?? null} onClose={() => setPrOpen(false)} />}

      {confirmStop && (
        <Dialog labelledBy="stop-title" onClose={() => setConfirmStop(false)} maxWidth={440} top={120}>
          <div className="flex flex-col gap-3 px-5 py-5">
            <h2 id="stop-title" className="m-0 text-base font-semibold">
              Sessiyani to&apos;xtatasizmi?
            </h2>
            <p className="m-0 text-mu">
              <b className="text-tx">{session.projectName}</b> ({machine}) da Claude to&apos;xtatiladi. Bu masofaviy amal audit jurnaliga yoziladi.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setConfirmStop(false)}>
                Bekor
              </button>
              <button type="button" className="btn btn-no" onClick={() => void doStop()}>
                Ha, to&apos;xtatish
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-mu">{k}</dt>
      <dd className="mono m-0 text-right">{v}</dd>
    </>
  );
}

const ERROR_TEXT: Record<string, string> = {
  not_found: "Sessiya transcripti topilmadi.",
  forbidden_path: "Transcript yo'liga ruxsat yo'q.",
  busy: "Mashinada juda ko'p chat oqimi ochiq. Birozdan keyin qayta urinib ko'ring.",
  read_failed: "Transcriptni o'qib bo'lmadi.",
  internal: "Ichki xatolik yuz berdi.",
};

function ChatBanner({ state, code }: { state: ChatState; code: ChatErrorCode | null }) {
  const text =
    state === "offline"
      ? "Mashina oflayn: chat vaqtincha to'xtadi. Qayta ulanganda jonli oqim davom etadi."
      : state === "connecting"
        ? "Chat qayta ulanmoqda…"
        : state === "unavailable"
          ? "Transcript topilmadi: ko'rsatilgan xabarlar eskirgan bo'lishi mumkin."
          : `Chatni o'qib bo'lmadi. ${ERROR_TEXT[code ?? "internal"]}`;
  return (
    <div role="status" className={`rounded-lg px-3 py-2 text-xs ${state === "error" ? "bg-red-bg text-red" : "bg-yel-bg text-yel"}`} data-testid="chat-banner">
      {text}
    </div>
  );
}

function ChatPlaceholder({ state, code }: { state: ChatState; code: ChatErrorCode | null }) {
  if (state === "connecting") {
    return (
      <div className="card flex flex-col gap-3 p-5" aria-busy="true" aria-label="Chat ulanmoqda" data-testid="chat-empty" data-state={state}>
        <div className="sk h-3.5 w-2/5" />
        <div className="sk h-9" />
        <div className="sk h-9" />
      </div>
    );
  }
  const copy: Record<Exclude<ChatState, "connecting">, { title: string; body: string }> = {
    live: { title: "Hali xabar yo'q", body: "Sessiyada hozircha suhbat yozuvlari yo'q. Yangi xabarlar shu yerda jonli paydo bo'ladi." },
    offline: { title: "Mashina oflayn", body: "Chat mavjud emas: mashina oflayn. Qayta ulanganda jonli oqim davom etadi." },
    unavailable: { title: "Chat mavjud emas", body: "Bu sessiya uchun transcript topilmadi (masalan, fayl o'chirilgan yoki boshqa joyda)." },
    error: { title: "Chatni ochib bo'lmadi", body: ERROR_TEXT[code ?? "internal"] },
  };
  const c = copy[state];
  return (
    <div className={`card flex flex-col items-center gap-2.5 p-8 text-center ${state === "error" ? "border-red" : ""}`} data-testid="chat-empty" data-state={state}>
      <span className={state === "error" ? "text-red" : "text-fa"}>
        <IconTerminal size={36} strokeWidth={1} />
      </span>
      <b>{c.title}</b>
      <span className="max-w-[420px] text-mu">{c.body}</span>
    </div>
  );
}
