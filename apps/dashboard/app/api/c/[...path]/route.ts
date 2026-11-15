import { NextRequest } from "next/server";
import { authorize, denyResponse } from "@/lib/auth/guard";
import { isElevated } from "@/lib/auth/sessions";
import { availableMethods } from "@/lib/auth/service";
import { commanderRequest, ConfigError, describeError } from "@/lib/commander";
import { classifyProxyRequest, elevationFor, elevationRequired, isSameOrigin, maxBodyFor, needsIdempotencyKey, proxyTimeoutFor } from "@/lib/proxy-rules";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Brauzer uchun yagona REST proksi: token server tomonda qo'shiladi. */
async function handle(request: NextRequest, ctx: RouteContext<"/api/c/[...path]">) {
  const { path } = await ctx.params;
  // H-01: avval autentifikatsiya (+ o'zgartiruvchi so'rovlar uchun CSRF): yo'l mavjudligi ham kirmaganlarga sezdirilmaydi.
  const mutating = request.method !== "GET";
  const auth = authorize(request, { mutating, touch: mutating });
  if (!auth.ok) return denyResponse(auth);
  const decision = classifyProxyRequest(request.method, path);
  if (!decision.ok) {
    return Response.json({ error: "not_found", message: "Yo'l topilmadi" }, { status: decision.status, headers: NO_STORE });
  }

  let body: unknown;
  if (decision.method !== "GET") {
    if (!isSameOrigin(request.headers.get("origin"), request.headers.get("host"))) {
      return Response.json({ error: "forbidden", message: "Origin mos emas" }, { status: 403, headers: NO_STORE });
    }
    const text = await request.text();
    if (text.length > maxBodyFor(path)) {
      return Response.json({ error: "invalid_request", message: "Tana juda katta" }, { status: 413, headers: NO_STORE });
    }
    if (decision.method !== "DELETE" || text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return Response.json({ error: "invalid_request", message: "JSON noto'g'ri" }, { status: 400, headers: NO_STORE });
      }
    }
  }

  // H-01: xavfli amal = yangi tasdiq (Touch ID/parol) oynasi ichida bo'lishi shart; aks holda UI qayta tasdiq so'raydi va qaytadan yuboradi.
  if (elevationRequired(elevationFor(decision.method, path), body) && !isElevated(auth.session, Date.now())) {
    return Response.json(
      { error: "reauth_required", message: "Xavfli amal: Touch ID yoki parol bilan qayta tasdiqlang", methods: availableMethods() },
      { status: 401, headers: NO_STORE },
    );
  }

  // Buyruq yaratishda Idempotency-Key: klientdan (uuid) yoki serverda yaratiladi; boshqa sarlavhalar o'tkazilmaydi
  let headers: Record<string, string> | undefined;
  if (decision.method === "POST" && needsIdempotencyKey(path)) {
    const k = request.headers.get("idempotency-key");
    headers = { "Idempotency-Key": k && IDEMPOTENCY_RE.test(k) ? k : crypto.randomUUID() };
  }

  try {
    const qs = decision.method === "GET" || decision.method === "DELETE" ? request.nextUrl.search : "";
    const r = await commanderRequest(`/${path.map(encodeURIComponent).join("/")}${qs}`, {
      method: decision.method,
      body,
      scope: decision.scope,
      headers,
      timeoutMs: proxyTimeoutFor(path),
    });
    return Response.json(r.json, { status: r.status, headers: NO_STORE });
  } catch (e) {
    const status = e instanceof ConfigError ? 503 : 502;
    return Response.json({ error: "upstream_unavailable", message: describeError(e) }, { status, headers: NO_STORE });
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
