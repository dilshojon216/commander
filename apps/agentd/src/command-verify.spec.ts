import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { newTestCenter, signDispatch } from './command-test-utils.js';
import { CommandStore } from './command-store.js';
import { MAX_FUTURE_EXPIRY_MS, verifyDispatch } from './command-verify.js';

const DEVICE = randomUUID();
const center = newTestCenter();
const stop = { type: 'session.stop' as const, payload: { claudeSessionId: 'abc-123' } };

describe('verifyDispatch', () => {
  const now = 1_800_000_000_000;
  const ctx = { pinnedKey: center.publicKey, deviceId: DEVICE, now };

  it('to\'g\'ri imzo o\'tadi', () => {
    expect(verifyDispatch(signDispatch(center, DEVICE, stop, { now }), ctx)).toBeNull();
  });
  it('pin yo\'q: center_key_unpinned (hech narsa bajarilmaydi)', () => {
    expect(verifyDispatch(signDispatch(center, DEVICE, stop, { now }), { ...ctx, pinnedKey: undefined })).toMatchObject({ code: 'center_key_unpinned' });
  });
  it('boshqa kalit bilan imzolangan: bad_signature', () => {
    expect(verifyDispatch(signDispatch(newTestCenter(), DEVICE, stop, { now }), ctx)).toMatchObject({ code: 'bad_signature' });
  });
  it('payload o\'zgartirilgan (masalan boshqa session): bad_signature', () => {
    const msg = signDispatch(center, DEVICE, stop, { now });
    const tampered = { ...msg, payload: { claudeSessionId: 'evil-999' } } as typeof msg;
    expect(verifyDispatch(tampered, ctx)).toMatchObject({ code: 'bad_signature' });
  });
  it('prompt matni o\'zgartirilgan: bad_signature', () => {
    const msg = signDispatch(center, DEVICE, { type: 'session.prompt', payload: { claudeSessionId: 'abc-123', text: 'ls' } }, { now });
    expect(verifyDispatch({ ...msg, payload: { claudeSessionId: 'abc-123', text: 'rm -rf ~' } } as typeof msg, ctx)).toMatchObject({ code: 'bad_signature' });
  });
  it('type, commandId, nonce, expiresAt o\'zgartirilsa: bad_signature', () => {
    const msg = signDispatch(center, DEVICE, stop, { now });
    expect(verifyDispatch({ ...msg, commandId: randomUUID() }, ctx)).toMatchObject({ code: 'bad_signature' });
    expect(verifyDispatch({ ...msg, nonce: 'A'.repeat(43) }, ctx)).toMatchObject({ code: 'bad_signature' });
    expect(verifyDispatch({ ...msg, expiresAt: msg.expiresAt + 1000 }, ctx)).toMatchObject({ code: 'bad_signature' });
  });
  it('boshqa mashina (device) uchun imzolangan buyruq o\'tmaydi', () => {
    expect(verifyDispatch(signDispatch(center, randomUUID(), stop, { now }), ctx)).toMatchObject({ code: 'bad_signature' });
  });
  it('muddati o\'tgan: expired; juda uzoq kelajak: invalid_payload', () => {
    expect(verifyDispatch(signDispatch(center, DEVICE, stop, { now, expiresAt: now - 1 }), ctx)).toMatchObject({ code: 'expired' });
    expect(verifyDispatch(signDispatch(center, DEVICE, stop, { now, expiresAt: now }), ctx)).toMatchObject({ code: 'expired' });
    expect(verifyDispatch(signDispatch(center, DEVICE, stop, { now, expiresAt: now + MAX_FUTURE_EXPIRY_MS + 1 }), ctx)).toMatchObject({ code: 'invalid_payload' });
  });
  it('kalit tartibi/ixtiyoriy maydonlar imzoga ta\'sir qilmaydi (canonicalJson)', () => {
    const body = { type: 'session.start' as const, payload: { permissionMode: 'plan' as const, prompt: 'hi', cwd: '/x' } };
    const msg = signDispatch(center, DEVICE, body, { now });
    const reordered = { ...msg, payload: { cwd: '/x', prompt: 'hi', permissionMode: 'plan' } } as typeof msg;
    expect(verifyDispatch(reordered, ctx)).toBeNull();
  });
});

describe('CommandStore: nonce/commandId bir martaligi', () => {
  it('birinchi marta ok, takror commandId duplicate, boshqa buyruqda shu nonce = replay; restartdan keyin ham (fayl DB)', () => {
    const db = new DatabaseSync(':memory:');
    const store = new CommandStore(db);
    const a = randomUUID();
    expect(store.begin(a, 'N'.repeat(43), 'session.stop')).toBe('ok');
    expect(store.begin(a, 'M'.repeat(43), 'session.stop')).toBe('duplicate_command');
    expect(store.begin(randomUUID(), 'N'.repeat(43), 'session.stop')).toBe('replayed_nonce');
    const again = new CommandStore(db); // "restart": jadval saqlanib qoladi
    expect(again.begin(randomUUID(), 'N'.repeat(43), 'session.stop')).toBe('replayed_nonce');
  });
  it('natija tasdiqlanmaguncha unconfirmed() da turadi; tasdiqlangach chiqadi', () => {
    const store = new CommandStore(new DatabaseSync(':memory:'));
    const id = randomUUID();
    store.begin(id, 'N'.repeat(43), 'session.start');
    store.markAckSent(id);
    store.setState(id, 'done', { claudeSessionId: 's1' });
    expect(store.unconfirmed().map((c) => c.commandId)).toEqual([id]);
    store.confirmAck(id);
    store.confirmResult(id, 'done');
    expect(store.unconfirmed()).toEqual([]);
    expect(store.startedSessionIds()).toEqual(['s1']);
  });
});
