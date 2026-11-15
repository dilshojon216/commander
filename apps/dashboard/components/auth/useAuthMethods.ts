"use client";

import { useEffect, useState } from "react";
import { hasNativeAuth, nativeAuth } from "@/lib/auth-client";

export interface NativeState {
  /** Sahifa Mac ilova WKWebView ichida (native ko'prik bor). */
  available: boolean;
  paired: boolean;
}

/** Mac ilova ko'prigi bor-yo'qligi va juftlanganligi (brauzerda `available: false`). */
export function useNativeState(): NativeState | null {
  const [st, setSt] = useState<NativeState | null>(null);
  useEffect(() => {
    let alive = true;
    const available = hasNativeAuth();
    const status = available ? nativeAuth({ action: "status" }) : Promise.resolve({ paired: false });
    void status.then((r) => alive && setSt({ available, paired: !!r.paired }));
    return () => {
      alive = false;
    };
  }, []);
  return st;
}

/** Passkey faqat `localhost` da ishlaydi (IP manzil WebAuthn RP ID bo'la olmaydi). */
export function isPasskeyHost(): boolean {
  return typeof window !== "undefined" && window.location.hostname === "localhost" && !!window.PublicKeyCredential;
}
