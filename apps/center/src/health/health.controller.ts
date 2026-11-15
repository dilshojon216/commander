import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check(): Promise<{ ok: true }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch (err) {
      this.logger.error(`Database health check failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException({ ok: false, error: 'database_unavailable' });
    }
    return { ok: true };
  }
}
