import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
      // 'server-only' testda xato otmasligi uchun bo'sh modul
      "server-only": path.resolve(import.meta.dirname, "test/server-only-stub.ts"),
    },
  },
  test: { include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/setup-auth-dir.ts"] },
});
