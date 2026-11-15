import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import type { ProjectSnapshotPayload } from '@commander/contracts';
import { isGitRoot, readHead, type GitRunner } from './git-info.js';
import { errMsg, type Logger } from './logger.js';
import type { Outbox } from './outbox.js';
import type { ProjectRootResolver } from './project-root.js';
import { buildSnapshot } from './project-snapshot.js';
import type { SessionStore } from './session-store.js';

export interface ProjectReporterDeps {
  db: DatabaseSync;
  outbox: Outbox;
  roots: ProjectRootResolver;
  store: SessionStore;
  log: Logger;
  /** `~/.commander/config.json` `projectRoots` (har chaqiruvda qayta o'qiladi). */
  configRoots?: () => string[];
  git?: GitRunner;
  now?: () => number;
  /** outbox'ga yangi snapshot tushganda (WS pump'ni uyg'otish). */
  onEnqueued?: () => void;
}

export const REPORT_INTERVAL_MS = 5 * 60_000;
export const HEAD_CHECK_INTERVAL_MS = 15_000;
const MAX_ROOTS = 200;
/** Katta repo: `git status` taymaut bersa shuncha vaqt status'siz davom etamiz. */
const STATUS_BACKOFF_MS = 60 * 60_000;
const ROOT_RETENTION_MS = 60 * 24 * 3600_000;

/**
 * project-reporter (task 2.1): ma'lum loyiha ildizlari (sessiya cwd ildizlari + config `projectRoots`) uchun har 5 daqiqada
 * va git HEAD o'zgarganda snapshot oladi; mazmun xeshi o'zgargan bo'lsagina `agent.project_snapshot` outbox'ga qo'yiladi.
 * Ketma-ket ishlaydi (bir vaqtda bitta git jarayoni): katta repolar mashinani bo'g'maydi.
 */
export class ProjectReporter {
  private readonly now: () => number;
  /** Oxirgi yuborilgan xesh (xotirada: restartdan keyin bir marta qayta yuboriladi, markaz `UNIQUE(project, hash)` bilan dedup qiladi). */
  private readonly lastHash = new Map<string, string>();
  private readonly lastHeadFp = new Map<string, string>();
  private readonly statusBackoffUntil = new Map<string, number>();
  private readonly pending = new Set<string>();
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(private readonly d: ProjectReporterDeps) {
    this.now = d.now ?? Date.now;
    d.db.exec(`
      CREATE TABLE IF NOT EXISTS project_roots (
        root TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
    `);
  }

  /** Hook/usage yangi ildiz ko'rsa chaqiriladi: yozib qo'yadi va tez orada snapshot oladi. */
  noteRoot(root: string): void {
    if (!root || root === '/unknown') return;
    const t = this.now();
    this.d.db.prepare('INSERT INTO project_roots (root, seen_at) VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET seen_at = excluded.seen_at').run(root, t);
    if (!this.lastHash.has(root)) this.schedule(root);
  }

  /** Barcha ma'lum ildizlar (takrorsiz, cheklangan). */
  knownRoots(): string[] {
    const set = new Set<string>();
    for (const r of this.d.store.listRoots()) set.add(r);
    for (const row of this.d.db.prepare('SELECT root FROM project_roots ORDER BY seen_at DESC').all() as unknown as Array<{ root: string }>) set.add(row.root);
    for (const cfg of this.d.configRoots?.() ?? []) {
      try {
        set.add(this.d.roots.resolve(cfg));
      } catch {
        /* yaroqsiz config yo'li */
      }
    }
    return [...set].slice(0, MAX_ROOTS);
  }

  start(intervalMs: number = REPORT_INTERVAL_MS, headCheckMs: number = HEAD_CHECK_INTERVAL_MS): void {
    const every = (ms: number, fn: () => Promise<void> | void): void => {
      const t = setInterval(() => {
        Promise.resolve(fn()).catch((err: unknown) => this.d.log.error('project-reporter xatosi', { error: errMsg(err) }));
      }, ms);
      t.unref();
      this.timers.push(t);
    };
    every(intervalMs, async () => void (await this.runAll()));
    every(headCheckMs, () => this.checkHeads());
    const first = setTimeout(() => void this.runAll().catch((err: unknown) => this.d.log.error('project-reporter xatosi', { error: errMsg(err) })), 5_000);
    first.unref();
    this.timers.push(first);
    this.prune();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** HEAD iz o'zgargan ildizlar uchun snapshot rejalashtiradi (fayl o'qish, git jarayonisiz). */
  checkHeads(): void {
    for (const root of this.knownRoots()) {
      const head = readHead(root);
      if (!head) continue;
      const prev = this.lastHeadFp.get(root);
      this.lastHeadFp.set(root, head.fingerprint);
      if (prev !== undefined && prev !== head.fingerprint) this.schedule(root);
    }
  }

  private schedule(root: string): void {
    if (this.stopped) return;
    this.pending.add(root);
    setTimeout(() => void this.drain().catch((err: unknown) => this.d.log.error('project-reporter xatosi', { error: errMsg(err) })), 500).unref();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.size > 0 && !this.stopped) {
        const root = this.pending.values().next().value as string;
        this.pending.delete(root);
        await this.runRoot(root);
      }
    } finally {
      this.running = false;
    }
  }

  /** Barcha ildizlar ketma-ket. Qaytadi: outbox'ga qo'yilgan snapshotlar soni. */
  async runAll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      for (const root of this.knownRoots()) {
        if (this.stopped) break;
        this.pending.delete(root);
        if (await this.runRoot(root)) sent++;
      }
    } finally {
      this.running = false;
    }
    return sent;
  }

  /** Majburiy yangilash (`project.refresh`, TASKS.md tahriridan keyin): oxirgi xesh unutiladi, shuning uchun o'zgarmagan bo'lsa ham qayta yuboriladi. */
  snapshotNow(root: string): Promise<boolean> {
    this.lastHash.delete(root);
    return this.runRoot(root);
  }

  /** `true` = yangi snapshot outbox'ga qo'yildi (xesh o'zgargan). */
  async runRoot(root: string): Promise<boolean> {
    try {
      if (!existsSync(root)) return false;
      const t = this.now();
      const skipStatus = (this.statusBackoffUntil.get(root) ?? 0) > t;
      const built = await buildSnapshot(root, { ...(this.d.git ? { git: this.d.git } : {}), skipStatus, now: this.now });
      if (!built) {
        this.d.log.warn("snapshot kontraktga mos emas, o'tkazib yuborildi", { root });
        return false;
      }
      if (built.statusTimedOut) {
        this.statusBackoffUntil.set(root, t + STATUS_BACKOFF_MS);
        this.d.log.warn("git status taymaut berdi (katta repo): 1 soat status'siz davom etadi", { root });
      }
      const head = readHead(root);
      if (head) this.lastHeadFp.set(root, head.fingerprint);
      const p = built.payload;
      // git bo'lmagan va hech qanday md topilmagan papkada (masalan /tmp) hisobot qilinadigan narsa yo'q
      if (p.kind === 'dir' && !p.todosMd && !p.changelogMd && !p.tasksMd && !(p.parts && p.parts.length > 0)) return false;
      return this.enqueue(p);
    } catch (err) {
      this.d.log.warn('loyiha snapshoti olinmadi', { root, error: errMsg(err) });
      return false;
    }
  }

  private enqueue(p: ProjectSnapshotPayload): boolean {
    if (this.lastHash.get(p.path) === p.hash) return false;
    const added = this.d.outbox.enqueueProject(p);
    this.lastHash.set(p.path, p.hash); // outbox'da bo'lsa ham xesh "yuborilgan" hisoblanadi (dedup_key)
    if (added) this.d.onEnqueued?.();
    return added;
  }

  private prune(): void {
    this.d.db.prepare('DELETE FROM project_roots WHERE seen_at < ?').run(this.now() - ROOT_RETENTION_MS);
  }

  /** Test uchun. */
  isGitRoot(root: string): boolean {
    return isGitRoot(root);
  }
}
