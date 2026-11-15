"use client";

import { useEffect, useRef, useState } from "react";
import { MarkdownView } from "@/components/MarkdownView";
import { IconAlert } from "@/components/ui/icons";
import type { AssistantChatItem, AssistantToolPart, ChatItem, NoticeChatItem, UserChatItem } from "@/lib/chat-types";
import { footnoteText, hasRedaction, toolColor } from "@/lib/chat-format";
import { formatClock } from "@/lib/format";

const META_TONE = { mu: "text-mu", grn: "text-grn", red: "text-red" } as const;

export function UserMessage({ item }: { item: UserChatItem }) {
  return (
    <div className="max-w-[80%] self-end rounded-[12px_12px_4px_12px] border border-bd bg-blue-bg px-3.5 py-2.5">
      <div className="lbl mb-1">Siz{item.ts ? ` · ${formatClock(Date.parse(item.ts))}` : ""}</div>
      <div className="whitespace-pre-wrap break-words">{item.text}</div>
    </div>
  );
}

/** Yig'ilgan tool bloki; bosilsa ochiladi. `[REDACTED]` joylar ochilmaydi (matn o'zgarishsiz). */
export function ToolBlock({ part }: { part: AssistantToolPart }) {
  const [open, setOpen] = useState(false);
  const canOpen = !!part.output;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={canOpen ? open : undefined}
        disabled={!canOpen}
        onClick={() => setOpen((v) => !v)}
        className="mono flex w-full items-center gap-2 rounded-lg border border-bd bg-s2 px-3 py-2 text-left text-xs font-medium text-tx hover:bg-s3 disabled:cursor-default"
        style={{ cursor: canOpen ? "pointer" : "default" }}
      >
        <span className="w-2.5 text-mu" aria-hidden="true">
          {canOpen ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="font-semibold" style={{ color: toolColor(part.tool) }}>
          {part.tool}
        </span>
        <span className="min-w-0 flex-1 truncate">{part.arg}</span>
        {part.meta && <span className={META_TONE[part.meta.tone]}>{part.meta.text}</span>}
      </button>
      {open && part.output && (
        <pre className="mono m-0 -mt-px whitespace-pre-wrap rounded-b-lg border border-t-0 border-bd bg-bg px-3 py-2.5 text-xs text-mu" data-redacted={hasRedaction(part.output) || undefined}>
          {part.output}
        </pre>
      )}
    </div>
  );
}

export function AssistantMessage({ item }: { item: AssistantChatItem }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="inline-block size-5 rounded-md" style={{ background: "#D97757" }} aria-hidden="true" />
        <span className="font-semibold">Claude</span>
        {item.ts && <span className="mono text-[11px] text-fa">{formatClock(Date.parse(item.ts))}</span>}
      </div>
      {item.parts.map((p, i) =>
        p.type === "text" ? (
          <MarkdownView key={`t${i}`} content={p.markdown} className="" />
        ) : p.type === "tool" ? (
          <ToolBlock key={p.id} part={p} />
        ) : (
          <span key={p.id} className="mono text-[11px] text-fa">
            {footnoteText(p.footnote)}
          </span>
        ),
      )}
    </div>
  );
}

export function NoticeMessage({ item }: { item: NoticeChatItem }) {
  if (item.level === "error") {
    return (
      <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-red-bg px-3 py-2.5 text-red">
        <IconAlert className="mt-0.5 shrink-0" strokeWidth={1.6} />
        <div className="min-w-0 break-words">
          <b>Xato:</b> <span className="mono text-xs">{item.text}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 text-xs text-mu" data-notice={item.code}>
      <span className="h-px flex-1 bg-bd" />
      <span className="break-words">{item.text}</span>
      <span className="h-px flex-1 bg-bd" />
    </div>
  );
}

/**
 * Chat oqimi: yangi elementlar jonli qo'shiladi va sahifa pastiga avtomatik suriladi
 * (foydalanuvchi yuqoriga chiqqan bo'lsa surilmaydi, "Yangi xabarlar" tugmasi chiqadi).
 */
export function ChatStream({
  items,
  renderApproval,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: {
  items: ChatItem[];
  renderApproval: (approvalId: string) => React.ReactNode;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const prevSig = useRef("");
  const prevLastId = useRef<string | null>(null);

  useEffect(() => {
    const onScroll = () => {
      const near = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
      stick.current = near;
      if (near) setUnseen(0);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Faqat OXIRGI element o'zgarganda (yangi javob / o'sgan javob) suriladi; eski sahifa qo'shilganda emas
  useEffect(() => {
    const last = items[items.length - 1];
    const sig = last ? `${last.id}:${last.kind === "assistant" ? last.parts.length + ":" + last.parts.reduce((n, p) => n + (p.type === "text" ? p.markdown.length : p.type === "tool" ? (p.output?.length ?? 0) + (p.meta?.text.length ?? 0) : 1), 0) : last.kind}` : "";
    if (sig === prevSig.current) return;
    const first = prevSig.current === "";
    const newItem = (last?.id ?? null) !== prevLastId.current;
    prevSig.current = sig;
    prevLastId.current = last?.id ?? null;
    if (stick.current) endRef.current?.scrollIntoView({ block: "end", behavior: first ? "auto" : "smooth" });
    else if (newItem) setUnseen((n) => n + 1);
  }, [items]);

  return (
    <div className="flex flex-col gap-[18px]" role="log" aria-live="polite" aria-label="Sessiya chati">
      {hasOlder && (
        <button type="button" className="btn self-center" disabled={loadingOlder} onClick={onLoadOlder}>
          {loadingOlder ? "Yuklanmoqda…" : "Oldingi xabarlarni yuklash"}
        </button>
      )}
      {items.map((it) => {
        switch (it.kind) {
          case "user":
            return <UserMessage key={it.id} item={it} />;
          case "assistant":
            return <AssistantMessage key={it.id} item={it} />;
          case "notice":
            return <NoticeMessage key={it.id} item={it} />;
          case "approval":
            return <div key={it.id}>{renderApproval(it.approvalId)}</div>;
        }
      })}
      <div ref={endRef} />
      {unseen > 0 && (
        <button
          type="button"
          className="btn btn-pri fixed bottom-24 right-6 z-10 shadow-lg"
          onClick={() => {
            stick.current = true;
            setUnseen(0);
            endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
          }}
        >
          Yangi xabarlar ↓ ({unseen})
        </button>
      )}
    </div>
  );
}
