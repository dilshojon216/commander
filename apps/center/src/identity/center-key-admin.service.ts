import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CENTER_KEY_OVERLAP_DAYS_DEFAULT } from '@commander/contracts';
import { rotateSignerKeyFile, fingerprintOfRaw } from '../commands/center-key-rotation.js';
import { CommandSignerService } from '../commands/command-signer.service.js';
import { AuditService } from './audit/audit.service.js';
import { notifyDeviceEvent } from './devices/device-events.js';

export interface CenterKeyStatus {
  publicKey: string;
  fingerprint: string;
  /** Ustma-ust tushish oynasidagi e'lonlar (agentlar eski pin'dan shu orqali TOFUsiz o'tadi). */
  overlap: Array<{ fromFingerprint: string; toFingerprint: string; issuedAt: string; expiresAt: string }>;
}

/**
 * `center-key rotate` / `show` (5.1): markaz imzo kalitini aylantirish, ESKI kalit bilan imzolangan e'lon, audit va server
 * jarayoniga NOTIFY (u kalitni diskdan qayta yuklaydi). CLI alohida jarayon, shuning uchun server o'z xotirasidagi kalitni
 * faqat shu signal (yoki restart) orqali yangilaydi.
 */
@Injectable()
export class CenterKeyAdminService {
  constructor(
    private readonly signer: CommandSignerService,
    private readonly audit: AuditService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  status(now: number = Date.now()): CenterKeyStatus {
    const chain = this.signer.currentRotations(now);
    return {
      publicKey: this.signer.publicKey,
      fingerprint: this.signer.fingerprint,
      overlap: chain.map((r) => ({
        fromFingerprint: fingerprintOfRaw(r.previousPublicKey),
        toFingerprint: fingerprintOfRaw(r.newPublicKey),
        issuedAt: new Date(r.issuedAt).toISOString(),
        expiresAt: new Date(r.expiresAt).toISOString(),
      })),
    };
  }

  async rotate(overlapDays: number | undefined, via: string, now: number = Date.now()): Promise<{ previousFingerprint: string; newFingerprint: string; expiresAt: string }> {
    const days = overlapDays ?? CENTER_KEY_OVERLAP_DAYS_DEFAULT;
    let r: { previousFingerprint: string; newFingerprint: string; expiresAt: number };
    if (this.signer.mode === 'signer') {
      // 5.7: yangi kalit imzolovchi ICHIDA yaratiladi (Keychain); markaz maxfiy kalitni ko'rmaydi.
      r = await this.signer.rotate(days);
    } else {
      const file = this.signer.keyFilePath;
      if (!file) throw new Error('center signing key is in-memory only (CENTER_KEY_FILE is not set): nothing to rotate');
      r = rotateSignerKeyFile(file, now, days);
      await this.signer.reload();
    }
    await this.audit.record({
      actorKind: 'system',
      action: 'center_key.rotated',
      details: {
        previous_fingerprint: r.previousFingerprint,
        new_fingerprint: r.newFingerprint,
        overlap_days: days,
        overlap_ends_at: new Date(r.expiresAt).toISOString(),
        via,
      },
    });
    await notifyDeviceEvent(this.dataSource, 'center_key_rotated');
    return { previousFingerprint: r.previousFingerprint, newFingerprint: r.newFingerprint, expiresAt: new Date(r.expiresAt).toISOString() };
  }
}
