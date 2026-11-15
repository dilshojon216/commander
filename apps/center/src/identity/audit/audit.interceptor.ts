import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';
import { isMutating, requestIp } from '../common/request-context.js';
import { AUDIT_ACTION_KEY, NO_AUDIT_KEY } from './audit.decorators.js';
import { AuditService } from './audit.service.js';
import type { AuditRecord } from './audit.service.js';

/**
 * Global interceptor. Audit qilinadi: (a) `@AuditAction` bilan belgilangan har qanday route, yoki
 * (b) `/v1/*` ostidagi har qanday mutating (POST/PUT/PATCH/DELETE) route, agar `@NoAudit()` bo'lmasa.
 *
 * Fail-closed: amal bajarilishidan OLDIN `phase=request` qatori yoziladi; yozib bo'lmasa so'rov 503
 * bilan to'xtaydi ("audit yozuvisiz amal yo'q"). Amal xato bilan tugasa, qo'shimcha `phase=error`
 * qatori yoziladi. Faqat autentifikatsiyadan o'tgan (guard) so'rovlar bu yerga yetadi, shu sabab
 * to'fon cheklangan. So'rov tanasi va sarlavhalari hech qachon yozilmaydi.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(NO_AUDIT_KEY, targets)) return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const explicit = this.reflector.getAllAndOverride<string | undefined>(AUDIT_ACTION_KEY, targets);
    const path = req.originalUrl.split('?')[0] ?? '';
    if (!explicit && !(isMutating(req.method) && path.startsWith('/v1/'))) return next.handle();

    const route = `${req.baseUrl ?? ''}${(req.route as { path?: string } | undefined)?.path ?? path}`;
    const base: AuditRecord = {
      actorDeviceId: req.principal?.device.id ?? null,
      actorKind: req.principal?.actorKind ?? 'system',
      action: explicit ?? `${req.method} ${route}`,
      target: Object.values(req.params ?? {}).join('/') || null,
      ip: requestIp(req),
    };
    const details = { method: req.method, route };

    return from(this.audit.record({ ...base, details: { ...details, phase: 'request' } })).pipe(
      catchError((err: unknown) => {
        this.logger.error(`Audit write failed, rejecting ${req.method} ${route}: ${err instanceof Error ? err.message : String(err)}`);
        return throwError(() => new ServiceUnavailableException({ error: 'audit_unavailable', message: 'Audit log unavailable; request refused' }));
      }),
      switchMap(() =>
        next.handle().pipe(
          catchError((err: unknown) => {
            const status = err instanceof HttpException ? err.getStatus() : 500;
            return from(
              this.audit
                .record({ ...base, details: { ...details, phase: 'error', http_status: status } })
                .catch((e: unknown) => this.logger.error(`Audit error-row failed: ${e instanceof Error ? e.message : String(e)}`)),
            ).pipe(switchMap(() => throwError(() => err)));
          }),
        ),
      ),
    );
  }
}
