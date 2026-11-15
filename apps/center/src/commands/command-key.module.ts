import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandSignerService } from './command-signer.service.js';
import { COMMANDS_OPTIONS, commandsOptionsFromConfig } from './commands.options.js';

/** Markaz imzo kaliti (bog'liqliksiz): IdentityModule (enrollment javobi) ham, CommandsModule ham ishlatadi: modul sikli yo'q. */
@Module({
  providers: [{ provide: COMMANDS_OPTIONS, inject: [ConfigService], useFactory: (c: ConfigService) => commandsOptionsFromConfig(c) }, CommandSignerService],
  exports: [COMMANDS_OPTIONS, CommandSignerService],
})
export class CommandKeyModule {}
