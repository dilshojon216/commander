import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readSessionCookie } from "@/lib/auth/cookie";
import { lookupSession } from "@/lib/auth/sessions";
import { getAuthSettings } from "@/lib/auth/settings";
import { isPublicPath, safeNextPath } from "@/lib/auth/paths";

/**
 * DNS-rebinding himoyasi: dashboard lokal fayllar va git bilan ishlaydi, shuning
 * uchun faqat loopback Host'lar (va DASHBOARD_ALLOWED_HOSTS dagilar) qabul qilinadi.
 */
function allowedHosts(): Set<string> {
  const extra = (process.env.DASHBOARD_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(["127.0.0.1", "localhost", "[::1]", ...extra]);
}

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (!allowedHosts().has(hostnameOf(host))) {
    return new NextResponse("Host ruxsat etilmagan", { status: 403 });
  }

  // H-01: hamma narsa (sahifalar, /api/c, /api/stream, /api/chat) sessiyasiz yopiq; faqat /login va /api/auth/* ochiq.
  // Bu birinchi qatlam; har route handler va layout o'zi ham tekshiradi (proxy'ga yolg'iz tayanilmaydi).
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  const isDocument = request.method === "GET" && (request.headers.get("sec-fetch-dest") === "document" || (request.headers.get("accept") ?? "").includes("text/html"));
  const found = lookupSession(readSessionCookie(request.headers.get("cookie")), Date.now(), getAuthSettings(), { touch: isDocument });
  if (found.ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthenticated", message: "Kirish talab qilinadi" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const url = new URL("/login", request.url);
  const next = safeNextPath(`${pathname}${search}`);
  if (next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
