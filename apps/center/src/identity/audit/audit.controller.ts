import { Controller, Get, Query } from '@nestjs/common';
import { ListAuditQuerySchema } from '@commander/contracts';
import type { AuditVerifyResponse, ListAuditQuery, ListAuditResponse } from '@commander/contracts';
import { ClientAuth } from '../devices/auth.decorators.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { AuditService } from './audit.service.js';

@Controller('v1/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** `admin` scope. `?verify=1`: zanjirni tekshiradi va birinchi buzilgan qator id'sini qaytaradi. */
  @Get()
  @ClientAuth('admin')
  list(@Query(new ZodValidationPipe(ListAuditQuerySchema)) query: ListAuditQuery): Promise<ListAuditResponse | AuditVerifyResponse> {
    return query.verify ? this.audit.verify() : this.audit.list(query);
  }
}
