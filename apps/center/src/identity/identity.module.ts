import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CommandKeyModule } from '../commands/command-key.module.js';
import { CenterKeyAdminService } from './center-key-admin.service.js';
import { AuditController } from './audit/audit.controller.js';
import { AuditInterceptor } from './audit/audit.interceptor.js';
import { AuditService } from './audit/audit.service.js';
import { FailureAggregator } from './audit/failure-aggregator.js';
import { SecurityEvents } from './common/security-events.service.js';
import { DeviceOrClientGuard } from './devices/device-or-client.guard.js';
import { DeviceSignatureGuard } from './devices/device-signature.guard.js';
import { DeviceSignatureVerifier } from './devices/device-signature.verifier.js';
import { DeviceKeysService } from './devices/device-keys.service.js';
import { DevicesController } from './devices/devices.controller.js';
import { DevicesService } from './devices/devices.service.js';
import { EnrollmentController } from './enrollment/enrollment.controller.js';
import { EnrollmentService } from './enrollment/enrollment.service.js';
import { PairingController } from './pairing/pairing.controller.js';
import { PairingService } from './pairing/pairing.service.js';
import { LockdownService } from './lockdown/lockdown.service.js';
import { ClientAuthService, ClientTokenGuard } from './tokens/client-token.guard.js';
import { ClientTokensService } from './tokens/client-tokens.service.js';
import { ClientWsAuthService } from './tokens/client-ws-auth.service.js';

/**
 * 0.6 Identity: enrollment, imzolangan so'rovlar, klient tokenlari, lockdown, audit.
 * Admin amallari (kod/token yaratish, revoke, lockdown) HTTP'da YO'Q: faqat CLI (`dist/cli.js`).
 */
@Module({
  imports: [CommandKeyModule],
  controllers: [PairingController, EnrollmentController, DevicesController, AuditController],
  providers: [
    AuditService,
    FailureAggregator,
    SecurityEvents,
    LockdownService,
    DevicesService,
    DeviceKeysService,
    CenterKeyAdminService,
    DeviceSignatureVerifier,
    DeviceSignatureGuard,
    DeviceOrClientGuard,
    PairingService,
    ClientTokensService,
    ClientAuthService,
    ClientWsAuthService,
    ClientTokenGuard,
    EnrollmentService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [CommandKeyModule, AuditService, LockdownService, DevicesService, DeviceKeysService, CenterKeyAdminService, ClientTokensService, ClientAuthService, ClientWsAuthService, EnrollmentService, PairingService, SecurityEvents, DeviceSignatureVerifier],
})
export class IdentityModule {}
