"use client";

import { AskHistoryResponseSchema, AskResponseSchema } from "@commander/contracts";
import type { AskHistoryItem, AskResponse } from "@commander/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { IconSpinner } from "@/components/ui/icons";
import { ASK_CLIENT_TIMEOUT_MS, SOURCE_KIND_LABEL, askErrorText, buildHistoryRows, buildSourceViews, validateQuestion } from "@/lib/ask-view";
import { ApiCallError, getJson, postJson } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

class AskTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new AskTimeout("timeout")), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** "Commander'dan so'rang": savol, kutish holati (~110 s gacha), javob, manbalar va tarix. */
export function AskPanel() {
  const { canControl, lockdown } = useLiveData();
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AskHistoryItem[] | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadHistory = useCallback((signal?: AbortSignal) => {
    getJson("/assistant/history?limit=10", AskHistoryResponseSchema, signal)
      .then((r) => setHistory(r.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    loadHistory(ctl.signal);
    return () => ctl.abort();
  }, [loadHistory]);

  const blocked = !canControl ? "Savol berish uchun boshqaruv token'i kerak." : lockdown ? "Lockdown yoqiq: savol berib bo'lmaydi." : null;

  async function submit() {
    const v = validateQuestion(question);
    if (!v.value) {
      setError(v.error);
      return;
    }
    setPending(true);
    setError(null);
    setAnswer(null);
    try {
      const r = await withTimeout(postJson("/assistant/ask", { question: v.value }, AskResponseSchema), ASK_CLIENT_TIMEOUT_MS);
      if (!alive.current) return;
      setAnswer(r);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof AskTimeout) setError(askErrorText("timeout", null));
      else if (e instanceof ApiCallError) setError(askErrorText(e.status, e.body));
      else setError(askErrorText(0, null));
    } finally {
      if (alive.current) {
        setPending(false);
        loadHistory();
      }
    }
  }

  const sources = useMemo(() => (answer ? buildSourceViews(answer.sources) : []), [answer]);
  const rows = useMemo(() => (history ? buildHistoryRows(history) : []), [history]);

  return (
    <section className="card flex flex-col gap-3 p-4" aria-label="Commander'dan so'rang" data-testid="ask-panel">
      <h2 className="m-0 text-sm font-semibold">Commander&apos;dan so&apos;rang</h2>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          className="field min-h-[72px]"
          placeholder="Masalan: kecha qaysi loyihalarda ishlandi?"
          aria-label="Savol"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={pending}
          rows={3}
          data-testid="ask-input"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-ok" disabled={pending || !!blocked || question.trim().length === 0} title={blocked ?? undefined} data-testid="ask-submit">
            {pending ? "Javob kutilmoqda…" : "So'rash"}
          </button>
          {pending && (
            <span role="status" className="flex items-center gap-1.5 text-xs text-mu">
              <IconSpinner /> Bu 2 daqiqagacha cho&apos;zilishi mumkin.
            </span>
          )}
          {blocked && <span className="text-xs text-mu">{blocked}</span>}
        </div>
      </form>

      {error && (
        <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="ask-error">
          {error}
        </div>
      )}

      {answer && (
        <div className="flex flex-col gap-2 rounded-lg border border-bd bg-s2 p-3" data-testid="ask-answer">
          <p className="m-0 whitespace-pre-wrap">{answer.answer}</p>
          {sources.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Manbalar">
              <span className="lbl">Manbalar</span>
              {sources.map((s) =>
                s.href ? (
                  <Link key={s.key} href={s.href} className="pill bg-s3" data-testid="ask-source-link">
                    {SOURCE_KIND_LABEL[s.kind]}: {s.label}
                  </Link>
                ) : (
                  <span key={s.key} className="pill bg-s3 text-mu" data-testid="ask-source-text">
                    {SOURCE_KIND_LABEL[s.kind]}: {s.label}
                  </span>
                ),
              )}
            </div>
          )}
          <span className="mono text-[11px] text-fa">
            {answer.model ?? "model noma'lum"} · {(answer.tookMs / 1000).toFixed(1)} s
          </span>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-col gap-1" aria-label="So'nggi savollar">
          <span className="lbl">So&apos;nggi savollar</span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {rows.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <button type="button" className="min-w-0 flex-1 basis-[200px] cursor-pointer truncate border-0 bg-transparent p-0 text-left text-tx" style={{ font: "inherit" }} title="Savolni qayta ishlatish" onClick={() => setQuestion(h.question)}>
                  {h.question}
                </button>
                <span className={`pill ${h.status === "failed" ? "bg-red-bg text-red" : "bg-gray-bg text-mu"}`}>{h.statusLabel}</span>
                <span className="mono text-[11px] text-fa" suppressHydrationWarning>
                  {formatDateTime(h.askedAt)}
                  {h.tookText ? ` · ${h.tookText}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
