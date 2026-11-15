import { Injectable, Logger, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import pg from 'pg';
import { DEVICE_EVENTS_CHANNEL, parseDeviceEvent } from '../identity/devices/device-events.js';
import { RealtimeBus } from './realtime-bus.js';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * `LISTEN commander_device_events` (alohida, pool'siz ulanish) va ularni `RealtimeBus`ga `device.event` qilib e'lon qiladi (5.1).
 * Ulanish uzilsa eksponensial kutish bilan qayta ulanadi; shu paytda kelgan signallar yo'qoladi, lekin sweep'lar (agent 15 s,
 * klient 5 s) baribir revoke'ni ushlaydi: bu "darhol" yo'li, yagona himoya emas.
 */
@Injectable()
export class DeviceEventsListener implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(DeviceEventsListener.name);
  private client: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private delay = RECONNECT_MIN_MS;
  private stopped = false;
  private connectedOnce: Promise<void> = Promise.resolve();

  constructor(
    private readonly bus: RealtimeBus,
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
  ) {}

  onModuleInit(): void {
    const url = this.url();
    if (!url) return;
    this.connectedOnce = this.connect(url);
  }

  /** Test uchun: birinchi ulanish (LISTEN) tugaguncha kutadi. */
  ready(): Promise<void> {
    return this.connectedOnce;
  }

  beforeApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const c = this.client;
    this.client = null;
    c?.removeAllListeners();
    c?.on('error', () => undefined);
    void c?.end().catch(() => undefined);
  }

  private url(): string | null {
    const opts = this.dataSource?.options as { url?: string } | undefined;
    return opts?.url ?? null;
  }

  private async connect(url: string): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: url });
    try {
      client.on('notification', (msg) => {
        if (msg.channel !== DEVICE_EVENTS_CHANNEL) return;
        const ev = parseDeviceEvent(msg.payload);
        if (!ev) return;
        if (ev.kind === 'center_key_rotated') this.bus.publish({ type: 'device.event', kind: 'center_key_rotated', deviceId: null });
        else if (ev.deviceId) this.bus.publish({ type: 'device.event', kind: ev.kind, deviceId: ev.deviceId });
      });
      client.on('error', (err) => {
        this.logger.warn(`device events connection error: ${err.message}`);
        this.scheduleReconnect(url, client);
      });
      client.on('end', () => this.scheduleReconnect(url, client));
      await client.connect();
      await client.query(`LISTEN ${DEVICE_EVENTS_CHANNEL}`);
      this.client = client;
      this.delay = RECONNECT_MIN_MS;
      this.logger.log('Listening for device events (instant revoke / rotation)');
    } catch (err) {
      this.logger.warn(`device events listen failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect(url, client);
    }
  }

  private scheduleReconnect(url: string, dead: pg.Client): void {
    if (this.stopped || this.timer) return;
    if (this.client === dead) this.client = null;
    dead.removeAllListeners();
    dead.on('error', () => undefined);
    void dead.end().catch(() => undefined);
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, RECONNECT_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect(url);
    }, wait);
    this.timer.unref();
  }
}
