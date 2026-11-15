import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { Request } from 'express';
import type { EnrollRequest, EnrollResponse } from '@commander/contracts';
import { AuditService } from '../audit/audit.service.js';
import {
  decodeRawEd25519PublicKey,
  generateEnrollmentCode,
  hashEnrollmentCode,
} from '../common/crypto.util.js';
import { requestIp, socketIp } from '../common/request-context.js';
import { SecurityEvents, tooMany } from '../common/security-events.service.js';
import { LockdownService } from '../lockdown/lockdown.service.js';

export const ENROLLMENT_DEFAULT_TTL_MINUTES = 15;
const POSTGRES_UNIQUE_VIOLATION = '23505';

class CodeRejected extends Error {
  constructor(
    readonly reason: 'unknown' | 'used' | 'expired',
    readonly codeId?: string,
  ) {
    super(reason);
  }
}

interface CodeRow {
  id: string;
  machine_name: string;
  kind: 'agentd';
  used_at: Date | null;
  expired: boolean;
}

export interface CreatedEnrollmentCode {
  id: string;
  code: string;
  kind: 'agentd';
  machine_name: string;
  expires_at: string;
}

@Injectable()
export class EnrollmentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: SecurityEvents,
    private readonly lockdown: LockdownService,
  ) {}

  /** Admin (faqat CLI): bir martalik kod yaratadi. Kod faqat shu javobda ko'rinadi, DB'da xesh. */
  async createCode(
    input: { kind: string; machineName: string; ttlMinutes?: number },
    via: string,
  ): Promise<CreatedEnrollmentCode> {
    if (input.kind !== 'agentd') throw new BadRequestException(`Unsupported enrollment kind "${input.kind}" (only: agentd)`);
    const machineName = input.machineName.trim();
    if (!machineName || machineName.length > 100 || /[\x00-\x1f]/.test(machineName)) {
      throw new BadRequestException('machine-name must be 1-100 printable chars');
    }
    const ttl = input.ttlMinutes ?? ENROLLMENT_DEFAULT_TTL_MINUTES;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 60) throw new BadRequestException('ttl-minutes must be an integer 1-1440');

    const code = generateEnrollmentCode();
    const row = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ id: string; expires_at: Date }> = await m.query(
        `INSERT INTO enrollment_codes (code_hash, kind, machine_name, expires_at)
         VALUES ($1, 'agentd', $2, now() + make_interval(mins => $3::int))
         RETURNING id, expires_at`,
        [hashEnrollmentCode(code), machineName, ttl],
      );
      const created = rows[0]!;
      await this.audit.record(
        {
          actorKind: 'system',
          action: 'enrollment_code.created',
          target: created.id,
          details: { kind: 'agentd', machine_name: machineName, ttl_minutes: ttl, expires_at: created.expires_at.toISOString(), via },
        },
        m,
      );
      return created;
    });
    return { id: row.id, code, kind: 'agentd', machine_name: machineName, expires_at: row.expires_at.toISOString() };
  }

  listCodes(): Promise<Array<{ id: string; machine_name: string; expires_at: Date; used_at: Date | null; created_at: Date }>> {
    return this.dataSource.query(
      `SELECT id, machine_name, expires_at, used_at, created_at FROM enrollment_codes ORDER BY created_at DESC LIMIT 50`,
    );
  }

  /**
   * `POST /v1/enroll`. Kod faqat muvaffaqiyatda sarflanadi; mashina, qurilma, kodni sarflash,
   * merge-nomzodlar va audit yozuvlari BITTA tranzaksiyada (audit yozilmasa enrollment ham yo'q).
   * Tashqariga barcha kod xatolari (noma'lum/ishlatilgan/muddati o'tgan) bir xil 401; sabab auditda.
   */
  async enroll(body: EnrollRequest, req: Request): Promise<EnrollResponse> {
    const peer = socketIp(req);
    const { events } = this;
    const checks: Array<[typeof events.enrollRequests, string]> = [
      [events.enrollRequests, peer],
      [events.enrollFailuresByIp, peer],
      [events.enrollFailuresGlobal, 'global'],
    ];
    for (const [limiter, key] of checks) {
      if (limiter.isBlocked(key)) throw tooMany(limiter.retryAfterSeconds(key));
    }
    events.enrollRequests.hit(peer);

    await this.lockdown.assertMutationAllowed(req);

    const publicKey = decodeRawEd25519PublicKey(body.public_key);
    if (!publicKey) {
      throw new BadRequestException({ error: 'invalid_public_key', message: 'public_key must be a raw 32-byte Ed25519 key (base64/base64url)' });
    }

    const ip = requestIp(req);
    try {
      return await this.dataSource.transaction((m) => this.enrollTx(m, body, publicKey, ip));
    } catch (err) {
      if (err instanceof CodeRejected) {
        events.enrollFailuresByIp.hit(peer);
        events.enrollFailuresGlobal.hit('global');
        events.enrollFailed(req, err.reason, err.codeId);
        throw new UnauthorizedException({ error: 'invalid_enrollment_code', message: 'Enrollment code is invalid, expired or already used' });
      }
      if (err instanceof ConflictException) {
        events.enrollFailed(req, 'conflict');
      }
      throw err;
    }
  }

  private async enrollTx(m: EntityManager, body: EnrollRequest, publicKey: Buffer, ip: string | null): Promise<EnrollResponse> {
    const codeRows: CodeRow[] = await m.query(
      `SELECT id, machine_name, kind, used_at, (expires_at <= now()) AS expired
         FROM enrollment_codes WHERE code_hash = $1 FOR UPDATE`,
      [hashEnrollmentCode(body.code)],
    );
    const code = codeRows[0];
    if (!code) throw new CodeRejected('unknown');
    if (code.used_at) throw new CodeRejected('used', code.id);
    if (code.expired) throw new CodeRejected('expired', code.id);

    // Mashina identity'si hardware_id bo'yicha (hostname EMAS).
    const hostNorm = body.hostname.toLowerCase().replace(/\.local$/, '');
    const osLabel = `${body.os}/${body.arch}`;
    const existing: Array<{ id: string }> = await m.query(`SELECT id FROM machines WHERE hardware_id = $1 FOR UPDATE`, [body.hardware_id]);
    let machineId: string;
    if (existing[0]) {
      machineId = existing[0].id;
      const active: unknown[] = await m.query(
        `SELECT 1 FROM devices WHERE machine_id = $1 AND kind = 'agentd' AND revoked_at IS NULL LIMIT 1`,
        [machineId],
      );
      if (active.length > 0) {
        throw new ConflictException({ error: 'machine_already_enrolled', message: 'This machine already has an active agentd device; revoke it first' });
      }
      await m.query(
        `UPDATE machines SET hostname = $2, os = $3, identity_status = 'verified', status = 'active', last_seen_at = now() WHERE id = $1`,
        [machineId, body.hostname, osLabel],
      );
    } else {
      const created: Array<{ id: string }> = await m.query(
        `INSERT INTO machines (slug, display_name, hostname, hardware_id, os, identity_status, last_seen_at)
         VALUES (commander_machine_slug($1 || ':' || $2), $3, $1, $2, $4, 'verified', now())
         RETURNING id`,
        [body.hostname, body.hardware_id, code.machine_name, osLabel],
      );
      machineId = created[0]!.id;
    }

    let deviceId: string;
    try {
      const devices: Array<{ id: string }> = await m.query(
        `INSERT INTO devices (machine_id, kind, name, public_key) VALUES ($1, 'agentd', $2, $3) RETURNING id`,
        [machineId, code.machine_name, publicKey],
      );
      deviceId = devices[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
        throw new ConflictException({ error: 'public_key_already_enrolled', message: 'This public key is already enrolled' });
      }
      throw err;
    }

    await m.query(`UPDATE enrollment_codes SET used_at = now(), used_by_device_id = $1 WHERE id = $2 AND used_at IS NULL`, [deviceId, code.id]);

    // legacy_unverified mashinalar bilan hostname mosligi: faqat nomzod yoziladi, AVTO-MERGE YO'Q.
    const candidates: Array<{ candidate_machine_id: string }> = await m.query(
      `INSERT INTO machine_merge_candidates (machine_id, candidate_machine_id, reason)
       SELECT $1::uuid, c.id, 'hostname_match' FROM machines c
        WHERE c.id <> $1 AND c.identity_status = 'legacy_unverified' AND c.merged_into_id IS NULL
          AND (lower(regexp_replace(coalesce(c.legacy_host, ''), '[.]local$', '')) = $2
            OR lower(regexp_replace(coalesce(c.hostname, ''), '[.]local$', '')) = $2)
       ON CONFLICT (machine_id, candidate_machine_id) DO NOTHING
       RETURNING candidate_machine_id`,
      [machineId, hostNorm],
    );

    // Audit oxirida (zanjir advisory lock tranzaksiya oxirigacha ushlanadi: qisqa bo'lsin).
    await this.audit.record({ actorKind: 'system', action: 'enrollment_code.used', target: code.id, ip, details: { device_id: deviceId, machine_id: machineId } }, m);
    await this.audit.record(
      {
        actorDeviceId: deviceId,
        actorKind: 'agentd',
        action: 'device.enrolled',
        target: deviceId,
        ip,
        details: { machine_id: machineId, machine_name: code.machine_name, hostname: body.hostname, os: body.os, arch: body.arch, hardware_id: body.hardware_id },
      },
      m,
    );
    for (const c of candidates) {
      await this.audit.record(
        { actorKind: 'system', action: 'machine.merge_candidate', target: machineId, details: { candidate_machine_id: c.candidate_machine_id, reason: 'hostname_match' } },
        m,
      );
    }
    return { device_id: deviceId, machine_id: machineId };
  }
}
