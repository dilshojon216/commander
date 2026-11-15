"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { authErrorText, nativeAuth } from "@/lib/auth-client";
import type { AuthMethods } from "@/lib/auth-client";
import { appElevateFlow, passkeyElevateFlow, passwordElevateFlow } from "@/lib/passkey-client";
import type { FlowResult } from "@/lib/passkey-client";
import { isPasskeyHost, useNativeState } from "./useAuthMethods";

/** Xavfli amal oldidan yangi tasdiq: Touch ID (passkey yoki Mac ilova) yoki parol. */
export function ReauthDialog({ methods, onDone }: { methods: AuthMethods; onDone: (ok: boolean) => void }) {
  const native = useNativeState();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);

  async function run(fn: () => Promise<FlowResult>) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) onDone(true);
    else if (r.error !== "cancelled") setError(authErrorText(r.error, r.retryAfterMs));
  }

  const viaApp = () =>
    run(async () => {
      const t = await nativeAuth({ action: "elevate" });
      if (!t.ok || !t.token) return { ok: false, error: t.error === "cancelled" ? "cancelled" : (t.error ?? "invalid_app_secret") };
      return appElevateFlow(t.token);
    });

  const nativeReady = !!native?.available && native.paired && methods.app;
  useEffect(() => {
    // Mac ilovada Touch ID so'rovi darhol chiqadi (foydalanuvchi bosishi shart emas)
    if (nativeReady && !autoStarted.current) {
      autoStarted.current = true;
      void viaApp();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeReady]);

  const passkeyOk = methods.passkey && isPasskeyHost();

  return (
    <Dialog labelledBy="reauth-title" onClose={() => onDone(false)} maxWidth={420} top={120} dismissOnBackdrop={false}>
      <div className="flex flex-col gap-3 p-5">
        <h2 id="reauth-title" className="m-0 text-base font-semibold">
          Qayta tasdiqlash kerak
        </h2>
        <p className="m-0 text-mu">Bu xavfli amal (ruxsat berish, buyruq yuborish, sozlama o&apos;zgartirish). Egasi ekanligingizni tasdiqlang.</p>
        {nativeReady && (
          <button type="button" className="btn btn-pri" disabled={busy} onClick={() => void viaApp()}>
            Touch ID bilan tasdiqlash
          </button>
        )}
        {passkeyOk && (
          <button type="button" className="btn btn-pri" disabled={busy} onClick={() => void run(passkeyElevateFlow)}>
            Touch ID bilan tasdiqlash
          </button>
        )}
        {methods.passkey && !passkeyOk && !nativeReady && <p className="m-0 text-[12px] text-fa">Passkey uchun dashboard&apos;ni http://localhost:4318 manzilida oching.</p>}
        {methods.password && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (password) void run(() => passwordElevateFlow(password));
            }}
          >
            <label htmlFor="reauth-pw" className="lbl">
              Parol
            </label>
            <input id="reauth-pw" type="password" autoComplete="current-password" className="rounded-md border border-bd bg-s2 px-3 py-2 text-tx" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            <button type="submit" className="btn" disabled={busy || !password}>
              Parol bilan tasdiqlash
            </button>
          </form>
        )}
        {!methods.passkey && !methods.password && !methods.app && <p className="m-0 text-red">Hech qanday kirish usuli sozlanmagan: terminalda `bash ops/mac/dashboard-auth.sh` ga qarang.</p>}
        {error && (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-red">
            {error}
          </div>
        )}
        <button type="button" className="btn" onClick={() => onDone(false)}>
          Bekor qilish
        </button>
      </div>
    </Dialog>
  );
}
