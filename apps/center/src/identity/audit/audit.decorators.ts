import { SetMetadata } from '@nestjs/common';

export const NO_AUDIT_KEY = 'identity:no-audit';
export const AUDIT_ACTION_KEY = 'identity:audit-action';

/** Opt-out: default bo'yicha audit qilinadigan mutating /v1 route'ni auditdan chiqaradi (o'zi audit yozsa). */
export const NoAudit = (): MethodDecorator & ClassDecorator => SetMetadata(NO_AUDIT_KEY, true);

/** Aniq action nomi (masalan `command.create`); GET route'ni ham auditga majburlaydi. */
export const AuditAction = (action: string): MethodDecorator & ClassDecorator => SetMetadata(AUDIT_ACTION_KEY, action);
