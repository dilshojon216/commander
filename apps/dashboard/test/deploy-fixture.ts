import type { DeployInspectResult, DeployRunDto, DeployStep, DeploySummary, DeployTarget } from "@commander/contracts";

export const COMMIT = "a".repeat(40);
export const HASH = "b".repeat(64);

export const step = (name: string, argv: string[], over: Partial<DeployStep> = {}): DeployStep => ({ name, kind: "argv", argv, shell: null, cwd: null, env: {}, timeoutSec: 60, ...over });

export const target = (name = "prod", over: Partial<DeployTarget> = {}): DeployTarget => ({
  name,
  machine: "ubuntu-1",
  cwd: ".",
  timeoutSec: 600,
  preflight: [step("Tekshiruv", ["npm", "test"])],
  steps: [step("Build", ["npm", "run", "build"]), step("Restart", ["systemctl", "restart", "app"])],
  health: { kind: "http", url: "http://127.0.0.1:3000/health", argv: [], expectStatus: [200], timeoutSec: 5, retries: 2, intervalSec: 3 },
  rollback: [step("Orqaga", ["git", "checkout", "previous"])],
  usesShell: false,
  ...over,
});

export const inspect = (over: Partial<DeployInspectResult> = {}, t: DeployTarget = target()): DeployInspectResult => ({
  commit: COMMIT,
  branch: "main",
  dirty: false,
  recipePresent: true,
  workingTreeDiffers: false,
  valid: true,
  issues: [],
  recipe: { version: 1, targets: [t] },
  recipeHash: HASH,
  usesShell: t.usesShell,
  machineMatches: { [t.name]: true },
  allowDeploy: true,
  allowDeployShell: false,
  ...over,
});

export const summary = (over: Partial<DeploySummary> = {}): DeploySummary => ({
  kind: "run",
  target: "prod",
  commit: COMMIT,
  recipeHash: HASH,
  outcome: "success",
  failedPhase: null,
  failedStep: null,
  steps: [
    { phase: "preflight", name: "Tekshiruv", status: "ok", exitCode: 0, durationMs: 1200 },
    { phase: "steps", name: "Build", status: "ok", exitCode: 0, durationMs: 65_000 },
  ],
  health: { ok: true, attempts: 1, lastStatus: 200 },
  rollbackDefined: true,
  durationMs: 70_000,
  outputTruncated: false,
  ...over,
});

let n = 0;
export const run = (over: Partial<DeployRunDto> = {}): DeployRunDto => {
  n += 1;
  return {
    commandId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "run",
    target: "prod",
    commit: COMMIT,
    recipeHash: HASH,
    status: "done",
    errorCode: null,
    errorMessage: null,
    summary: summary(),
    requestedByDeviceId: "00000000-0000-4000-8000-0000000000ff",
    createdAt: new Date(Date.UTC(2026, 10, 14, 10, n)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 10, 14, 10, n, 30)).toISOString(),
    ...over,
  };
};
