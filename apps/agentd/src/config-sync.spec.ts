import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigApplyPayload, ConfigChunkPayload, ConfigPlanResult, ConfigResult, SettingsFragment } from '@commander/contracts';
import { encodeBundle } from './config-bundle.js';
import { resolveManaged, sha256Hex } from './config-fs.js';
import { ConfigSync } from './config-sync.js';
import { settingsSha256 } from './config-settings.js';
import type { Logger } from './logger.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } } as unknown as Logger;

interface Env {
  src: ConfigSync;
  dst: ConfigSync;
  srcDir: string;
  dstDir: string;
  dstHome: string;
  cleanup: () => void;
  pipe: ConfigChunkPayload[];
}

function mk(): Env {
  const base = mkdtempSync(path.join(tmpdir(), 'cfgsync-'));
  const srcDir = path.join(base, 'src-claude');
  const dstDir = path.join(base, 'dst-claude');
  const dstHome = path.join(base, 'dst-home');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(dstDir, { recursive: true });
  mkdirSync(dstHome, { recursive: true });
  const pipe: ConfigChunkPayload[] = [];
  let t = 1_700_000_000_000;
  const now = (): number => (t += 10);
  const dst = new ConfigSync({ claudeDir: dstDir, home: dstHome, log, now, sendChunk: () => true, chunkWaitMs: 200 });
  const src = new ConfigSync({
    claudeDir: srcDir,
    home: path.join(base, 'src-home'),
    log,
    now,
    sendChunk: (c) => {
      pipe.push(c);
      dst.onChunk(c); // capture bo'laklari "markaz"ga (bu testda dst'ga) boradi
      return true;
    },
  });
  return { src, dst, srcDir, dstDir, dstHome, pipe, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const w = (dir: string, rel: string, content: string): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
};

async function captureToApply(e: Env, over: Partial<ConfigApplyPayload> = {}, includeSettings = true): Promise<{ payload: ConfigApplyPayload; cap: Extract<ConfigResult, { kind: 'capture' }> }> {
  const out = await e.src.capture({ includeSettings });
  expect(out.ok).toBe(true);
  const cap = out.result!.config as Extract<ConfigResult, { kind: 'capture' }>;
  const payload: ConfigApplyPayload = { profileName: 'default', profileVersion: 1, mode: 'merge', dryRun: true, items: cap.items, settingsSha256: cap.settingsSha256, bundle: cap.bundle, ...over };
  return { payload, cap };
}

/** Har buyruq uchun markaz bo'laklarni qayta yuboradi (haqiqiy oqimdagidek). */
const ap = (p: ConfigApplyPayload) => {
  for (const c of e.pipe) if (p.bundle && c.transferId === p.bundle.sha256) e.dst.onChunk(c);
  return e.dst.apply(p);
};

let e: Env;
beforeEach(() => {
  e = mk();
});
afterEach(() => e.cleanup());

describe('capture', () => {
  it('faqat ruxsat ro\'yxatidagi fayllarni oladi, sirli va katta fayllarni rad etadi', async () => {
    w(e.srcDir, 'CLAUDE.md', '# salom\n');
    w(e.srcDir, 'agents/a.md', 'agent');
    w(e.srcDir, 'commands/c.md', 'cmd');
    w(e.srcDir, 'skills/s1/SKILL.md', 'skill');
    w(e.srcDir, 'skills/s1/img.png', 'PNGDATA');
    w(e.srcDir, 'skills/s1/ref/notes.txt', 'notes');
    w(e.srcDir, 'agents/secret.md', 'token = sk-ant-abcdefghijklmnop1234');
    w(e.srcDir, 'agents/big.md', 'x'.repeat(300 * 1024));
    w(e.srcDir, 'agents/bin.md', 'a\u0000b');
    w(e.srcDir, 'history.jsonl', 'private');
    w(e.srcDir, 'projects/p/x.md', 'private');
    w(e.srcDir, '.credentials.json', '{"t":1}');
    const { cap } = await captureToApply(e);
    expect(cap.items.map((i) => i.path)).toEqual(['CLAUDE.md', 'agents/a.md', 'commands/c.md', 'skills/s1/SKILL.md', 'skills/s1/ref/notes.txt']);
    const reasons = Object.fromEntries(cap.skipped.map((s) => [s.path, s.reason]));
    expect(reasons['agents/secret.md']).toMatch(/secret/);
    expect(reasons['agents/big.md']).toMatch(/too large/);
    expect(reasons['agents/bin.md']).toMatch(/binary/);
    expect(reasons['skills/s1/img.png']).toBeDefined();
    expect(JSON.stringify(cap)).not.toContain('sk-ant');
    expect(cap.items.every((i) => i.sha256 === sha256Hex(readFileSync(path.join(e.srcDir, i.path))))).toBe(true);
  });

  it('symlink fayl va papkalarni kuzatmaydi', async () => {
    const outside = path.join(e.srcDir, '..', 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'x.md'), 'tashqarida');
    mkdirSync(path.join(e.srcDir, 'skills'), { recursive: true });
    symlinkSync(outside, path.join(e.srcDir, 'skills/linked'));
    symlinkSync(path.join(outside, 'x.md'), path.join(e.srcDir, 'CLAUDE.md'));
    const { cap } = await captureToApply(e);
    expect(cap.items).toHaveLength(0);
    expect(cap.skipped.map((s) => s.path).sort()).toEqual(['CLAUDE.md', 'skills/linked']);
  });

  it('settings bo\'lagi: sirli env va keng allow tashlanadi, hooks kirmaydi', async () => {
    w(
      e.srcDir,
      'settings.json',
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node cc-hook.mjs' }] }] },
        env: { FOO_MODE: 'fast', MY_API_KEY: 'zzz', OTEL_X: '1', COMMANDER_URL: 'u', NOTE: 'sk-ant-abcdefghijklmnop1234' },
        permissions: { allow: ['Bash(npm test:*)', 'Bash(*)', 'Read'], deny: ['Bash(rm -rf:*)'], defaultMode: 'bypassPermissions' },
      }),
    );
    const out = await e.src.capture({ includeSettings: true });
    const cap = out.result!.config as Extract<ConfigResult, { kind: 'capture' }>;
    expect(cap.settingsSha256).not.toBeNull();
    const reasons = cap.skipped.filter((s) => s.path === 'settings.json').map((s) => s.reason);
    expect(reasons.some((r) => r.startsWith('env.MY_API_KEY'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('env.OTEL_X'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('env.COMMANDER_URL'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('env.NOTE'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('permissions.allow[1]'))).toBe(true);
    // Apply tomonda bo'lakni ko'ramiz
    const { payload } = await captureToApply(e);
    const plan = (await ap(payload)).result!.config as ConfigPlanResult;
    expect(plan.settings!.allowAdd).toEqual(['Bash(npm test:*)', 'Read']);
    expect(plan.settings!.envSet).toEqual(['FOO_MODE=fast']);
  });
});

describe('apply: dry-run, yozish, zaxira, qaytarish', () => {
  it('dry-run hech narsa yozmaydi va unified diff beradi', async () => {
    w(e.srcDir, 'CLAUDE.md', 'yangi\nsatr\n');
    w(e.srcDir, 'agents/a.md', 'A');
    w(e.dstDir, 'CLAUDE.md', 'eski\nsatr\n');
    const { payload } = await captureToApply(e);
    const out = await ap(payload);
    const plan = out.result!.config as ConfigPlanResult;
    expect(plan.summary).toMatchObject({ add: 1, update: 1, delete: 0 });
    const upd = plan.entries.find((x) => x.path === 'CLAUDE.md')!;
    expect(upd.diff).toContain('-eski');
    expect(upd.diff).toContain('+yangi');
    expect(readFileSync(path.join(e.dstDir, 'CLAUDE.md'), 'utf8')).toBe('eski\nsatr\n');
    expect(existsSync(path.join(e.dstDir, 'agents/a.md'))).toBe(false);
    expect(existsSync(path.join(e.dstHome, 'backups'))).toBe(false);
  });

  it('lokal fayl sirli bo\'lsa diff yashiriladi', async () => {
    w(e.srcDir, 'CLAUDE.md', 'yangi\n');
    w(e.dstDir, 'CLAUDE.md', 'API_KEY=supersecretvalue123\n');
    const { payload } = await captureToApply(e);
    const plan = (await ap(payload)).result!.config as ConfigPlanResult;
    const upd = plan.entries.find((x) => x.path === 'CLAUDE.md')!;
    expect(upd.diff).toBeUndefined();
    expect(upd.reason).toMatch(/secret/);
    expect(JSON.stringify(plan)).not.toContain('supersecretvalue123');
  });

  it('haqiqiy qo\'llash: expectedPlanHash shart, mos kelmasa config_plan_changed', async () => {
    w(e.srcDir, 'CLAUDE.md', 'yangi\n');
    const { payload } = await captureToApply(e);
    const missing = await ap({ ...payload, dryRun: false });
    expect(missing).toMatchObject({ ok: false, code: 'invalid_payload' });
    const plan = (await ap(payload)).result!.config as ConfigPlanResult;
    // Lokal fayl dry-run'dan keyin o'zgardi
    w(e.dstDir, 'CLAUDE.md', 'boshqa\n');
    const out = await ap({ ...payload, dryRun: false, expectedPlanHash: plan.planHash });
    expect(out).toMatchObject({ ok: false, code: 'config_plan_changed' });
    expect(readFileSync(path.join(e.dstDir, 'CLAUDE.md'), 'utf8')).toBe('boshqa\n');
  });

  it('qo\'llash + zaxira + rollback aylanma yo\'li', async () => {
    w(e.srcDir, 'CLAUDE.md', 'yangi\n');
    w(e.srcDir, 'skills/s/SKILL.md', 'skill');
    w(e.dstDir, 'CLAUDE.md', 'eski\n');
    w(e.dstDir, 'settings.json', JSON.stringify({ hooks: { Stop: [{ x: 1 }] }, permissions: { allow: ['Read'], defaultMode: 'plan' } }, null, 2));
    w(e.srcDir, 'settings.json', JSON.stringify({ permissions: { allow: ['Bash(git status:*)'] }, env: { FOO_MODE: 'on' } }));
    const { payload } = await captureToApply(e);
    const plan = (await ap(payload)).result!.config as ConfigPlanResult;
    const before = readFileSync(path.join(e.dstDir, 'settings.json'), 'utf8');
    const out = await ap({ ...payload, dryRun: false, expectedPlanHash: plan.planHash });
    expect(out.ok).toBe(true);
    const res = out.result!.config as Extract<ConfigResult, { kind: 'apply' }>;
    expect(res.applied).toEqual({ add: 1, update: 1, delete: 0 });
    expect(res.backupId).toMatch(/^config-\d{13}$/);
    expect(readFileSync(path.join(e.dstDir, 'CLAUDE.md'), 'utf8')).toBe('yangi\n');
    const s = JSON.parse(readFileSync(path.join(e.dstDir, 'settings.json'), 'utf8'));
    expect(s.hooks).toEqual({ Stop: [{ x: 1 }] });
    expect(s.permissions).toEqual({ allow: ['Read', 'Bash(git status:*)'], defaultMode: 'plan' });
    expect(s.env).toEqual({ FOO_MODE: 'on' });
    expect(readdirSync(path.join(e.dstHome, 'backups', res.backupId!))).toContain('backup.json');
    // vaqtinchalik fayllar qolmagan
    expect(readdirSync(e.dstDir).filter((n) => n.includes('.tmp'))).toEqual([]);

    // drift hisoboti: sinxron
    const rep = e.dst.report();
    expect(rep.applied).toMatchObject({ profileName: 'default', profileVersion: 1, mode: 'merge' });
    expect(rep.files.every((f) => f.sha256 !== null)).toBe(true);
    expect(rep.settings!.intact).toBe(true);
    expect(rep.backups[0]!.id).toBe(res.backupId);

    const rb = await e.dst.rollback({ backupId: res.backupId! });
    expect(rb.ok).toBe(true);
    expect(readFileSync(path.join(e.dstDir, 'CLAUDE.md'), 'utf8')).toBe('eski\n');
    expect(existsSync(path.join(e.dstDir, 'skills/s/SKILL.md'))).toBe(false);
    expect(existsSync(path.join(e.dstDir, 'skills/s'))).toBe(false);
    expect(readFileSync(path.join(e.dstDir, 'settings.json'), 'utf8')).toBe(before);
    expect(e.dst.report().applied).toBeNull();
    // ikkinchi marta qaytarib bo'lmaydi
    expect(await e.dst.rollback({ backupId: res.backupId! })).toMatchObject({ ok: false, code: 'config_backup_not_found' });
  });

  it('rollback: qo\'llashdan keyin o\'zgargan fayl ustiga yozmaydi (conflict)', async () => {
    w(e.srcDir, 'CLAUDE.md', 'yangi\n');
    w(e.dstDir, 'CLAUDE.md', 'eski\n');
    const { payload } = await captureToApply(e);
    const plan = (await ap(payload)).result!.config as ConfigPlanResult;
    const res = (await ap({ ...payload, dryRun: false, expectedPlanHash: plan.planHash })).result!.config as Extract<ConfigResult, { kind: 'apply' }>;
    w(e.dstDir, 'CLAUDE.md', 'foydalanuvchi yana o\'zgartirdi\n');
    const rb = (await e.dst.rollback({ backupId: res.backupId! })).result!.config as Extract<ConfigResult, { kind: 'rollback' }>;
    expect(rb.restored).toBe(0);
    expect(rb.skipped[0]!.reason).toMatch(/modified/);
    expect(readFileSync(path.join(e.dstDir, 'CLAUDE.md'), 'utf8')).toBe("foydalanuvchi yana o'zgartirdi\n");
  });

  it('yozish xatosida avtomatik tiklanadi', async () => {
    w(e.srcDir, 'CLAUDE.md', 'yangi\n');
    w(e.srcDir, 'skills/s/SKILL.md', 'skill');
    w(e.dstDir, 'CLAUDE.md', 'eski\n');
    // skills papkasi o'rniga oddiy fayl: ikkinchi yozuv muvaffaqiyatsiz
    writeFileSync(path.join(e.dstDir, 'skills'), 'fayl');
    const { payload } = await captureToApply(e);
    const plan = (await ap(payload)).result!.config as ConfigPlanResult;
    expect(plan.entries.find((x) => x.path === 'skills/s/SKILL.md')!.action).toBe('skip');
  });

  it('symlink orqali yozmaydi', async () => {
    const outside = path.join(e.dstDir, '..', 'outside');
    mkdirSync(outside, { recursive: true });
    w(e.srcDir, 'skills/s/SKILL.md', 'skill');
    mkdirSync(path.join(e.dstDir, 'skills'), { recursive: true });
    symlinkSync(outside, path.join(e.dstDir, 'skills/s'));
    const { payload } = await captureToApply(e);
    const plan = (await ap(payload)).result!.config as ConfigPlanResult;
    expect(plan.entries[0]!.action).toBe('skip');
    const out = await ap({ ...payload, dryRun: false, expectedPlanHash: plan.planHash });
    expect(out.ok).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('mirror: faqat Commander joylashtirgan fayllar', () => {
  it('manifestdagi o\'zgarmagan faylni o\'chiradi, foydalanuvchi va o\'zgartirilgan fayllarga tegmaydi', async () => {
    w(e.srcDir, 'agents/keep.md', 'K');
    w(e.srcDir, 'agents/gone.md', 'G');
    w(e.srcDir, 'agents/gone-edited.md', 'GE');
    const first = await captureToApply(e, { mode: 'merge' });
    const p1 = (await ap(first.payload)).result!.config as ConfigPlanResult;
    expect((await ap({ ...first.payload, dryRun: false, expectedPlanHash: p1.planHash })).ok).toBe(true);
    w(e.dstDir, 'agents/user-own.md', 'mening faylim');
    w(e.dstDir, 'agents/gone-edited.md', 'lokal tahrir');

    rmSync(path.join(e.srcDir, 'agents/gone.md'));
    rmSync(path.join(e.srcDir, 'agents/gone-edited.md'));
    const second = await captureToApply(e, { mode: 'mirror', profileVersion: 2 });
    const plan = (await ap(second.payload)).result!.config as ConfigPlanResult;
    const act = Object.fromEntries(plan.entries.map((x) => [x.path, x.action]));
    expect(act).toEqual({ 'agents/gone.md': 'delete', 'agents/gone-edited.md': 'skip', 'agents/keep.md': 'unchanged' });
    expect(plan.entries.some((x) => x.path === 'agents/user-own.md')).toBe(false);
    const out = await ap({ ...second.payload, dryRun: false, expectedPlanHash: plan.planHash });
    expect(out.ok).toBe(true);
    expect(existsSync(path.join(e.dstDir, 'agents/gone.md'))).toBe(false);
    expect(existsSync(path.join(e.dstDir, 'agents/user-own.md'))).toBe(true);
    expect(readFileSync(path.join(e.dstDir, 'agents/gone-edited.md'), 'utf8')).toBe('lokal tahrir');
  });

  it('manifest bo\'lmasa mirror hech narsa o\'chirmaydi', async () => {
    w(e.srcDir, 'agents/a.md', 'A');
    w(e.dstDir, 'agents/user-own.md', 'mening');
    const { payload } = await captureToApply(e, { mode: 'mirror' });
    const plan = (await ap(payload)).result!.config as ConfigPlanResult;
    expect(plan.summary.delete).toBe(0);
  });

  it('mirror: settings\'dan faqat Commander qo\'shgan yozuvlar olib tashlanadi', async () => {
    w(e.srcDir, 'settings.json', JSON.stringify({ permissions: { allow: ['Bash(a:*)', 'Bash(b:*)'] } }));
    w(e.dstDir, 'settings.json', JSON.stringify({ permissions: { allow: ['Bash(b:*)', 'Bash(user:*)'] }, hooks: { Stop: [1] } }));
    const c1 = await captureToApply(e, { mode: 'merge' });
    const p1 = (await ap(c1.payload)).result!.config as ConfigPlanResult;
    await ap({ ...c1.payload, dryRun: false, expectedPlanHash: p1.planHash });
    // yangi profil: faqat b
    w(e.srcDir, 'settings.json', JSON.stringify({ permissions: { allow: ['Bash(c:*)'] } }));
    const c2 = await captureToApply(e, { mode: 'mirror', profileVersion: 2 });
    const p2 = (await ap(c2.payload)).result!.config as ConfigPlanResult;
    expect(p2.settings!.allowRemove).toEqual(['Bash(a:*)']); // b foydalanuvchiniki edi: tegilmaydi
    await ap({ ...c2.payload, dryRun: false, expectedPlanHash: p2.planHash });
    const s = JSON.parse(readFileSync(path.join(e.dstDir, 'settings.json'), 'utf8'));
    expect(s.permissions.allow.sort()).toEqual(['Bash(b:*)', 'Bash(c:*)', 'Bash(user:*)']);
    expect(s.hooks).toEqual({ Stop: [1] });
  });
});

describe('bundle yaxlitligi va xavfsizlik', () => {
  const item = (content: string, p = 'CLAUDE.md') => ({ path: p, kind: 'claude_md' as 'claude_md' | 'agent', sha256: sha256Hex(content), size: Buffer.byteLength(content), exec: false });

  async function applyRaw(items: ReturnType<typeof item>[], files: Array<{ path: string; content: string }>, settings: SettingsFragment | null = null, over: Partial<ConfigApplyPayload> = {}) {
    const enc = encodeBundle({ files, settings });
    for (const c of enc.chunks) e.dst.onChunk(c);
    return e.dst.apply({ profileName: 'p', profileVersion: 1, mode: 'merge', dryRun: true, items, settingsSha256: settings ? settingsSha256(settings) : null, bundle: enc.ref, ...over });
  }

  it('xesh mos kelmasa rad', async () => {
    const out = await applyRaw([item('a')], [{ path: 'CLAUDE.md', content: 'b' }]);
    expect(out).toMatchObject({ ok: false, code: 'config_bundle_invalid' });
  });

  it('ruxsat ro\'yxatidan tashqari yo\'l (traversal) rad', async () => {
    for (const p of ['../evil.md', 'agents/../../x.md', '/etc/passwd', 'settings.json', 'skills/a/.env', 'agents\\x.md', 'hooks/x.md', 'agents/nul.md']) {
      const it = { path: p, kind: 'agent' as const, sha256: sha256Hex('x'), size: 1, exec: false };
      const out = await applyRaw([it], [{ path: p, content: 'x' }]);
      expect(out.ok, p).toBe(false);
    }
  });

  it('bundle\'dagi sirli fayl rad (chuqur himoya)', async () => {
    const c = 'token=sk-ant-abcdefghijklmnop1234';
    expect(await applyRaw([item(c)], [{ path: 'CLAUDE.md', content: c }])).toMatchObject({ ok: false, code: 'config_bundle_invalid' });
  });

  it('bundle kelmasa config_bundle_missing', async () => {
    const out = await e.dst.apply({ profileName: 'p', profileVersion: 1, mode: 'merge', dryRun: true, items: [item('a')], settingsSha256: null, bundle: { chunks: 1, sha256: 'a'.repeat(64), bytes: 10 } });
    expect(out).toMatchObject({ ok: false, code: 'config_bundle_missing' });
  });

  it('xavfli env yoki bo\'lakdagi keng allow rad etiladi (hech narsa yozilmaydi)', async () => {
    const frag: SettingsFragment = { permissions: { allow: ['Bash(*)'], deny: [] }, env: { ANTHROPIC_BASE_URL: 'http://x' } };
    const out = await applyRaw([], [], frag);
    const plan = out.result!.config as ConfigPlanResult;
    expect(plan.settings!.changed).toBe(false);
    expect(plan.settings!.refused.length).toBe(2);
  });

  it('settings.json buzuq JSON bo\'lsa tegilmaydi', async () => {
    w(e.dstDir, 'settings.json', '{ bu json emas');
    const frag: SettingsFragment = { permissions: { allow: ['Read'], deny: [] }, env: {} };
    const plan = (await applyRaw([], [], frag)).result!.config as ConfigPlanResult;
    expect(plan.settings!.changed).toBe(false);
    expect(plan.settings!.refused.join()).toMatch(/not valid JSON/);
  });
});

describe('Windows yo\'llari', () => {
  it('resolveManaged win32 kutubxonasi bilan ildiz ichida qoladi', () => {
    const lib = path.win32;
    expect(resolveManaged('C:\\Users\\a\\.claude', 'agents/x.md', lib)).toBe('C:\\Users\\a\\.claude\\agents\\x.md');
    expect(resolveManaged('C:\\Users\\a\\.claude', 'skills/s/ref/a.md', lib)).toBe('C:\\Users\\a\\.claude\\skills\\s\\ref\\a.md');
    for (const bad of ['..\\x.md', 'agents/..\\..\\x.md', 'C:/x.md', 'agents/x.md:ads', 'agents/con.md', 'agents/aux.md', 'agents/x.md.']) expect(resolveManaged('C:\\Users\\a\\.claude', bad, lib), bad).toBeNull();
  });
});

describe('heartbeat hisoboti', () => {
  it('birinchi marta va dirty bo\'lganda beradi, keyin interval kutadi', () => {
    expect(e.dst.heartbeatReport(true)).toBeDefined();
    expect(e.dst.heartbeatReport(false)).toBeUndefined();
    e.dst.markDirty();
    expect(e.dst.heartbeatReport(false)).toBeDefined();
  });

  it('lokal o\'zgarish: modified/missing aniqlanadi', async () => {
    w(e.srcDir, 'agents/a.md', 'A');
    w(e.srcDir, 'agents/b.md', 'B');
    const { payload } = await captureToApply(e);
    const plan = (await ap(payload)).result!.config as ConfigPlanResult;
    await ap({ ...payload, dryRun: false, expectedPlanHash: plan.planHash });
    w(e.dstDir, 'agents/a.md', 'o\'zgardi');
    rmSync(path.join(e.dstDir, 'agents/b.md'));
    const rep = e.dst.report();
    const byPath = Object.fromEntries(rep.files.map((f) => [f.path, f.sha256]));
    expect(byPath['agents/a.md']).toBe(sha256Hex("o'zgardi"));
    expect(byPath['agents/b.md']).toBeNull();
  });
});

it('chmod 0600 manifest (POSIX)', async () => {
  if (process.platform === 'win32') return;
  w(e.srcDir, 'agents/a.md', 'A');
  const { payload } = await captureToApply(e);
  const plan = (await ap(payload)).result!.config as ConfigPlanResult;
  await ap({ ...payload, dryRun: false, expectedPlanHash: plan.planHash });
  const { statSync } = await import('node:fs');
  expect(statSync(path.join(e.dstHome, 'config-manifest.json')).mode & 0o077).toBe(0);
  chmodSync(e.dstHome, 0o700);
});
