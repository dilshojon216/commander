import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { telegramExtensions } from '../telegram/telegram-extensions.js';
import { formatPartsOverview } from './parts-telegram-format.js';
import { ProjectPartsService } from './project-parts.service.js';

/** Telegram `/p [loyiha]`: qismlari bor loyihalar progressi. Faqat o'qish (allowlist bot darvozasida tekshirilgan). */
@Injectable()
export class PartsTelegram implements OnModuleInit, OnModuleDestroy {
  private unregister: (() => void) | null = null;

  constructor(private readonly parts: ProjectPartsService) {}

  onModuleInit(): void {
    this.unregister = telegramExtensions.register('p', (args) => this.handle(args));
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = null;
  }

  async handle(args: string): Promise<string[]> {
    const filter = args.trim().slice(0, 64) || null;
    return [formatPartsOverview(await this.parts.overview(filter), filter)];
  }
}
