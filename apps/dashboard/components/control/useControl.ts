"use client";

import { CommandDtoSchema, CreateCommandResponseSchema, ListCommandsResponseSchema } from "@commander/contracts";
import type { CommandDto, CreateCommandBody } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { ApiCallError, getJson, postJson } from "@/lib/client-api";
import { commandHttpErrorText, isInFlight } from "@/lib/control-ui";

/** Buyruq yaratish/bekor qilish. Biznes rad (`rejected`/`failed`) HTTP xato emas: buyruq qatori qaytadi. */
export function useCommandRunner() {
  const { trackCommand } = useLiveData();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (body: CreateCommandBody): Promise<CommandDto | null> => {
      setSubmitting(true);
      setError(null);
      try {
        const res = await postJson("/commands", body, CreateCommandResponseSchema, { "Idempotency-Key": crypto.randomUUID() });
        trackCommand(res.command);
        return res.command;
      } catch (e) {
        setError(e instanceof ApiCallError ? commandHttpErrorText(e.status, e.body) : commandHttpErrorText(0, null));
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [trackCommand],
  );

  const cancel = useCallback(
    async (id: string): Promise<CommandDto | null> => {
      try {
        const c = await postJson(`/commands/${id}/cancel`, {}, CommandDtoSchema);
        trackCommand(c);
        return c;
      } catch (e) {
        setError(e instanceof ApiCallError ? commandHttpErrorText(e.status, e.body) : commandHttpErrorText(0, null));
        return null;
      }
    },
    [trackCommand],
  );

  return { submit, cancel, submitting, error, clearError: () => setError(null) };
}

/** Buyruq holati: `command.updated` push'i + himoya uchun 4 s da bir marta REST so'rov (push o'tib ketsa). */
export function useTrackedCommand(id: string | null): CommandDto | undefined {
  const { commands, trackCommand } = useLiveData();
  const cmd = id ? commands[id] : undefined;
  const inFlight = isInFlight(cmd);
  useEffect(() => {
    if (!id || !inFlight) return;
    const t = setInterval(() => {
      getJson(`/commands/${id}`, CommandDtoSchema)
        .then(trackCommand)
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, [id, inFlight, trackCommand]);
  return cmd;
}

/** Sahifa ochilganda sessiyaning davom etayotgan buyrug'ini topadi (qayta yuklashdan keyin ham ko'rinsin). */
export function useSessionCommandBootstrap(sessionId: string, onFound: (c: CommandDto) => void): void {
  const { trackCommand } = useLiveData();
  useEffect(() => {
    const ctl = new AbortController();
    getJson(`/sessions/${sessionId}/commands`, ListCommandsResponseSchema, ctl.signal)
      .then((r) => {
        for (const c of r.items) trackCommand(c);
        const open = r.items.find((c) => isInFlight(c));
        if (open) onFound(open);
      })
      .catch(() => undefined);
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- faqat sessiya o'zgarganda
  }, [sessionId, trackCommand]);
}
