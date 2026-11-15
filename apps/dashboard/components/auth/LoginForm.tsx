"use client";

import { useEffect, useRef, useState } from "react";
import { authErrorText, nativeAuth } from "@/lib/auth-client";
import type { AuthMethods } from "@/lib/auth-client";
import { passkeyLoginFlow, passkeyRegisterFlow, passwordLoginFlow } from "@/lib/passkey-client";
import type { FlowResult } from "@/lib/passkey-client";
import { isPasskeyHost, useNativeState } from "./useAuthMethods";

/** Kirish sahifasi: Touch ID (passkey yoki Mac ilova), parol; birinchi sozlash (bir martalik kod bilan). */
export function LoginForm({ next }: { next: string }) {
  const native = useNativeState();
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyHost, setPasskeyHost] = useState(false);
  const autoNative = useRef(false);

  useEffect(() => {
    void fetch("/api/auth/methods", { cache: "no-store" })
      .then((r) => r.json() as Promise<AuthMethods>)
      .catch(() => ({ passkey: false, password: false, app: false }))
      .then((m) => {
        setPasskeyHost(isPasskeyHost());
        setMethods(m);
      });
  }, []);

  function enter() {
    // To'liq yuklash: server layout yangi cookie bilan ishlaydi
    window.location.replace(next);
  }

  async function run(fn: () => Promise<FlowResult>) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) enter();
    else if (r.error !== "cancelled") setError(authErrorText(r.error, r.retryAfterMs));
  }

  const nativeLogin = () =>
    run(async () => {
      const r = await nativeAuth({ action: "login" });
      return r.ok ? { ok: true } : { ok: false, error: r.error === "cancelled" ? "cancelled" : (r.error ?? "invalid_app_secret") };
    });

  const nativeReady = !!native?.available && native.paired;
  useEffect(() => {
    // Mac ilova: oyna ochilishi bilan Touch ID so'raladi
    if (nativeReady && !autoNative.current) {
      autoNative.current = true;
      void nativeLogin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeReady]);

  const pairNative = () =>
    run(async () => {
      const r = await nativeAuth({ action: "pair", setupCode });
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "invalid_setup_code" };
    });

  const nothingConfigured = methods && !methods.passkey && !methods.password && !methods.app;
  const field = "rounded-md border border-bd bg-s2 px-3 py-2 text-tx";

  return (
    <main className="mx-auto flex min-h-screen max-w-[400px] flex-col justify-center gap-4 px-4 py-10">
      <div className="flex items-center gap-2.5">
        <svg width="28" height="28" viewBox="0 0 26 26" aria-hidden="true">
          <rect width="26" height="26" rx="7" fill="#FF7A45" />
          <path d="M8 9l4 4-4 4M14 17h5" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h1 className="m-0 text-lg font-bold">Commander</h1>
      </div>

      <section className="card flex flex-col gap-3 p-5" aria-labelledby="login-title">
        <h2 id="login-title" className="m-0 text-base font-semibold">
          Kirish
        </h2>
        {!methods && <span className="text-mu">Yuklanmoqda…</span>}

        {nativeReady && (
          <button type="button" className="btn btn-pri" disabled={busy} onClick={() => void nativeLogin()}>
            Touch ID bilan kirish
          </button>
        )}
        {methods?.passkey && !native?.available && (
          <>
            <button type="button" className="btn btn-pri" disabled={busy || !passkeyHost} onClick={() => void run(passkeyLoginFlow)}>
              Touch ID bilan kirish
            </button>
            {!passkeyHost && <p className="m-0 text-[12px] text-fa">Passkey faqat http://localhost:4318 manzilida ishlaydi (IP manzilda emas).</p>}
          </>
        )}

        {methods?.password && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (password) void run(() => passwordLoginFlow(password));
            }}
          >
            <label htmlFor="login-pw" className="lbl">
              Parol
            </label>
            <input id="login-pw" type="password" autoComplete="current-password" className={field} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            <button type="submit" className="btn" disabled={busy || !password}>
              Parol bilan kirish
            </button>
          </form>
        )}

        {error && (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-red">
            {error}
          </div>
        )}
      </section>

      <details className="card p-4" open={!!nothingConfigured || (native?.available && !native.paired)}>
        <summary className="cursor-pointer font-medium">Birinchi marta sozlash</summary>
        <div className="mt-3 flex flex-col gap-2">
          <p className="m-0 text-mu">
            Terminalda <code className="mono">bash ops/mac/dashboard-auth.sh setup</code> ni ishga tushiring va chiqqan kodni (10 daqiqa, bir marta) kiriting.
          </p>
          <label htmlFor="setup-code" className="lbl">
            Sozlash kodi
          </label>
          <input id="setup-code" className={`${field} mono`} placeholder="ABCD-EFGH" autoCapitalize="characters" autoComplete="off" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} disabled={busy} />
          {native?.available ? (
            <button type="button" className="btn" disabled={busy || setupCode.trim().length < 8} onClick={() => void pairNative()}>
              Mac ilovani juftlash (Touch ID)
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy || setupCode.trim().length < 8 || !passkeyHost} onClick={() => void run(() => passkeyRegisterFlow(setupCode, "Touch ID"))}>
                Passkey qo&apos;shish (Touch ID)
              </button>
              {!passkeyHost && <p className="m-0 text-[12px] text-fa">Passkey qo&apos;shish uchun http://localhost:4318 ni oching.</p>}
            </>
          )}
        </div>
      </details>
    </main>
  );
}
