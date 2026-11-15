import { Module } from '@nestjs/common';
import { RetentionBootCheck, RetentionService } from './retention.service.js';

/** CLI uchun: faqat o'qish servisi (boot hook'siz). */
@Module({ providers: [RetentionService], exports: [RetentionService] })
export class RetentionCoreModule {}

/** Server uchun: servis + boot tekshiruvi. */
@Module({ imports: [RetentionCoreModule], providers: [RetentionBootCheck], exports: [RetentionCoreModule] })
export class RetentionModule {}
