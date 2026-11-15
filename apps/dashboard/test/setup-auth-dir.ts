import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Hech bir test haqiqiy `apps/dashboard/.auth` ga yozmasin (2026-11-14: describe ichidagi createSession egasining
// sessiyalarini ustidan yozib, login'ni buzgan). Har test fayli uchun sukut bo'yicha vaqtinchalik papka.
const dir = mkdtempSync(path.join(os.tmpdir(), "commander-auth-default-"));
process.env.DASHBOARD_AUTH_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
