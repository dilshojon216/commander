import { homedir, hostname, platform } from 'node:os';
import { ConfigSync } from './config-sync.js';
import { claudeConfigDir } from './config-fs.js';
import { AGENT_WS_PATH } from '@commander/contracts';
import type { ActiveSession, CenterKeyRotation } from '@commander/contracts';
import { ensureHomeDir, toWsUrl, type AgentdConfig } from './config.js';
import { openDb } from './db.js';
import { HookProcessor } from './hook-processor.js';
import { HookServer } from './hook-server.js';
import { discardNextKey, loadNextKey, loadPrivateKey, promoteNextKey } from './identity.js';
import { KeyRotator } from './key-rotation.js';
import { LimitsThrottle } from './limits.js';
import { errMsg, type Logger } from './logger.js';
import { OtlpReceiver } from './otlp-receiver.js';
import { SessionIdentity, createPeerAttestor, type LivePid, type PeerAttestor } from './peer-identity.js';
import { loadOrCreateOtlpToken } from './otlp-token.js';
import { Outbox } from './outbox.js';
import type { AgentdPaths } from './paths.js';
import { ProjectRootResolver } from './project-root.js';
import { Reconciler } from './reconciler.js';
import { SessionStore } from './session-store.js';
import { ErrorLoopEmitter } from './error-loop.js';
import { TranscriptTailer } from './transcript-tailer.js';
import { UsageIngest } from './usage-ingest.js';
import { AGENTD_VERSION } from './version.js';
import { createAgentsLister, type AgentsLister, type LiveSession } from './agents-cli.js';
import { runClaude } from './claude-exec.js';
import { AgentWsClient } from './ws-client.js';
import { ApprovalManager } from './approval-manager.js';
import { claudeProjectsRoot } from './chat-path.js';
import { ChatStreamManager } from './chat-stream.js';
import { MailboxClient } from './mailbox-client.js';
import { MailboxHandler } from './mailbox-handler.js';
import { createAgentEntriesLister } from './agents-full.js';
import { TmuxLocator, createTmuxExec } from './tmux.js';
import { applyCenterKeyRotations, decidePin, fingerprintOf } from './center-pin.js';
import { CommandManager } from './command-manager.js';
import { CommandStore } from './command-store.js';
import { loadPolicy } from './policy.js';
import { CommandRunner } from './runner.js';
import { loadConfig, saveConfig } from './config.js';
import { ProjectReporter } from './project-reporter.js';
import { ensureTaskCommand } from './task-command.js';
import { ProjectOps } from './project-ops.js';
import { GitOps } from './git-ops.js';
import { ProjectScan } from './project-scan.js';
import { LogsTail } from './logs-tail.js';
import { DeployOps } from './deploy-ops.js';
import { GitCheckpoints } from './git-checkpoints.js';
import { join } from 'node:path';
import { AssistantOps } from './assistant-ask.js';
import { SessionSummarizer } from './session-summarizer.js';
import { resolveExecutable, trustedBin } from './trusted-bin.js';
import { HealthCollector, HealthReporter } from './health/index.js';

export interface DaemonOptions {
  paths: AgentdPaths;
  config: AgentdConfig;
  log: Logger;
  /** Testlar uchun almashtiriladi. */
  agentsLister?: AgentsLister;
  /** Testlar uchun: `claude agents --all --json` o'rniga. */
  entriesLister?: import('./agents-full.js').AgentEntriesLister;
  /** Testlar uchun: haqiqiy tmux o'rniga. */
  tmux?: TmuxLocator;
  /** Testlar uchun: runner'ning `claude` ijrochisi. */
  runnerExec?: (args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<string>;
  /** Testlar uchun: `claude -p` (kun xulosasi) ijrochisi. */
  summarizeExec?: (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;
  /** Testlar uchun: root deb hisoblash. */
  runningAsRoot?: boolean;
  /** Config'dagi `centerUrl` ni almashtirish (saqlanmaydi). */
  centerUrl?: string;
  /** Testlar uchun: peer attestatsiyasini almashtirish. */
  peerAttestor?: PeerAttestor;
  /** Testlar uchun: `ps` ota-ona jadvali. */
  procParents?: () => Promise<Map<number, number>>;
  /** OTLP portini almashtirish (0 = tasodifiy; testlar). */
  otlpPort?: number;
  intervals?: { reconcileMs?: number; tailMs?: number; limitsFlushMs?: number; summaryMs?: number };
  /** `/task` buyrug'i faylini (`~/.claude/commands/task.md`) o'rnatish (faqat `agentd run`; testlarda o'chiq). */
  installTaskCommand?: boolean;
  /** Server salomatligi yig'uvchisini o'chirish (testlar: tashqi buyruq ishga tushmasin). */
  disableHealth?: boolean;
  /** Testlar uchun: loyiha snapshot'larini o'chirish (git/fayl o'qimaslik). */
  disableProjectReporter?: boolean;
  /** Testlar uchun: sessiya xulosalari aylanishini o'chirish. */
  disableSummaries?: boolean;
  /** Testlar uchun: center aloqasi kutish muddati. */
  approvalGraceMs?: number;
  wsClient?: { backoff?: { baseMs?: number; maxMs?: number }; pingIntervalMs?: number; stableAfterMs?: number };
}

export interface DaemonHandle {
  stop(): Promise<void>;
  client: AgentWsClient;
  outbox: Outbox;
  store: SessionStore;
  tailer: TranscriptTailer;
  reconciler: Reconciler;
  reporter: ProjectReporter;
  otlpPort: number;
}

function logTrustedBins(log: Logger, claudeBin: string): void {
  // Windows: child'lar ham cwd'dan exe qidirmasin (M-18); absolyut yo'llar bilan ikki qavatli himoya.
  if (platform() === 'win32') process.env['NoDefaultCurrentDirectoryInExePath'] = '1';
  const resolved = {
    git: trustedBin('git') ?? null,
    gh: trustedBin('gh') ?? null,
    tmux: platform() === 'win32' ? null : (trustedBin('tmux') ?? null),
    claude: resolveExecutable(claudeBin, 'claude') ?? null,
  };
  log.info('ishonchli ijrochi fayllar (absolyut yo\'l)', resolved);
  if (!resolved.git) log.warn('git ishonchli PATH\'da topilmadi: git ma\'lumotlari o\'chiq');
  if (!resolved.claude) log.warn('claude ishonchli PATH\'da topilmadi: config.claudeBin ga absolyut yo\'l bering');
}

/** Hamma qismlarni bog'laydi: SQLite, hook socket, OTLP, tailer, reconciliation, WS klient. */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const { paths, config, log } = opts;
  ensureHomeDir(paths);
  // M-18: git/gh/claude/tmux — ishonchli PATH'dan BIR MARTA absolyut yo'lga (cwd/nisbiy PATH yozuvlari chiqariladi).
  logTrustedBins(log, config.claudeBin);
  const db = openDb(paths.dbFile);
  const store = new SessionStore(db);
  const outbox = new Outbox(db, log.child('outbox'));
  const roots = new ProjectRootResolver();
  const lister = opts.agentsLister ?? createAgentsLister(config.claudeBin);
  let privateKey = loadPrivateKey(paths);

  let claudeVersion: string | undefined;
  if (!opts.agentsLister) {
    runClaude(config.claudeBin, ['--version'], { timeout: 5000 }).then(
      (stdout) => {
        claudeVersion = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0];
      },
      () => undefined,
    );
  }

  // client'dan oldin kerak bo'ladigan ko'prik: client keyin yaratiladi.
  let notify: () => void = () => undefined;
  const wake = (): void => notify();

  const reconciler = new Reconciler(db, store, outbox, lister, log.child('reconcile'), Date.now, wake);
  const tailer = new TranscriptTailer(store, outbox, log.child('tailer'), Date.now, wake, new ErrorLoopEmitter(store, outbox, wake));
  const reporter = new ProjectReporter({
    db,
    outbox,
    roots,
    store,
    log: log.child('projects'),
    configRoots: () => {
      try {
        return loadConfig(paths).projectRoots;
      } catch {
        return config.projectRoots;
      }
    },
    onEnqueued: wake,
  });
  const processor = new HookProcessor({
    db,
    store,
    outbox,
    roots,
    log: log.child('hook'),
    onTranscript: (sessionId, path) => tailer.register(sessionId, path),
    onRoot: (root) => {
      if (!opts.disableProjectReporter) reporter.noteRoot(root);
    },
  });
  const usage = new UsageIngest(store, outbox, log.child('usage'), Date.now, wake);
  const limits = new LimitsThrottle();

  const emitLimits = (payload: ReturnType<LimitsThrottle['flush']>): void => {
    if (!payload) return;
    outbox.enqueueLimits(payload);
    wake();
  };

  // tmux (2.6, POSIX): interaktiv sessiyalarning tekshirilgan pane'i. Reconcile bilan birga yangilanadi (keshli); o'rnatilmagan bo'lsa bo'sh.
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const tmux = opts.tmux ?? new TmuxLocator({ exec: createTmuxExec(), uid });
  let tmuxPanes = new Map<string, string>();
  const refreshTmux = async (): Promise<void> => {
    const live = reconciler.lastLive ?? [];
    const interactive = live.filter((s) => s.kind === 'interactive' && s.pid !== undefined);
    const byPid = await tmux.locateMany(interactive.map((s) => s.pid as number));
    const next = new Map<string, string>();
    for (const s of interactive) {
      const t = byPid.get(s.pid as number);
      if (t) next.set(s.claudeSessionId, t.paneId);
    }
    tmuxPanes = next;
  };

  const toActive = (): ActiveSession[] | undefined =>
    reconciler.lastLive?.map((s) => {
      const pane = tmuxPanes.get(s.claudeSessionId);
      return {
        claudeSessionId: s.claudeSessionId,
        ...(s.cwd ? { cwd: roots.resolve(s.cwd) } : {}),
        ...(pane ? { kind: 'tmux' as const, tmuxPane: pane } : s.kind ? { kind: s.kind } : {}),
      };
    });

  const approvals = new ApprovalManager({
    log: log.child('approvals'),
    resolveCwd: (cwd) => roots.resolve(cwd),
    // `awaiting_approval` hodisasi (cwd/ildiz/transcript ham yangilanadi); keyin center ham holatni o'tkazadi.
    onRequested: (payload) => {
      if (processor.process(payload)) wake();
    },
    // Lokal holatni hodisasiz tiklaydi (center o'zi tiklaydi; keyingi hook hodisalari baribir ustun).
    onSettled: (sessionId, outcome) => {
      if (store.get(sessionId)?.status === 'awaiting_approval') store.setStatus(sessionId, outcome === 'expired' ? 'waiting' : 'working');
    },
    ...(opts.approvalGraceMs !== undefined ? { connectGraceMs: opts.approvalGraceMs } : {}),
  });

  // Remote boshqaruv (2.3-2.7): imzo + nonce + lokal siyosat + runner. Policy har buyruqda qayta o'qiladi.
  // Pin har safar diskdan o'qiladi: lokal `agentd center-key reset` restartsiz kuchga kiradi.
  const readPin = (): AgentdConfig['centerKey'] => {
    try {
      return loadConfig(paths).centerKey;
    } catch {
      return config.centerKey;
    }
  };
  const entries = opts.entriesLister ?? createAgentEntriesLister(config.claudeBin);
  const commandStore = new CommandStore(db);
  commandStore.prune();
  // Sozlamalar sinxronlash (3.7): `CLAUDE_CONFIG_DIR` bo'lsa shu papka, aks holda ~/.claude
  const configSync = new ConfigSync({
    claudeDir: claudeConfigDir(process.env, homedir()),
    home: paths.home,
    log: log.child('config-sync'),
    sendChunk: (c) => ref.client?.sendConfigChunk(c) ?? false,
  });
  // Log ko'ruvchi (6.6): chiqish `logs.chunk` orqali jonli (ack/outbox yo'q), hech qayerda saqlanmaydi.
  const logs = new LogsTail({ log: log.child('logs'), send: (p) => ref.client?.sendLogs(p) ?? false, policy: () => loadPolicy(paths).policy });
  const commands = new CommandManager({
    store: commandStore,
    runner: new CommandRunner({ claudeBin: config.claudeBin, list: entries, log: log.child('runner'), tmux, ownedTmux: () => commandStore.createdTmuxSessions(), localStatus: (id) => store.get(id)?.status ?? undefined, ...(opts.runnerExec ? { exec: opts.runnerExec } : {}) }),
    list: entries,
    policy: () => loadPolicy(paths),
    pinnedKey: () => readPin()?.publicKey,
    deviceId: config.deviceId,
    log: log.child('commands'),
    runningAsRoot: opts.runningAsRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0),
    projectOps: new ProjectOps({
      snapshot: (root) => reporter.snapshotNow(root),
      claudeBin: config.claudeBin,
      summarizeDir: join(paths.home, 'summarize'),
      log: log.child('project-ops'),
      ...(opts.summarizeExec ? { exec: opts.summarizeExec } : {}),
    }),
    gitOps: new GitOps({ log: log.child('git-ops') }),
    // Deploy (6.5): chiqish `logs.chunk` orqali jonli (DB'ga yozilmaydi); checkpoint (6.9)
    deploy: new DeployOps({ log: log.child('deploy'), send: (p) => ref.client?.sendLogs(p) ?? false, policy: () => loadPolicy(paths).policy }),
    checkpoints: new GitCheckpoints({ log: log.child('checkpoints') }),
    scan: new ProjectScan({ log: log.child('project-scan') }),
    assistant: new AssistantOps({ claudeBin: config.claudeBin, dir: join(paths.home, 'summarize'), log: log.child('assistant'), ...(opts.summarizeExec ? { exec: opts.summarizeExec } : {}) }),
    configSync,
    logs,
  });
  const onCenterKey = (announced: string | undefined): void => {
    const current = readPin();
    const d = decidePin(current, announced);
    if (d.kind === 'pin') {
      // TOFU (enrollment'da pin qilinmagan eski agentlar): birinchi ko'rilgan kalit. Keyin faqat lokal `center-key reset`.
      const next = { publicKey: d.publicKey, fingerprint: fingerprintOf(d.publicKey), pinnedAt: new Date().toISOString(), via: 'tofu' as const };
      try {
        saveConfig(paths, { ...loadConfig(paths), centerKey: next });
        log.warn('markaz buyruq-imzo kaliti PIN qilindi (TOFU)', { fingerprint: next.fingerprint });
      } catch (err) {
        log.error('markaz kalitini pin qilib saqlab bo\'lmadi', { error: errMsg(err) });
      }
    } else if (d.kind === 'mismatch') {
      log.error('MARKAZ KALITI PIN BILAN MOS EMAS: masofaviy buyruqlar rad etiladi (ishonchli bo\'lsa lokal "agentd center-key reset")', { pinned: current?.fingerprint, announced: fingerprintOf(announced ?? '') });
    }
  };

  // Markaz kalitini aylantirish e'lonlari (5.1): ESKI (pin qilingan) kalit imzosi tekshiriladi, pin TOFUsiz yangilanadi.
  const onCenterKeyRotations = (rotations: CenterKeyRotation[]): void => {
    const current = readPin();
    const r = applyCenterKeyRotations(current, rotations, Date.now());
    if (r.applied > 0 && r.pinned) {
      try {
        saveConfig(paths, { ...loadConfig(paths), centerKey: r.pinned });
        log.warn('markaz buyruq-imzo kaliti aylantirildi: pin eski kalit imzosi bilan yangilandi', { from: current?.fingerprint, to: r.pinned.fingerprint });
      } catch (err) {
        log.error('yangilangan markaz pin\'ini saqlab bo\'lmadi', { error: errMsg(err) });
      }
    }
    if (r.rejected) log.error("markaz kalitini aylantirish e'loni rad etildi (buyruqlar pin bilan mos kelmasa rad etiladi)", { reason: r.rejected });
  };

  // Chat oqimi (markaz so'raganda): transport `client` yaratilgach ulanadi.
  const ref: { client?: AgentWsClient } = {};
  const chat = new ChatStreamManager(
    {
      isReady: () => ref.client?.isReady() ?? false,
      send: (type, payload) => ref.client?.sendChat(type, payload) ?? false,
    },
    { log: log.child('chat'), projectsRoot: () => claudeProjectsRoot() },
  );

  const mailbox = new MailboxClient(
    { isReady: () => ref.client?.isReady() ?? false, send: (type, payload) => ref.client?.sendMailbox(type, payload) ?? false },
    log.child('mailbox'),
  );
  // M-14: mailbox so'rovlarining sessiya identity'si peer jarayonga (yadro pid'i + ota-ona zanjiri) bog'lanadi.
  const attestor = opts.peerAttestor ?? createPeerAttestor();
  let freshAt = 0;
  let freshCache: LivePid[] = [];
  const livePids = (rows: LiveSession[] | undefined): LivePid[] => (rows ?? []).filter((s): s is LiveSession & { pid: number } => s.pid !== undefined).map((s) => ({ sessionId: s.claudeSessionId, pid: s.pid }));
  const identity = new SessionIdentity({
    attestor,
    ...(opts.procParents ? { parents: opts.procParents } : {}),
    log: log.child('identity'),
    sessions: async (fresh) => {
      if (!fresh) return livePids(reconciler.lastLive);
      if (Date.now() - freshAt < 1500) return freshCache; // `claude agents --json` ni qayta-qayta chaqirmaslik
      freshAt = Date.now();
      freshCache = livePids(await lister());
      return freshCache;
    },
  });
  // Sessiya xulosalari (6.1): transcript lokal o'qiladi, markazga faqat redakt qilingan natija ketadi.
  const summarizer = new SessionSummarizer({
    db,
    store,
    mailbox,
    log: log.child('summary'),
    claudeBin: config.claudeBin,
    dir: join(paths.home, 'summarize'),
    enabled: () => {
      try {
        return loadConfig(paths).summaries;
      } catch {
        return config.summaries;
      }
    },
    ...(opts.summarizeExec ? { exec: opts.summarizeExec } : {}),
  });
  const mailboxHandler = new MailboxHandler({ client: mailbox, store, log: log.child('mailbox'), resolveCwd: (cwd) => roots.resolve(cwd), identity });

  const client = new AgentWsClient({
    url: toWsUrl(opts.centerUrl ?? config.centerUrl, AGENT_WS_PATH),
    deviceId: config.deviceId,
    privateKey,
    outbox,
    log: log.child('ws'),
    onCenterKeyRotations,
    centerKeyFingerprint: () => readPin()?.fingerprint,
    onRotationRequired: () => void rotator.rotate().then((r) => (r.ok ? undefined : log.warn("markaz so'ragan kalit aylantirish bajarilmadi", { reason: r.reason }))),
    fallbackKey: () => loadNextKey(paths),
    onFallbackKeyAccepted: (k) => {
      try {
        promoteNextKey(paths);
        privateKey = k;
        log.warn("kalit aylantirish markazda qo'llangan edi: yangi kalit asosiy qilindi");
      } catch (err) {
        log.error("yangi kalitni asosiy qilib bo'lmadi", { error: errMsg(err) });
      }
    },
    onPrimaryKeyConfirmed: () => discardNextKey(paths),
    agentdVersion: AGENTD_VERSION,
    hostname: hostname(),
    os: platform(),
    claudeVersion: () => claudeVersion,
    activeSessions: toActive,
    approvals,
    chat,
    logs,
    mailbox,
    commands,
    control: () => commands.controlState(),
    config: { onChunk: (c) => configSync.onChunk(c), heartbeatReport: (first) => configSync.heartbeatReport(first) },
    onCenterKey,
    ...(opts.wsClient ?? {}),
  });
  ref.client = client;
  const rotator = new KeyRotator({
    paths,
    deviceId: config.deviceId,
    log: log.child('key-rotation'),
    getKey: () => privateKey,
    setKey: (k) => {
      privateKey = k;
      client.setSigningKey(k);
    },
    isReady: () => client.isReady(),
    rotateKey: (payload) => client.rotateKey(payload),
  });
  notify = () => client.notifyEnqueued();
  approvals.attach({ isReady: () => client.isReady(), send: (type, payload) => client.sendApproval(type, payload) });
  commands.attach({ isReady: () => client.isReady(), send: (type, payload) => client.sendCommand(type, payload) });

  const hookServer = new HookServer(
    paths.socketFile,
    {
      onHook: (payload) => {
        approvals.onSessionHook(payload); // lokal hal bo'lganini aniqlash (processor'dan OLDIN: holat tiklanadi)
        if (processor.process(payload)) wake();
        summarizer.noteHook(payload);
      },
      onPermission: (payload, deadlineMs, conn) => approvals.request(payload, deadlineMs, conn),
      onMailbox: (payload, conn) => void mailboxHandler.handle(payload, conn),
      onRotateKey: () => rotator.rotate(),
      onStatusline: (payload) => emitLimits(limits.observe(payload, Date.now())),
      status: () => ({
        version: AGENTD_VERSION,
        pid: process.pid,
        deviceId: config.deviceId,
        ws: client.status(),
        tailedTranscripts: tailer.trackedCount(),
        openSessions: store.listOpen().length,
        pendingApprovals: approvals.pendingCount(),
        remoteControl: { ...commands.controlState(), policySource: loadPolicy(paths).source, runningCommands: commands.pendingCount(), centerKeyFingerprint: readPin()?.fingerprint ?? null },
        chatStreams: chat.count(),
        mailboxIdentity: identity.mode,
        otlp: { ...otlp.counters, tokenRequired: config.otlpRequireToken },
      }),
    },
    log.child('socket'),
    attestor,
  );

  let otlpToken: string | undefined;
  try {
    otlpToken = loadOrCreateOtlpToken(paths);
  } catch (err) {
    log.error("OTLP tokenini o'qib/yaratib bo'lmadi: autentifikatsiyasiz (moslik) rejimi", { error: errMsg(err) });
  }
  const otlp = new OtlpReceiver(opts.otlpPort ?? config.otlpPort, (reqs) => usage.ingestOtel(reqs), log.child('otlp'), {
    ...(otlpToken ? { token: otlpToken } : {}),
    strict: config.otlpRequireToken,
  });

  await hookServer.start();
  let otlpPort: number;
  try {
    otlpPort = await otlp.start();
  } catch (err) {
    await hookServer.stop();
    throw err;
  }

  outbox.prune();
  store.prune();
  tailer.start(opts.intervals?.tailMs ?? 5000);
  if (!opts.disableProjectReporter) reporter.start();
  if (opts.installTaskCommand) {
    const r = ensureTaskCommand();
    if (r === 'created' || r === 'updated') log.info('/task buyrug\'i o\'rnatildi', { result: r });
    else if (r === 'error') log.warn('/task buyrug\'i faylini yozib bo\'lmadi');
  }
  client.start();
  if (!opts.disableSummaries) summarizer.start(opts.intervals?.summaryMs ?? 60_000);

  // Server salomatligi (3.8): har 30 s `agent.health` (jonli; ulanish yo'q bo'lsa yig'ilmaydi).
  const health = new HealthReporter({
    collector: new HealthCollector(),
    transport: { isReady: () => client.isReady(), send: (payload) => client.sendHealth(payload) },
    log: log.child('health'),
  });
  if (!opts.disableHealth) health.start();

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void | Promise<void>): void => {
    const t = setInterval(() => {
      Promise.resolve(fn()).catch((err: unknown) => log.error('davriy vazifa xatosi', { error: errMsg(err) }));
    }, ms);
    t.unref();
    timers.push(t);
  };
  const reconcileAndScan = async (): Promise<void> => {
    await reconciler.run();
    await refreshTmux().catch((err: unknown) => log.warn('tmux skaneri xatosi', { error: errMsg(err) }));
  };
  every(opts.intervals?.reconcileMs ?? 30_000, () => reconcileAndScan());
  every(opts.intervals?.limitsFlushMs ?? 5000, () => {
    if (limits.hasPending()) emitLimits(limits.flush(Date.now()));
  });
  every(60 * 60 * 1000, () => {
    commandStore.prune();
    outbox.prune();
    store.prune();
  });
  // Birinchi reconciliation tezroq (heartbeat'ga activeSessions to'ldirish uchun).
  const first = setTimeout(() => void reconcileAndScan(), 3000);
  first.unref();
  timers.push(first);

  log.info('agentd ishga tushdi', { version: AGENTD_VERSION, deviceId: config.deviceId, otlpPort });

  return {
    client,
    outbox,
    store,
    tailer,
    reconciler,
    reporter,
    otlpPort,
    stop: async () => {
      for (const t of timers) clearTimeout(t);
      tailer.stop();
      summarizer.stop();
      reporter.stop();
      health.stop();
      approvals.stop();
      chat.stopAll();
      logs.stopAll();
      mailbox.stop();
      await client.stop();
      await otlp.stop();
      await hookServer.stop();
      db.close();
      log.info('agentd to\'xtadi');
    },
  };
}
