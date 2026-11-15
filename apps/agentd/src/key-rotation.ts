import { sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { buildKeyRotationString } from '@commander/contracts';
import type { KeyRotatePayload, KeyRotateResultPayload } from '@commander/contracts';
import { discardNextKey, generateDeviceKey, promoteNextKey, publicKeyRawOf, storeNextKey } from './identity.js';
import { errMsg } from './logger.js';
import type { Logger } from './logger.js';
import type { AgentdPaths } from './paths.js';

export type RotateOutcome = { ok: true; fingerprint: string } | { ok: false; reason: string };

export interface KeyRotatorDeps {
  paths: AgentdPaths;
  deviceId: string;
  log: Logger;
  /** Hozirgi (eski) maxfiy kalit. */
  getKey: () => KeyObject;
  /** Muvaffaqiyatdan keyin: jarayon xotirasidagi kalitni almashtiradi (WS klient keyingi ulanishda yangisini ishlatadi). */
  setKey: (key: KeyObject) => void;
  isReady: () => boolean;
  rotateKey: (payload: KeyRotatePayload) => Promise<KeyRotateResultPayload>;
  now?: () => number;
}

/**
 * Qurilma kalitini aylantirish (5.1): yangi Ed25519 kalit yaratadi, `device.key.next` ga yozadi, ESKI va YANGI kalit bilan
 * `buildKeyRotationString` ni imzolab `key.rotate` yuboradi. Markaz `ok` desa `device.key.next` -> `device.key` (atomik) va xotira
 * almashadi. Aniq rad etilsa yangi fayl o'chiriladi. Natija noma'lum (timeout/uzilish) bo'lsa yangi fayl SAQLANADI: markaz
 * almashtirgan bo'lishi mumkin, keyingi ulanishda WS klient zaxira kalitni sinaydi (`fallbackKey`). Bir vaqtda bitta aylantirish.
 */
export class KeyRotator {
  private busy: Promise<RotateOutcome> | null = null;

  constructor(private readonly d: KeyRotatorDeps) {}

  rotate(): Promise<RotateOutcome> {
    if (this.busy) return this.busy;
    const p = this.doRotate().finally(() => {
      this.busy = null;
    });
    this.busy = p;
    return p;
  }

  private async doRotate(): Promise<RotateOutcome> {
    const { d } = this;
    if (!d.isReady()) return { ok: false, reason: 'center bilan ulanish tayyor emas (agentd online bo\'lishi kerak)' };
    const oldKey = d.getKey();
    const next = generateDeviceKey();
    const ts = (d.now ?? Date.now)();
    const canonical = Buffer.from(
      buildKeyRotationString({ deviceId: d.deviceId, oldPublicKey: publicKeyRawOf(oldKey), newPublicKey: next.publicKeyRaw, ts }),
      'utf8',
    );
    const payload: KeyRotatePayload = {
      newPublicKey: next.publicKeyRaw,
      ts,
      oldSignature: sign(null, canonical, oldKey).toString('base64url'),
      newSignature: sign(null, canonical, next.privateKey).toString('base64url'),
    };
    storeNextKey(d.paths, next.privateKey);
    let result: KeyRotateResultPayload;
    try {
      result = await d.rotateKey(payload);
    } catch (err) {
      d.log.warn("kalit aylantirish natijasi noma'lum: yangi kalit zaxira sifatida saqlandi (keyingi ulanishda sinab ko'riladi)", { error: errMsg(err) });
      return { ok: false, reason: `natija noma'lum: ${errMsg(err)}` };
    }
    if (!result.ok) {
      discardNextKey(d.paths);
      d.log.error('markaz kalit aylantirishni rad etdi', { code: result.code });
      return { ok: false, reason: `markaz rad etdi: ${result.code ?? 'noma\'lum'}` };
    }
    promoteNextKey(d.paths);
    d.setKey(next.privateKey);
    d.log.info('qurilma kaliti aylantirildi', { deviceId: d.deviceId });
    return { ok: true, fingerprint: publicKeyRawOf(next.privateKey).slice(0, 8) };
  }
}
