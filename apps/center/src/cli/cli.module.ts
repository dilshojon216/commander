import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnv } from '../config/env.validation.js';
import { typeOrmOptions } from '../database/database.config.js';
import { IdentityModule } from '../identity/identity.module.js';
import { RetentionCoreModule } from '../retention/retention.module.js';
import { TelegramAccessModule } from '../telegram/telegram.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => typeOrmOptions(config.getOrThrow<string>('DATABASE_URL'), false),
    }),
    IdentityModule,
    TelegramAccessModule,
    RetentionCoreModule,
  ],
})
export class CliModule {}
