import { Injectable } from '@nestjs/common';
import type { CommandDto } from '@commander/contracts';

/**
 * Step-up (ikkinchi tasdiq) kanali. Hozirgi yagona amalga oshirish: Telegram (allowlist'dagi egasi chati).
 * `CommandsService` Telegram modulini bilmaydi (modul sikli yo'q): Telegram o'zini bu reestrga ro'yxatdan o'tkazadi.
 * Kanal yo'q yoki yuborib bo'lmasa buyruq `failed(step_up_unavailable)` bo'ladi: hech qachon avtomatik tasdiqlanmaydi.
 */
export interface StepUpChannel {
  /** Kanal hozir ishlay oladimi (bot yoqilgan, polling bor, kamida bitta allowlist chat). */
  isAvailable(): Promise<boolean>;
  /** Tasdiq so'rovini yuboradi; yetkazilgan chatlar soni (0 = hech qayerga yetmadi). */
  request(command: CommandDto): Promise<number>;
}

@Injectable()
export class StepUpRegistry {
  private channel: StepUpChannel | null = null;

  register(channel: StepUpChannel): () => void {
    this.channel = channel;
    return () => {
      if (this.channel === channel) this.channel = null;
    };
  }

  async available(): Promise<boolean> {
    if (!this.channel) return false;
    try {
      return await this.channel.isAvailable();
    } catch {
      return false;
    }
  }

  /** `0` = yuborilmadi (kanal yo'q yoki xato). Xato yutilmaydi: chaqiruvchi `step_up_unavailable` qiladi. */
  async request(command: CommandDto): Promise<number> {
    if (!this.channel) return 0;
    try {
      return await this.channel.request(command);
    } catch {
      return 0;
    }
  }
}
