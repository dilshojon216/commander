import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DEFAULT_SUMMARY_SETTINGS } from '@commander/contracts';
import type { MailboxCall, SessionSummaryPayload } from '@commander/contracts';
import { AskService } from '../../src/intelligence/ask.service.js';
import { CommandsService } from '../../src/commands/commands.service.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { DecisionsService } from '../../src/intelligence/decisions.service.js';
import { IntelligenceModule } from '../../src/intelligence/intelligence.module.js';
import { SummariesService } from '../../src/intelligence/summaries.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { MessagingService } from '../../src/messaging/messaging.service.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { createThrowawayDb } from './helpers.js';

/**
 * 6.1-6.3: haqiqiy TimescaleDB. `CommandsService` soxta (haiku agentd'da ishlaydi: bu yerda yaratilgan buyruq tanasi yozib olinadi).
 * Tekshiriladi: qidiruv SQL (tsvector prefiks + ILIKE, filtr, tartib, belgilarni xavfsiz qayta ishlash), xulosa upsert/redakt/kunlik hisob,
 * sozlama qarorlari, takliflar, qarorlar jurnali + bir martalik inyeksiya + fail-safe, savol konteksti (transcript maydonlari yo'q), audit.
 */

let dbh: { url: string; drop: () => Promise<void> };
let ds: DataSource;
let messaging: MessagingService;
let summaries: SummariesService;
let decisions: DecisionsService;
let ask: AskService;
const created: Array<{ type: string; machineId: string; question: string; context: string }> = [];
let askMode: 'done' | 'rejected' = 'done';
const SECRET = 'sk-ant-api03-SUPERSECRETVALUE1234567890abcdef';

interface Seed {
  machineId: string;
  deviceId: string;
  sessionId: string;
  claude: string;
  projectId: string;
}
let counter = 0;
async function seedMachine(name: string): Promise<{ id: string; deviceId: string }> {
  const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug, hostname, os, online, last_seen_at) VALUES ($1, $1, 'darwin', true, now()) RETURNING id`, [name]);
  const mid = (m as { id: string }).id;
  const [d]: Array<{ id: string }> = await ds.query(`INSERT INTO devices (machine_id, kind, public_key, scopes) VALUES ($1, 'agentd', $2, '{}') RETURNING id`, [mid, Buffer.alloc(32, counter++ + 50)]);
  return { id: mid, deviceId: (d as { id: string }).id };
}
async function seedSession(machineId: string, deviceId: string, o: { name: string; path: string; repoKey: string | null }): Promise<Seed> {
  const [p]: Array<{ id: string }> = await ds.query(`INSERT INTO projects (machine_id, path, name, repo_key) VALUES ($1, $2, $3, $4) RETURNING id`, [machineId, o.path, o.name, o.repoKey]);
  const projectId = (p as { id: string }).id;
  const claude = `${(++counter).toString(16).padStart(8, '0')}-bbbb-4000-8000-${randomUUID().slice(-12)}`;
  const [s]: Array<{ id: string }> = await ds.query(
    `INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, kind, status, started_at, status_since, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, 'interactive', 'idle', now(), now(), now()) RETURNING id`,
    [machineId, claude, projectId, o.path, o.name],
  );
  return { machineId, deviceId, sessionId: (s as { id: string }).id, claude, projectId };
}
const call = (s: Seed, c: MailboxCall) => messaging.handleMailbox(s.machineId, s.deviceId, { reqId: randomUUID(), claudeSessionId: s.claude, call: c });
const data = <T>(r: { ok: boolean; data?: unknown; error?: { code: string } }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error?.code}`);
  return r.data as T;
};
const payload = (over: Partial<SessionSummaryPayload> = {}): SessionSummaryPayload => ({
  summary: 'Login xatosi tuzatildi, sessiya cookie muddati uzaytirildi.',
  done: ['auth.service.ts tuzatildi', 'test qo\'shildi'],
  files: ['src/auth/auth.service.ts'],
  openItems: ['refresh token'],
  decisions: [],
  model: 'claude-haiku-5',
  tokensUsed: 1000,
  promptCount: 3,
  sourceTokens: 50_000,
  trigger: 'ended',
  ...over,
});

let a: Seed;
let b: Seed;
let c: Seed;
let mac: { id: string; deviceId: string };
const owner = { deviceId: null, actorKind: 'web' as const, ip: null };

beforeAll(async () => {
  dbh = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(dbh.url, true)),
      CoreModule,
      IdentityModule,
      IntelligenceModule,
    ],
  })
    .overrideProvider(CommandsService)
    .useValue({
      create: async (body: { type: string; machineId: string; question: string; context: string }) => {
        created.push(body);
        return { command: { id: randomUUID(), status: askMode === 'done' ? 'sent' : 'rejected', errorCode: askMode === 'done' ? null : 'machine_offline' }, idempotent: false };
      },
      waitFinished: async (id: string) => ({ command: { id, status: 'done' }, timedOut: false }),
      takeAssistant: () => ({ answer: 'Login tuzatildi (3-sessiya).', sources: ['S1', 'S77'], model: 'claude-haiku-5' }),
    })
    .compile();
  await moduleRef.init();
  ds = moduleRef.get(DataSource);
  messaging = moduleRef.get(MessagingService);
  summaries = moduleRef.get(SummariesService);
  decisions = moduleRef.get(DecisionsService);
  ask = moduleRef.get(AskService);

  mac = await seedMachine('mac');
  const srv = await seedMachine('srv');
  a = await seedSession(mac.id, mac.deviceId, { name: 'water-web', path: '/Users/x/water', repoKey: 'github.com/acme/water' });
  b = await seedSession(srv.id, srv.deviceId, { name: 'water-api', path: '/srv/water', repoKey: 'github.com/acme/water' });
  c = await seedSession(mac.id, mac.deviceId, { name: 'notes', path: '/Users/x/notes', repoKey: 'github.com/acme/notes' });
});

afterAll(async () => {
  await ds?.destroy();
  await dbh?.drop();
});

describe('migratsiya', () => {
  it('jadvallar, GIN indekslar va commands.type CHECK (assistant.ask) mavjud', async () => {
    const t: Array<{ table_name: string }> = await ds.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('session_summaries','summary_runs','project_decisions','decision_injections','assistant_queries')`);
    expect(t).toHaveLength(5);
    const idx: Array<{ indexname: string }> = await ds.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'session_summaries'`);
    expect(idx.map((i) => i.indexname)).toContain('idx_session_summaries_search');
    const [chk]: Array<{ def: string }> = await ds.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname = 'chk_commands_type'`);
    expect(chk!.def).toContain('assistant.ask');
  });
});

describe('xulosa: tekshiruv, saqlash, sozlama', () => {
  it('summary_check: sukutda ruxsat, minimal chegaralar bilan; noma\'lum sessiya rad', async () => {
    expect(data(await call(a, { op: 'summary_check' }))).toEqual({ allow: true, minPrompts: 2, minTokens: 20_000 });
    const ghost = { ...a, claude: 'yoq-sessiya' };
    expect(data(await call(ghost, { op: 'summary_check' }))).toMatchObject({ allow: false, reason: 'unknown_session' });
  });

  it('session_summary: saqlanadi, matn markazda yana redakt qilinadi, audit matnsiz, kunlik hisob', async () => {
    const r = data<{ stored: boolean }>(await call(a, { op: 'session_summary', summary: payload({ summary: `Login xatosi tuzatildi. Kalit ${SECRET} topildi.` }) }));
    expect(r.stored).toBe(true);
    const [row] = await ds.query(`SELECT summary, search_text, tokens_used FROM session_summaries WHERE session_id = $1`, [a.sessionId]);
    expect(row.summary).not.toContain('SUPERSECRETVALUE');
    expect(row.search_text).not.toContain('SUPERSECRETVALUE');
    const audit: Array<{ details: Record<string, unknown> }> = await ds.query(`SELECT details FROM audit_log WHERE action = 'summary.stored'`);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.details)).not.toContain('Login');
    expect(await summaries.usedToday()).toBe(1);
  });

  it('qayta yuborish bir qatorni yangilaydi (token jamlanadi), xulosa soni emas, kunlik run oshadi', async () => {
    await call(a, { op: 'session_summary', summary: payload({ tokensUsed: 500, trigger: 'idle' }) });
    const rows: Array<{ tokens_used: number; trigger: string }> = await ds.query(`SELECT tokens_used, trigger FROM session_summaries WHERE session_id = $1`, [a.sessionId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toBe('idle');
    expect(Number(rows[0]!.tokens_used)).toBe(1000 + 500);
    expect(await summaries.usedToday()).toBe(2);
  });

  it('sozlama: mashina/loyiha/global o\'chirish va kunlik chegara check\'da hisobga olinadi; yozuv audit qilinadi', async () => {
    await summaries.putSettings({ ...DEFAULT_SUMMARY_SETTINGS, disabledMachineIds: [mac.id] }, owner);
    expect(data(await call(a, { op: 'summary_check' }))).toMatchObject({ allow: false, reason: 'machine_disabled' });
    expect(data<{ stored: boolean }>(await call(a, { op: 'session_summary', summary: payload() })).stored).toBe(false);
    await summaries.putSettings({ ...DEFAULT_SUMMARY_SETTINGS, disabledProjectIds: [b.projectId] }, owner);
    expect(data(await call(b, { op: 'summary_check' }))).toMatchObject({ allow: false, reason: 'project_disabled' });
    expect(data(await call(a, { op: 'summary_check' }))).toMatchObject({ allow: true });
    await summaries.putSettings({ ...DEFAULT_SUMMARY_SETTINGS, enabled: false }, owner);
    expect(data(await call(a, { op: 'summary_check' }))).toMatchObject({ allow: false, reason: 'disabled' });
    await summaries.putSettings({ ...DEFAULT_SUMMARY_SETTINGS, dailyCap: 2 }, owner);
    expect(data(await call(a, { op: 'summary_check' }))).toMatchObject({ allow: false, reason: 'daily_cap' });
    await summaries.putSettings(DEFAULT_SUMMARY_SETTINGS, owner);
    expect((await summaries.settingsView()).usedToday).toBe(2);
    const n: Array<{ n: string }> = await ds.query(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'summary.settings'`);
    expect(Number(n[0]!.n)).toBe(5);
  });
});

describe('qidiruv SQL', () => {
  beforeAll(async () => {
    await call(b, { op: 'session_summary', summary: payload({ summary: 'Redis kesh qatlami qo\'shildi, TTL sozlandi.', done: ['cache.module.ts'], files: ['src/cache/cache.module.ts'], openItems: [], trigger: 'ended' }) });
    await call(c, { op: 'session_summary', summary: payload({ summary: 'Eslatmalar eksporti yozildi.', done: [], files: [], openItems: [], tokensUsed: 10 }) });
  });

  it('prefiks (tsvector) mos keladi, headline «» bilan belgilanadi, natija DTO sxemasiga mos', async () => {
    const r = await summaries.search({ q: 'logi', limit: 10 });
    expect(r).toHaveLength(1);
    expect(r[0]!.sessionId).toBe(a.sessionId);
    expect(r[0]!.headline).toContain('«Login»');
    expect(r[0]!.machineName).toBe('mac');
    expect(r[0]!.projectName).toBe('water-web');
  });

  it('bir nechta so\'z AND; fayl yo\'li bo\'lagi ILIKE bilan topiladi; done/open_items ham qidiriladi', async () => {
    expect((await summaries.search({ q: 'login cookie', limit: 10 })).map((x) => x.sessionId)).toEqual([a.sessionId]);
    expect((await summaries.search({ q: 'login redis', limit: 10 }))).toHaveLength(0);
    expect((await summaries.search({ q: 'cache.module', limit: 10 })).map((x) => x.sessionId)).toEqual([b.sessionId]);
    expect((await summaries.search({ q: 'refresh', limit: 10 })).map((x) => x.sessionId)).toEqual([a.sessionId]);
  });

  it('loyiha va mashina filtri; limit', async () => {
    expect(await summaries.search({ q: 'eksporti', project: c.projectId, limit: 10 })).toHaveLength(1);
    expect(await summaries.search({ q: 'eksporti', project: a.projectId, limit: 10 })).toHaveLength(0);
    expect(await summaries.search({ q: 'qo\'shildi', machine: b.machineId, limit: 10 })).toHaveLength(1);
    expect((await summaries.search({ q: 'a', limit: 1 })).length).toBeLessThanOrEqual(1);
  });

  it('maxsus belgilar (tsquery/LIKE sintaksisi, SQL) xato bermaydi va ma\'lumotni buzmaydi', async () => {
    for (const q of ["'; DROP TABLE session_summaries; --", 'a & | ! <-> (b', '%_\\', "o'zbek", ':*', '\u0001']) {
      await expect(summaries.search({ q, limit: 5 })).resolves.toBeDefined();
    }
    expect(await ds.query(`SELECT 1 FROM session_summaries`)).not.toHaveLength(0);
  });

  it('forSession va ask rejimi (OR) ishlaydi', async () => {
    expect((await summaries.forSession(a.sessionId))?.taskKey).toBeNull();
    expect(await summaries.forSession(randomUUID())).toBeNull();
    const any = await summaries.search({ q: 'qaysi sessiyada redis kesh qilgan edim', limit: 5 }, { any: true });
    expect(any.map((x) => x.sessionId)).toContain(b.sessionId);
  });
});

describe('taklif (xulosadan qaror)', () => {
  it('xulosa qaror taklif qiladi (proposed), takror taklif tashlanadi, taklif kontekstga TUSHMAYDI', async () => {
    const d = { title: 'Auth: cookie sessiya', decision: 'JWT o\'rniga cookie', reason: 'oddiyroq' };
    expect(data<{ proposals: number }>(await call(a, { op: 'session_summary', summary: payload({ decisions: [d] }) })).proposals).toBe(1);
    expect(data<{ proposals: number }>(await call(a, { op: 'session_summary', summary: payload({ decisions: [d] }) })).proposals).toBe(0);
    const list = await decisions.list(a.projectId);
    expect(list.map((x) => [x.title, x.status, x.source])).toEqual([['Auth: cookie sessiya', 'proposed', 'summary']]);
    // bir repo = boshqa mashinadagi loyiha ham shu jurnalni ko'radi
    expect(await decisions.list(b.projectId)).toHaveLength(1);
    const fresh = await seedSession(mac.id, mac.deviceId, { name: 'water-web3', path: '/Users/x/water3', repoKey: 'github.com/acme/water' });
    expect(await decisions.injectionFor(fresh.machineId, fresh.claude)).toBeNull();
  });
});

describe('qarorlar jurnali (6.3)', () => {
  it('record_decision: faol qaror yoziladi (redakt), audit matnsiz; shu sarlavha qayta yozilsa yangilanadi', async () => {
    const r = data<{ text: string }>(await call(b, { op: 'record_decision', title: 'Kesh: Redis', decision: `Redis ishlatamiz, parol ${SECRET}`, reason: 'tezlik', alternatives: ['memcached'] }));
    expect(r.text).toContain('jurnalga yozildi');
    const rows = await decisions.list(b.projectId, 'active');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'session', alternatives: ['memcached'] });
    expect(rows[0]!.decision).not.toContain('SUPERSECRETVALUE');
    const again = data<{ text: string }>(await call(b, { op: 'record_decision', title: 'kesh  redis', decision: 'Redis 7', reason: 'barqaror' }));
    expect(again.text).toContain('yangilandi');
    expect(await decisions.list(b.projectId, 'active')).toHaveLength(1);
    const audit: Array<{ details: Record<string, unknown> }> = await ds.query(`SELECT details FROM audit_log WHERE action = 'decision.recorded'`);
    expect(JSON.stringify(audit)).not.toContain('Redis');
  });

  it('rate limit: bir sessiya soatiga 20 ta', async () => {
    let last = '';
    for (let i = 0; i < 22; i++) {
      const r = await call(c, { op: 'record_decision', title: `Q${i}`, decision: 'd', reason: 'r' });
      if (!r.ok) last = r.error!.code;
    }
    expect(last).toBe('rate_limited');
  });

  it('REST: egasi yaratadi / tahrirlaydi / taklifni qabul qiladi va arxivlaydi (audit bilan)', async () => {
    const created1 = await decisions.create(a.projectId, { title: 'Til: TypeScript', decision: 'strict', reason: 'xavfsizlik', alternatives: [] }, owner);
    expect(created1).toMatchObject({ status: 'active', source: 'owner' });
    const patched = await decisions.patch(created1.id, { reason: 'tur xavfsizligi' }, owner);
    expect(patched.reason).toBe('tur xavfsizligi');
    const proposal = (await decisions.list(a.projectId, 'proposed'))[0]!;
    expect((await decisions.patch(proposal.id, { status: 'active' }, owner)).status).toBe('active');
    expect((await decisions.patch(proposal.id, { status: 'archived' }, owner)).status).toBe('archived');
    await expect(decisions.patch(randomUUID(), { title: 'x' }, owner)).rejects.toThrow(/not found/i);
    await expect(decisions.list(randomUUID())).rejects.toThrow(/not found/i);
    const n: Array<{ n: string }> = await ds.query(`SELECT count(*)::text AS n FROM audit_log WHERE action IN ('decision.created','decision.updated')`);
    expect(Number(n[0]!.n)).toBe(4);
  });

  it('inyeksiya: birinchi deliver\'da ramkali blok (faqat faol), ikkinchisida YO\'Q; boshqa repo ko\'rmaydi', async () => {
    const first = data<{ text: string; count: number }>(await call(b, { op: 'deliver' }));
    expect(first.count).toBe(1);
    expect(first.text).toContain('foydalanuvchi buyrug');
    expect(first.text).toContain('Kesh: Redis');
    expect(first.text).toContain('Til: TypeScript'); // bir repo, boshqa mashinadagi loyihadan qo'shilgan
    expect(first.text).not.toContain('Auth: cookie'); // arxivlangan taklif
    expect(data<{ text: string | null }>(await call(b, { op: 'deliver' })).text).toBeNull();
    // boshqa sessiya (boshqa mashina, bir repo) o'zining birinchi promptida oladi
    expect(data<{ text: string | null }>(await call(a, { op: 'deliver' })).text).toContain('Kesh: Redis');
    // boshqa repo
    expect(data<{ text: string | null }>(await call(c, { op: 'deliver' })).text).toContain('Q0');
    expect(data<{ text: string | null }>(await call(c, { op: 'deliver' })).text).toBeNull();
  });

  it('FAIL-SAFE: inyeksiya jadvali buzilsa deliver xato bermaydi (null), sessiya buzilmaydi', async () => {
    const d = await seedSession(mac.id, mac.deviceId, { name: 'water-web2', path: '/Users/x/water2', repoKey: 'github.com/acme/water' });
    await ds.query(`ALTER TABLE decision_injections RENAME TO decision_injections_x`);
    try {
      const r = await call(d, { op: 'deliver' });
      expect(r.ok).toBe(true);
      expect((r.data as { text: string | null }).text).toBeNull();
      expect(await decisions.injectionFor(d.machineId, d.claude)).toBeNull();
    } finally {
      await ds.query(`ALTER TABLE decision_injections_x RENAME TO decision_injections`);
    }
    // jadval tiklangach shu sessiya bloklarini oladi (belgi qo'yilmagan edi)
    expect(data<{ text: string | null }>(await call(d, { op: 'deliver' })).text).toContain('Kesh: Redis');
  });
});

describe('Commander\'dan savol (6.2)', () => {
  it('kontekst tuzilgan ma\'lumotdan, transcript maydonlarisiz; savol redakt+xesh bilan audit; manbalar katalogdan', async () => {
    await ds.query(`UPDATE machines SET control = $1::jsonb WHERE id = $2`, [JSON.stringify({ enabled: true, centerKeyPinned: true, runningAsRoot: false, assistant: true, allowProjectRead: true }), mac.id]);
    const res = await ask.ask(`qaysi sessiyada login tuzatdim? kalit ${SECRET}`, { deviceId: mac.deviceId, actorKind: 'web', ip: null }, 'dashboard');
    expect(res.answer).toContain('Login tuzatildi');
    expect(res.sources.length).toBeGreaterThan(0);
    expect(res.sources.length).toBeLessThanOrEqual(1); // S77 katalogda yo'q: tashlandi
    const sent = created[created.length - 1]!;
    expect(sent.type).toBe('assistant.ask');
    expect(sent.machineId).toBe(mac.id);
    expect(sent.context).toContain('Login xatosi tuzatildi');
    expect(sent.context).toContain('MASHINALAR');
    expect(sent.context).not.toContain('SUPERSECRETVALUE');
    const [q] = await ds.query(`SELECT question_redacted, question_sha256, question_chars, status, answer_chars FROM assistant_queries WHERE id = $1`, [res.queryId]);
    expect(q.question_redacted).not.toContain('SUPERSECRETVALUE');
    expect(q.question_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(q.status).toBe('done');
    expect(q.answer_chars).toBe(res.answer.length);
    expect((await ask.history(5))[0]).toMatchObject({ id: res.queryId, status: 'done' });
  });

  it('tayyor mashina yo\'q -> 409 assistant_unavailable; buyruq rad etilsa failed yoziladi', async () => {
    askMode = 'rejected';
    await expect(ask.ask('savol bor', { deviceId: mac.deviceId, actorKind: 'web', ip: null }, 'dashboard')).rejects.toMatchObject({ status: 409 });
    const [row] = await ds.query(`SELECT status, error_code FROM assistant_queries ORDER BY created_at DESC LIMIT 1`);
    expect(row).toMatchObject({ status: 'failed', error_code: 'assistant_unavailable' });
    askMode = 'done';
    await ds.query(`UPDATE machines SET control = NULL`);
    await expect(ask.ask('savol ikki', { deviceId: mac.deviceId, actorKind: 'web', ip: null }, 'dashboard')).rejects.toMatchObject({ status: 409 });
    await ds.query(`UPDATE machines SET control = $1::jsonb WHERE id = $2`, [JSON.stringify({ enabled: true, centerKeyPinned: true, runningAsRoot: false, assistant: true }), mac.id]);
  });

  it('tezlik chegarasi: qurilma bo\'yicha daqiqada 6 ta (429 + retryAfterSeconds); eski yozuvlar 30 kunda o\'chadi', async () => {
    const dev = { deviceId: b.deviceId, actorKind: 'telegram' as const, ip: null };
    type Blocked = { status?: number; response?: { retryAfterSeconds?: number } };
    const box: { blocked: Blocked | null } = { blocked: null };
    for (let i = 0; i < 8; i++) {
      try {
        await ask.ask('chegara sinovi', dev, 'telegram');
      } catch (e) {
        box.blocked = e as Blocked;
        break;
      }
    }
    expect(box.blocked?.status).toBe(429);
    expect(box.blocked?.response?.retryAfterSeconds).toBeGreaterThan(0);
    await ds.query(`INSERT INTO assistant_queries (actor_kind, channel, question_redacted, question_sha256, question_chars, created_at) VALUES ('web', 'dashboard', 'eski', 'x', 4, now() - interval '31 days')`);
    await ask.prune();
    expect(await ds.query(`SELECT 1 FROM assistant_queries WHERE question_redacted = 'eski'`)).toHaveLength(0);
  });
});
