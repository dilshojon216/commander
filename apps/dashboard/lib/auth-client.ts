/**
 * Brauzer tomoni: CSRF tokeni, qayta tasdiqlash (reauth) va Mac ilova native ko'prigi. Server tomoni importlari yo'q.
 */

export const REAUTH_ERROR = "reauth_required";

export interface AuthMethods {
  passkey: boolean;
  password: boolean;
  app: boolean;
}

export interface SessionInfo {
  authenticated: true;
  csrf: string;
  method: string;
  elevatedUntil: number;
  expiresAt: number;
  elevationMs: number;
  methods: AuthMethods;
}

let csrfToken: string | null = null;
let reauthHandler: (() => Promise<boolean>) | null = null;

export function setCsrf(token: string | null): void {
  csrfToken = token;
}

/** `AuthProvider` o'rnatadi: qayta tasdiqlash oynasini ochib, natija (true = tasdiqlandi) bilan qaytadi. */
export function registerReauthHandler(fn: (() => Promise<boolean>) | null): void {
  reauthHandler = fn;
}

export async function fetchSession(signal?: AbortSignal): Promise<SessionInfo | null> {
  try {
    const res = await fetch("/api/auth/session", { cache: "no-store", signal, credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json()) as SessionInfo;
    csrfToken = body.csrf;
    return body;
  } catch {
    return null;
  }
}

async function ensureCsrf(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  await fetchSession();
  return csrfToken;
}

function goToLogin(): void {
  if (typeof window === "undefined" || window.location.pathname === "/login") return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.replace(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
}

async function errorCode(res: Response): Promise<string | null> {
  try {
    const b: unknown = await res.clone().json();
    return typeof b === "object" && b !== null && "error" in b ? String((b as { error: unknown }).error) : null;
  } catch {
    return null;
  }
}

/**
 * `/api/c` va `/api/auth` so'rovlari uchun yagona fetch: o'zgartiruvchi so'rovga CSRF sarlavhasi qo'shadi;
 * `reauth_required` bo'lsa qayta tasdiqlash oynasini ko'rsatib, MUVAFFAQIYATLI bo'lsa bir marta qayta yuboradi;
 * `unauthenticated` bo'lsa /login ga o'tkazadi.
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const send = async (): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (method !== "GET") {
      const t = await ensureCsrf();
      if (t) headers.set("x-csrf-token", t);
    }
    return fetch(url, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  };
  let res = await send();
  if (res.status === 403 && method !== "GET" && (await errorCode(res)) === "csrf") {
    csrfToken = null;
    res = await send();
  }
  if (res.status === 401) {
    const code = await errorCode(res);
    if (code === REAUTH_ERROR && reauthHandler) {
      if (await reauthHandler()) return send();
    } else if (code === "unauthenticated") {
      goToLogin();
    }
  }
  return res;
}

// ---- Mac ilova native ko'prigi (WKScriptMessageHandlerWithReply "commanderAuth") --------------------------------------

export type NativeAction = { action: "status" } | { action: "pair"; setupCode: string } | { action: "login" } | { action: "elevate" };
export interface NativeReply {
  ok?: boolean;
  available?: boolean;
  paired?: boolean;
  token?: string;
  error?: string;
}

interface WebKitBridge {
  webkit?: { messageHandlers?: { commanderAuth?: { postMessage: (m: NativeAction) => Promise<NativeReply> } } };
}

export function hasNativeAuth(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as WebKitBridge).webkit?.messageHandlers?.commanderAuth;
}

export async function nativeAuth(msg: NativeAction): Promise<NativeReply> {
  const h = (window as unknown as WebKitBridge).webkit?.messageHandlers?.commanderAuth;
  if (!h) return { ok: false, error: "native_unavailable" };
  try {
    return await h.postMessage(msg);
  } catch {
    return { ok: false, error: "native_failed" };
  }
}

/** Server xato kodi -> o'zbekcha matn. */
export function authErrorText(code: string | null | undefined, retryAfterMs?: number): string {
  switch (code) {
    case "invalid_credentials":
      return "Parol noto'g'ri";
    case "rate_limited":
      return `Juda ko'p urinish. ${retryAfterMs ? `${Math.ceil(retryAfterMs / 60000)} daqiqadan keyin` : "Birozdan keyin"} qayta urinib ko'ring`;
    case "invalid_setup_code":
      return "Sozlash kodi noto'g'ri";
    case "setup_code_unavailable":
      return "Sozlash kodi muddati o'tgan yoki ishlatilgan: terminalda yangisini chiqaring";
    case "no_passkey":
      return "Passkey hali qo'shilmagan";
    case "assertion_failed":
    case "unknown_credential":
      return "Passkey tasdiqlanmadi";
    case "challenge_expired":
      return "Vaqt tugadi, qaytadan urinib ko'ring";
    case "invalid_app_secret":
      return "Ilova juftlanmagan yoki siri eskirgan: sozlash kodi bilan qayta juftlang";
    default:
      return "Kirish amalga oshmadi";
  }
}
