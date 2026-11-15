import { describe, expect, it } from "vitest";
import { RELOAD_WINDOW_MS, isChunkLoadError, shouldReload } from "@/lib/chunk-reload";

describe("isChunkLoadError", () => {
  it("ChunkLoadError nomi va xabarlarini taniydi", () => {
    expect(isChunkLoadError({ name: "ChunkLoadError", message: "x" })).toBe(true);
    expect(isChunkLoadError(new Error("Failed to load chunk /_next/static/chunks/0d8_bfvwt_87_.js from module 64893"))).toBe(true);
    expect(isChunkLoadError(new Error("Loading chunk 123 failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
  });

  it("oddiy xatolarni chunk xatosi deb hisoblamaydi", () => {
    expect(isChunkLoadError(new Error("fetch failed: 500"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError("ChunkLoadError")).toBe(false);
  });
});

describe("shouldReload", () => {
  const now = 1_000_000;
  it("yozuv bo'lmasa qayta yuklaydi", () => {
    expect(shouldReload(null, "/projects", now)).toBe(true);
  });
  it("shu yo'lda yaqinda qayta yuklangan bo'lsa — sikl yo'q", () => {
    expect(shouldReload(`/projects|${now - 1000}`, "/projects", now)).toBe(false);
  });
  it("oyna o'tgach yoki boshqa yo'lda yana ruxsat", () => {
    expect(shouldReload(`/projects|${now - RELOAD_WINDOW_MS - 1}`, "/projects", now)).toBe(true);
    expect(shouldReload(`/sessions|${now - 1000}`, "/projects", now)).toBe(true);
    expect(shouldReload("buzuq", "/projects", now)).toBe(true);
  });
});
