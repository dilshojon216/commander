import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MESSAGE_LIMITS, PEER_FRAME_HEADER } from '@commander/contracts';
import type { MailboxCall } from '@commander/contracts';
import { CommandsService } from '../../src/commands/commands.service.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { MessagingModule } from '../../src/messaging/messaging.module.js';
import { MessagingService } from '../../src/messaging/messaging.service.js';
import type { MessagingActor } from '../../src/messaging/messaging.service.js';
import { AgentDispatchService } from '../../src/realtime/agent-dispatch.service.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import type { DomainEvent } from '../../src/realtime/realtime-bus.js';
import { createThrowawayDb } from './helpers.js';

/**
 * 2.10: pochta qutisi. Haqiqiy TimescaleDB; `CommandsService` soxta (uyg'otish buyrug'i yozib olinadi).
 * Tekshiriladi: guruhlash (repo_key + links), sukutda o'chiq, kill-switch, guruhlar o'rtasida izolyatsiya, redakt/hajm,
 * ramka, deliver/stop_check bir martalik, audit (matnsiz), retention, rol ustuvorligi, uyg'otish cheklovlari.
 */

let dbh: { url: string; drop: () => Promise<void> };
let ds: DataSource;
let svc: MessagingService;
let dispatch: AgentDispatchService;
const events: DomainEvent[] = [];
const wakeCalls: Array<{ body: { type: string; sessionId?: string; text?: string }; key: string | undefined }> = [];
const owner: MessagingActor = { deviceId: null, actorKind: 'web', ip: null };

interface Seed {
  machineId: string;
  deviceId: string;
  sessionId: string;
  claude: string;
  projectId: string;
}

async function seedMachine(name: string): Promise<{ id: string; deviceId: string }> {
  const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug, hostname) VALUES ($1, $1) RETURNING id`, [name]);
  const mid = (m as { id: string }).id;
  // audit_log.actor_device_id FK: haqiqiy agentd qurilmasi (public_key 32 bayt)
  const [d]: Array<{ id: string }> = await ds.query(`INSERT INTO devices (machine_id, kind, public_key, scopes) VALUES ($1, 'agentd', $2, '{}') RETURNING id`, [mid, Buffer.alloc(32, counter++ + 1)]);
  return { id: mid, deviceId: (d as { id: string }).id };
}

let counter = 0;
async function seedSession(machineId: string, deviceId: string, o: { name: string; path: string; repoKey: string | null; kind?: string; status?: string }): Promise<Seed> {
  const [p]: Array<{ id: string }> = await ds.query(
    `INSERT INTO projects (machine_id, path, name, repo_key) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
    [machineId, o.path, o.name, o.repoKey],
  );
  const projectId = p?.id ?? ((await ds.query(`SELECT id FROM projects WHERE machine_id = $1 AND path = $2`, [machineId, o.path])) as Array<{ id: string }>)[0]!.id;
  const claude = `${(++counter).toString(16).padStart(8, '0')}-aaaa-4000-8000-${randomUUID().slice(-12)}`;
  const [s]: Array<{ id: string }> = await ds.query(
    `INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, kind, status, started_at, status_since, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), now()) RETURNING id`,
    [machineId, claude, projectId, o.path, o.name, o.kind ?? 'interactive', o.status ?? 'idle'],
  );
  return { machineId, deviceId, sessionId: (s as { id: string }).id, claude, projectId };
}

const call = (s: Seed, c: MailboxCall) => svc.handleMailbox(s.machineId, s.deviceId, { reqId: randomUUID(), claudeSessionId: s.claude, call: c });
const send = (s: Seed, to: string, over: Partial<Extract<MailboxCall, { op: 'send' }>> = {}) =>
  call(s, { op: 'send', to, kind: 'question', subject: 'Schema?', body: 'users jadvalida phone bormi?', ...over });
const data = <T>(r: { ok: boolean; data?: unknown; error?: { code: string } }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error?.code}`);
  return r.data as T;
};

async function enable(key: string, extra: { autoWake?: boolean; telegramQuestions?: boolean } = {}): Promise<void> {
  await svc.patchGroup(key, { enabled: true, ...extra }, owner);
}

let backend: Seed;
let frontend: Seed;
let mobile: Seed;
let outsider: Seed;
const REPO = 'github.com/acme/water';

beforeAll(async () => {
  dbh = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(dbh.url, true)),
      CoreModule,
      IdentityModule,
      MessagingModule,
    ],
  })
    .overrideProvider(CommandsService)
    .useValue({
      create: async (body: { type: string; sessionId?: string; text?: string }, _actor: unknown, key: string | undefined) => {
        wakeCalls.push({ body, key });
        return { command: { id: randomUUID(), status: 'sent' }, idempotent: false };
      },
    })
    .compile();
  await moduleRef.init();
  ds = moduleRef.get(DataSource);
  svc = moduleRef.get(MessagingService);
  dispatch = moduleRef.get(AgentDispatchService);
  moduleRef.get(RealtimeBus).subscribe((e) => void events.push(e));

  const mac = await seedMachine('mac');
  const srv = await seedMachine('srv');
  // Bitta repo (repo_key): server'dagi backend va Mac'dagi frontend (boshqa mashina, boshqa yo'l) = bir guruh.
  backend = await seedSession(srv.id, srv.deviceId, { name: 'water-api', path: '/srv/water', repoKey: REPO });
  frontend = await seedSession(mac.id, mac.deviceId, { name: 'water-web', path: '/Users/x/water', repoKey: REPO });
  // Boshqa repo, workspace bilan bog'lanadi (links testida)
  mobile = await seedSession(mac.id, mac.deviceId, { name: 'water_mobile_app', path: '/Users/x/water_mobile_app', repoKey: 'github.com/acme/water-mobile' });
  // Butunlay boshqa guruh
  outsider = await seedSession(mac.id, mac.deviceId, { name: 'notes', path: '/Users/x/notes', repoKey: 'github.com/acme/notes' });
});

afterAll(async () => {
  await ds?.destroy();
  await dbh?.drop();
});

describe('guruhlash (repo_key + links)', () => {
  it('bir repo_key = bir guruh (turli mashina); sukutda O\'CHIQ; rol taxmin (guess) deb belgilanadi', async () => {
    const { groups, settings } = await svc.listGroups();
    expect(settings.enabled).toBe(true); // global sukut: yoqilgan
    const g = groups.find((x) => x.key === REPO)!;
    expect(g.members.map((m) => m.machineName).sort()).toEqual(['mac', 'srv']);
    expect(g.enabled).toBe(false);
    expect(g.autoWake).toBe(false);
    expect(g.members.find((m) => m.machineName === 'srv')).toMatchObject({ role: 'backend', roleSource: 'guess' });
    expect(g.members.find((m) => m.machineName === 'mac')).toMatchObject({ role: 'frontend', roleSource: 'guess' });
    expect(groups.find((x) => x.key === 'github.com/acme/notes')!.members).toHaveLength(1);
  });

  it('yoqilmagan guruhda yuborish/o\'qish rad etiladi; hook\'lar jim bo\'sh', async () => {
    const r = await send(backend, 'frontend');
    expect(r).toMatchObject({ ok: false, error: { code: 'messaging_disabled' } });
    expect((await call(backend, { op: 'peers' })).error?.code).toBe('messaging_disabled');
    expect(data(await call(frontend, { op: 'deliver' }))).toEqual({ text: null, count: 0, remaining: 0 });
    expect(data(await call(frontend, { op: 'stop_check' }))).toEqual({ text: null, count: 0, remaining: 0 });
    expect(await ds.query(`SELECT 1 FROM session_messages`)).toHaveLength(0);
  });

  it('workspace bog\'lash: turli repo bitta guruh; bog\'lashni olib tashlash guruhni ajratadi', async () => {
    await svc.putLink(REPO, 'water', owner);
    await svc.putLink('github.com/acme/water-mobile', 'water', owner);
    let groups = (await svc.listGroups()).groups;
    const ws = groups.find((g) => g.key === 'workspace:water')!;
    expect(ws.members).toHaveLength(3);
    expect(ws.baseKeys).toEqual([REPO, 'github.com/acme/water-mobile']);
    expect(groups.find((g) => g.key === REPO)).toBeUndefined();
    await svc.deleteLink('github.com/acme/water-mobile', owner);
    groups = (await svc.listGroups()).groups;
    expect(groups.find((g) => g.key === 'workspace:water')!.members).toHaveLength(2);
    await svc.deleteLink(REPO, owner);
    await expect(svc.deleteLink(REPO, owner)).rejects.toMatchObject({ status: 404 });
    await expect(svc.putLink('no/such-repo', 'x', owner)).rejects.toMatchObject({ status: 404 });
  });
});

describe('yuborish, ramka, yetkazish', () => {
  beforeAll(async () => {
    await svc.putLink(REPO, 'water', owner);
    await svc.putLink('github.com/acme/water-mobile', 'water', owner);
    await enable('workspace:water');
  });

  it('rol bo\'yicha yuborish: faqat shu rol; boshqa guruh ko\'rmaydi (izolyatsiya)', async () => {
    const r = data<{ recipients: number; target: string; messageIds: string[] }>(await send(backend, 'frontend'));
    expect(r).toMatchObject({ recipients: 1, target: 'role:frontend' });
    const rows: Array<{ to_session_id: string; group_key: string; from_role: string }> = await ds.query(`SELECT to_session_id, group_key, from_role FROM session_messages`);
    expect(rows).toEqual([{ to_session_id: frontend.sessionId, group_key: 'workspace:water', from_role: 'backend' }]);
    // boshqa guruhdagi sessiya shu guruhga yozolmaydi / ko'rolmaydi
    expect((await call(outsider, { op: 'send', to: 'frontend', kind: 'info', subject: 'x', body: 'y' })).error?.code).toBe('messaging_disabled');
    await enable('github.com/acme/notes');
    expect((await send(outsider, 'frontend')).error?.code).toBe('unknown_target');
    expect((await send(outsider, 'all')).error?.code).toBe('no_recipients');
    expect((await send(outsider, frontend.claude.slice(0, 8))).error?.code).toBe('unknown_target'); // boshqa guruh sessiyasi id bilan ham topilmaydi
    expect(data<{ text: string | null }>(await call(outsider, { op: 'deliver' })).text).toBeNull();
    expect(data<{ peers: unknown[] }>(await call(outsider, { op: 'peers' })).peers).toHaveLength(1);
  });

  it('deliver: ramkali blok, bir martalik (ikkinchi chaqiruv bo\'sh), holat delivered; inbox o\'qilgan qiladi', async () => {
    const d1 = data<{ text: string; count: number }>(await call(frontend, { op: 'deliver' }));
    expect(d1.count).toBe(1);
    expect(d1.text).toContain(PEER_FRAME_HEADER);
    expect(d1.text).toContain('Schema?');
    expect(d1.text).toContain('> users jadvalida phone bormi?');
    expect(data<{ count: number }>(await call(frontend, { op: 'deliver' })).count).toBe(0);
    const [row]: Array<{ status: string; delivered_at: Date | null; read_at: Date | null }> = await ds.query(`SELECT status, delivered_at, read_at FROM session_messages WHERE to_session_id = $1`, [frontend.sessionId]);
    expect(row).toMatchObject({ status: 'delivered', read_at: null });
    expect(row!.delivered_at).not.toBeNull();
    // inbox (unreadOnly): kontekstga tushgan, lekin o'qilmagan xabarni ham beradi va o'qilgan qiladi
    const inbox = data<{ text: string; count: number }>(await call(frontend, { op: 'inbox' }));
    expect(inbox.count).toBe(1);
    expect(inbox.text).toContain(PEER_FRAME_HEADER);
    const [after]: Array<{ status: string }> = await ds.query(`SELECT status FROM session_messages WHERE to_session_id = $1`, [frontend.sessionId]);
    expect(after!.status).toBe('read');
    expect(data<{ text: string; count: number }>(await call(frontend, { op: 'inbox' }))).toMatchObject({ count: 0, text: "Yangi xabar yo'q." });
    expect(data<{ count: number }>(await call(frontend, { op: 'inbox', unreadOnly: false })).count).toBe(1);
  });

  it('sir va hajm: matn redakt qilinadi, tema 120 belgiga qisqartiriladi; audit matnsiz', async () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOP';
    const r = await send(backend, 'frontend', { subject: 'S'.repeat(300).slice(0, 120), body: `token=hunter2 va ${secret} ${'x'.repeat(100)}` });
    const id = data<{ messageIds: string[] }>(r).messageIds[0]!;
    const [row]: Array<{ body: string; subject: string }> = await ds.query(`SELECT body, subject FROM session_messages WHERE id = $1`, [id]);
    expect(row!.body).not.toContain('hunter2');
    expect(row!.body).not.toContain('ABCDEFGHIJKLMNOP');
    expect(row!.body).toContain('[REDACTED]');
    const audits: Array<{ details: Record<string, unknown>; action: string }> = await ds.query(`SELECT action, details FROM audit_log WHERE action = 'message.send' ORDER BY id DESC LIMIT 1`);
    expect(audits[0]!.details).toMatchObject({ kind: 'question', recipients: 1, fromRole: 'backend', to: 'role:frontend' });
    expect(JSON.stringify(audits[0]!.details)).not.toContain('hunter2');
    expect(JSON.stringify(audits[0]!.details)).not.toContain('users jadvalida');
    expect(Object.keys(audits[0]!.details)).not.toContain('body');
    await call(frontend, { op: 'inbox' });
  });

  it('broadcast "all": yuboruvchisiz hamma, har biriga alohida qator, bitta batch', async () => {
    const r = data<{ recipients: number; messageIds: string[] }>(await send(backend, 'all', { kind: 'info', subject: 'Deploy', body: 'API v2' }));
    expect(r.recipients).toBe(2);
    const rows: Array<{ batch_id: string }> = await ds.query(`SELECT batch_id FROM session_messages WHERE id = ANY($1::uuid[])`, [r.messageIds]);
    expect(new Set(rows.map((x) => x.batch_id)).size).toBe(1);
    await call(frontend, { op: 'inbox' });
    await call(mobile, { op: 'inbox' });
  });

  it('avto-yo\'naltirish (to=auto), kontekst va rol: egasi roli sessiya o\'rnatgan rolni ustun qiladi', async () => {
    await svc.putRules('workspace:water', [{ kind: 'api_change', toRole: 'mobile' }, { keyword: 'schema', toRole: 'backend' }], owner);
    expect(data<{ target: string }>(await send(frontend, 'auto', { kind: 'api_change', subject: 'x' })).target).toBe('auto:mobile');
    expect(data<{ target: string }>(await send(frontend, 'auto', { kind: 'question', subject: 'Schema masalasi' })).target).toBe('auto:backend');
    expect((await send(frontend, 'auto', { kind: 'info', subject: 'boshqa' })).error?.code).toBe('no_rule_matched');

    await svc.putContext('workspace:water', 'API: /v1\napi_key=abcd1234secret', owner);
    const ctx = data<{ context: string }>(await call(frontend, { op: 'context' }));
    expect(ctx.context).toContain('API: /v1');
    expect(ctx.context).not.toContain('abcd1234secret');

    expect(data<{ role: string }>(await call(mobile, { op: 'set_role', role: 'mobile-dev' })).role).toBe('mobile-dev');
    expect(data<{ peers: Array<{ role: string; roleSource: string; self: boolean }> }>(await call(backend, { op: 'peers' })).peers.find((p) => p.role === 'mobile-dev')?.roleSource).toBe('session');
    await svc.putRole(mobile.sessionId, 'mobile', owner);
    expect((await call(mobile, { op: 'set_role', role: 'x' })).error?.code).toBe('forbidden_role');
    await svc.putRole(mobile.sessionId, null, owner);
    const peers = data<{ peers: Array<{ role: string; roleSource: string; self: boolean }> }>(await call(mobile, { op: 'peers' })).peers;
    expect(peers.find((p) => p.self)).toMatchObject({ role: 'mobile', roleSource: 'guess' });
    await call(backend, { op: 'inbox' });
    await call(mobile, { op: 'inbox' });
  });

  it('tezlik cheklovi: bir sessiya 10 daqiqada eng ko\'pi 20 xabar', async () => {
    const results = [];
    for (let i = 0; i < MESSAGE_LIMITS.sendLimit + 2; i++) results.push(await send(mobile, 'backend', { kind: 'info', subject: `n${i}` }));
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(MESSAGE_LIMITS.sendLimit);
    expect(results.at(-1)!.error?.code).toBe('rate_limited');
    await call(backend, { op: 'inbox' });
  });

  it('egasi (dashboard) yuboradi: fromRole=owner, ramka "foydalanuvchi", audit', async () => {
    while (data<{ count: number }>(await call(backend, { op: 'inbox' })).count > 0) { /* navbatni bo'shatish */ }
    const r = await svc.ownerSend({ key: 'workspace:water', to: 'backend', kind: 'request', subject: 'Iltimos', body: 'status ber' }, { deviceId: null, actorKind: 'web', ip: null });
    expect(r.recipients).toBe(1);
    const d = data<{ text: string }>(await call(backend, { op: 'deliver' }));
    expect(d.text).toContain('foydalanuvchi dashboard orqali');
    await expect(svc.ownerSend({ key: 'no-such-group', to: 'all', kind: 'info', subject: 'a', body: 'b' }, owner)).rejects.toMatchObject({ status: 404 });
  });

  it('kill-switch: guruh va global o\'chirilsa yuborish va yetkazish to\'xtaydi (navbatdagi xabar ham)', async () => {
    await send(backend, 'frontend', { subject: 'kutadi' });
    await svc.patchGroup('workspace:water', { enabled: false }, owner);
    expect((await send(backend, 'frontend')).error?.code).toBe('messaging_disabled');
    expect(data<{ count: number }>(await call(frontend, { op: 'deliver' })).count).toBe(0);
    await expect(svc.ownerSend({ key: 'workspace:water', to: 'all', kind: 'info', subject: 'a', body: 'b' }, owner)).rejects.toMatchObject({ code: 'messaging_disabled' });
    await svc.patchGroup('workspace:water', { enabled: true }, owner);
    await svc.setGlobalEnabled(false, owner);
    expect((await send(backend, 'frontend')).error?.code).toBe('messaging_disabled');
    expect(data<{ count: number }>(await call(frontend, { op: 'deliver' })).count).toBe(0);
    await svc.setGlobalEnabled(true, owner);
    expect(data<{ count: number }>(await call(frontend, { op: 'deliver' })).count).toBe(1); // navbatdagi xabar saqlangan
  });

  it('Stop-hook: auto-wake o\'chiq = bo\'sh; yoqiq = bir martalik blok (ikkinchi chaqiruvda bo\'sh)', async () => {
    await send(backend, 'frontend', { subject: 'stop-test' });
    expect(data<{ text: string | null }>(await call(frontend, { op: 'stop_check' })).text).toBeNull();
    await svc.patchGroup('workspace:water', { autoWake: true }, owner);
    const first = data<{ text: string; count: number }>(await call(frontend, { op: 'stop_check' }));
    expect(first.count).toBe(1);
    expect(first.text).toContain(PEER_FRAME_HEADER);
    expect(data<{ count: number }>(await call(frontend, { op: 'stop_check' })).count).toBe(0);
    expect(data<{ count: number }>(await call(frontend, { op: 'deliver' })).count).toBe(0);
  });
});

describe('uyg\'otish (auto-wake) va retention', () => {
  it('faqat auto-wake + bg + bo\'sh sessiya + kamida bir xabar; qat\'iy matn; tezlik cheklangan', async () => {
    const bg = await seedSession(wakeMachine, wakeDevice, { name: 'water-web', path: '/Users/x/water2', repoKey: 'github.com/acme/wake', kind: 'bg', status: 'idle' });
    const peer = await seedSession(wakeMachine, wakeDevice, { name: 'water-api', path: '/srv/water2', repoKey: 'github.com/acme/wake', kind: 'interactive', status: 'idle' });
    dispatch.register(wakeMachine, { deviceId: wakeDevice, send: () => true });
    await enable('github.com/acme/wake');
    wakeCalls.length = 0;
    await send(peer, 'frontend', { subject: 'ping' });
    await new Promise((r) => setTimeout(r, 300));
    expect(wakeCalls).toHaveLength(0); // auto-wake o'chiq

    await svc.patchGroup('github.com/acme/wake', { autoWake: true }, owner);
    await send(peer, 'frontend', { subject: 'ping 2' });
    await new Promise((r) => setTimeout(r, 300));
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.body).toEqual({ type: 'session.prompt', sessionId: bg.sessionId, text: 'Sizga 2 ta yangi xabar bor: commander_inbox ni o\'qing' });
    expect(wakeCalls[0]!.body.text).not.toContain('ping'); // yuboruvchi matni prompt'ga tushmaydi

    await send(peer, 'frontend', { subject: 'ping 3' });
    await new Promise((r) => setTimeout(r, 300));
    expect(wakeCalls).toHaveLength(1); // 60 s ichida qayta uyg'otilmaydi

    // interaktiv sessiya uyg'otilmaydi (Stop-hook yo'li)
    wakeCalls.length = 0;
    await send(bg, 'backend', { subject: 'javob' });
    await new Promise((r) => setTimeout(r, 300));
    expect(wakeCalls).toHaveLength(0);
  });

  it('30 kundan eski xabarlar o\'chiriladi', async () => {
    await ds.query(`UPDATE session_messages SET created_at = now() - interval '31 days' WHERE id = (SELECT id FROM session_messages ORDER BY created_at LIMIT 1)`);
    const before = (await ds.query(`SELECT count(*)::int AS n FROM session_messages`) as Array<{ n: number }>)[0]!.n;
    const old = (await ds.query(`SELECT count(*)::int AS n FROM session_messages WHERE created_at < now() - interval '30 days'`) as Array<{ n: number }>)[0]!.n;
    expect(old).toBe(1);
    expect(await svc.sweep()).toBe(1);
    expect((await ds.query(`SELECT count(*)::int AS n FROM session_messages`) as Array<{ n: number }>)[0]!.n).toBe(before - 1);
  });

  it('xabarlar ro\'yxati sahifalanadi va WS hodisalari chiqarilgan', async () => {
    const p1 = await svc.listMessages('workspace:water', 3, undefined);
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await svc.listMessages('workspace:water', 3, p1.nextCursor!);
    expect(p2.items[0]!.id).not.toBe(p1.items[0]!.id);
    expect(new Set([...p1.items, ...p2.items].map((m) => m.id)).size).toBe(p1.items.length + p2.items.length);
    expect(events.some((e) => e.type === 'message.changed' && e.created)).toBe(true);
    expect(events.some((e) => e.type === 'message.changed' && !e.created)).toBe(true);
  });
});

let wakeMachine: string;
let wakeDevice: string;
beforeAll(async () => {
  const w = await seedMachine('wakebox');
  wakeMachine = w.id;
  wakeDevice = w.deviceId;
});
