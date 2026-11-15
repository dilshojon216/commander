import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { Device } from '../../database/entities/device.entity.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuditActorKind } from '../audit/audit.service.js';

export const LAST_USED_THROTTLE_MS = 60_000;

@Injectable()
export class DevicesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * `last_used_at`ni yangilaydi (har so'rovda emas: kamida 60 s oralig'ida). `true` qaytarsa bu
   * qurilma/token BIRINCHI marta ishlatilgan (atomik: `last_used_at IS NULL` sharti).
   */
  async touch(device: Device): Promise<boolean> {
    const repo = this.dataSource.getRepository(Device);
    if (device.lastUsedAt === null) {
      const res = await repo.update({ id: device.id, lastUsedAt: IsNull() }, { lastUsedAt: () => 'now()' });
      return (res.affected ?? 0) > 0;
    }
    if (Date.now() - device.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
      await repo.update({ id: device.id }, { lastUsedAt: () => 'now()' });
    }
    return false;
  }

  list(): Promise<Device[]> {
    return this.dataSource.getRepository(Device).find({ order: { createdAt: 'DESC' } });
  }

  /**
   * Qurilma yoki tokenni bekor qiladi (idempotent emas: allaqachon bekor qilingan bo'lsa xato).
   * `actor`: o'zini o'zi revoke qilgan klient (audit aktori shu qurilma); CLI uchun yo'q (aktor `system`).
   * `expect`: 'agentd' | 'client' — noto'g'ri turdagi id bilan CLI buyrug'ini ishlatishdan saqlaydi.
   */
  async revoke(id: string, expect: 'agentd' | 'client' | 'any', via: string, actor?: { deviceId: string; kind: AuditActorKind }): Promise<Device> {
    return this.dataSource.transaction(async (m) => {
      const device = await m.getRepository(Device).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!device) throw new NotFoundException(`Device ${id} not found`);
      const isAgent = device.kind === 'agentd';
      if ((expect === 'agentd' && !isAgent) || (expect === 'client' && isAgent)) {
        throw new BadRequestException(`Device ${id} is a ${device.kind}; use the ${isAgent ? 'device' : 'token'} command`);
      }
      if (device.revokedAt) throw new BadRequestException(`Device ${id} is already revoked`);
      await m.getRepository(Device).update({ id }, { revokedAt: () => 'now()' });
      await this.audit.record(
        {
          actorKind: actor?.kind ?? 'system',
          ...(actor ? { actorDeviceId: actor.deviceId } : {}),
          action: isAgent ? 'device.revoked' : 'token.revoked',
          target: id,
          details: { kind: device.kind, name: device.name, via },
        },
        m,
      );
      return { ...device, revokedAt: new Date() };
    });
  }
}
