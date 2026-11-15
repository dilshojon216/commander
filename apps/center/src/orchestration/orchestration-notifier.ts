import { Injectable, Optional } from '@nestjs/common';
import { TelegramService } from '../telegram/telegram.service.js';

/** Telegram'ga bildirishnoma (bot yo'q/o'chiq bo'lsa jim). Modul sikli yo'q: Telegram orkestratsiyani bilmaydi. */
@Injectable()
export class OrchestrationNotifier {
  constructor(@Optional() private readonly telegram?: TelegramService) {}

  async send(html: string): Promise<number> {
    return this.telegram ? this.telegram.notifyText(html) : 0;
  }
}
