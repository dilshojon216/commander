import { monitorEventLoopDelay } from 'node:perf_hooks';
import { statfsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import v8 from 'node:v8';

/** O'lchov manbalari (I/O). Servis testlarda soxta `CenterProbes` bilan almashtiriladi. */
export interface CenterProbes {
  /** Docker/DB hajmi uchun fayl tizimi: band foiz, bo'sh va jami bayt. */
  disk(): { usedPct: number; freeBytes: number; totalBytes: number } | null;
  /** `true/false` = javob berdi/bermadi; `null` = sozlanmagan. */
  http(target: 'dashboard' | 'tailscale'): Promise<boolean | null>;
  /** Oxirgi chaqiruvdan beri event-loop kechikishi p99 (ms) va xotira. Har chaqiruvda histogramma nollanadi. */
  runtime(): { lagP99Ms: number | null; rssBytes: number; heapUsedPct: number };
  stop(): void;
}

export interface ProbeOptions {
  /** Hajmi o'lchanadigan yo'l (Docker VM diski: maxfiy volume shu diskda, pgdata ham). */
  diskPath: string;
  /** Dashboard (`http://host.docker.internal:4318/`); bo'sh = o'chiq. Host sarlavhasi 127.0.0.1:4318 qilinadi (dashboard proxy faqat loopback Host'ni qabul qiladi). */
  dashboardUrl: string | null;
  /** Tailscale serve orqali markazning o'zi (`https://<mac>.<tailnet>.ts.net/health`); bo'sh = o'chiq. */
  tailscaleUrl: string | null;
  timeoutMs: number;
}

/** GET; 5xx va tarmoq xatosi = false, qolgan HTTP javoblar (hatto 403) = servis tirik. Javob tanasi o'qilmaydi. */
export function probeHttp(url: string, opts: { hostHeader?: string; timeoutMs: number }): Promise<boolean> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', timeout: opts.timeoutMs, headers: opts.hostHeader ? { host: opts.hostHeader } : {} }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 599) < 500);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

export function createProbes(o: ProbeOptions): CenterProbes {
  const hist: ReturnType<typeof monitorEventLoopDelay> = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  return {
    disk() {
      try {
        const s = statfsSync(o.diskPath);
        const total = s.blocks * s.bsize;
        const used = (s.blocks - s.bfree) * s.bsize;
        const avail = s.bavail * s.bsize;
        const denom = used + avail; // `df` Use% formulasi
        if (denom <= 0) return null;
        return { usedPct: (used / denom) * 100, freeBytes: avail, totalBytes: total };
      } catch {
        return null;
      }
    },
    async http(target) {
      if (target === 'dashboard') return o.dashboardUrl ? probeHttp(o.dashboardUrl, { hostHeader: '127.0.0.1:4318', timeoutMs: o.timeoutMs }) : null;
      return o.tailscaleUrl ? probeHttp(o.tailscaleUrl, { timeoutMs: o.timeoutMs }) : null;
    },
    runtime() {
      const lag = hist.count > 0 ? hist.percentile(99) / 1e6 : null; // ns -> ms
      hist.reset();
      const heap = v8.getHeapStatistics();
      return { lagP99Ms: lag, rssBytes: process.memoryUsage.rss(), heapUsedPct: (heap.used_heap_size / heap.heap_size_limit) * 100 };
    },
    stop() {
      hist.disable();
    },
  };
}
