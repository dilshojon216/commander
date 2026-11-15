import type { NextConfig } from "next";

/**
 * M-09: clickjacking va boshqa brauzer himoyasi. WKWebView (menu-bar ilova) dashboard'ni o'z origin'ida ochadi (frame emas),
 * shuning uchun `frame-ancestors 'none'` unga ta'sir qilmaydi. Nonce'siz CSP (Next.js hujjati: "Without Nonces"): Next inline
 * hydration skriptlari uchun `'unsafe-inline'` kerak, lekin tashqi manbalar, `<object>`, boshqa saytga forma va freymlash yopiq.
 * `upgrade-insecure-requests` ATAYLAB yo'q: dashboard http://127.0.0.1:4318 da ishlaydi.
 */
const isDev = process.env.NODE_ENV === "development";

export const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Ishlab turgan xizmat (launchd) alohida `.next-release` dan o'qiydi: repo'dagi test/CI build'lari (`.next`) uning
  // fayllarini almashtirib yubormasin (2026-11-14: ChunkLoadError — sahifalar ochilmay qolgan edi).
  distDir: process.env.COMMANDER_DASHBOARD_DIST || ".next",
  // Dashboard har so'rovda dinamik ishlaydi (lokal fayllar, git, Commander API).
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
