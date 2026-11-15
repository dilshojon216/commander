import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProbes, probeHttp } from './center-probes.js';

let server: ReturnType<typeof createServer>;
let base: string;
const seenHosts: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seenHosts.push(String(req.headers.host));
    if (req.url === '/slow') return; // javob yo'q: timeout
    res.statusCode = req.url === '/boom' ? 503 : req.url === '/forbidden' ? 403 : 200;
    res.end('x');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('probeHttp', () => {
  it('2xx and 4xx (service alive, e.g. dashboard host check 403) are up; 5xx, timeout and refused are down', async () => {
    expect(await probeHttp(`${base}/ok`, { timeoutMs: 1000 })).toBe(true);
    expect(await probeHttp(`${base}/forbidden`, { timeoutMs: 1000 })).toBe(true);
    expect(await probeHttp(`${base}/boom`, { timeoutMs: 1000 })).toBe(false);
    expect(await probeHttp(`${base}/slow`, { timeoutMs: 200 })).toBe(false);
    expect(await probeHttp('http://127.0.0.1:1/', { timeoutMs: 500 })).toBe(false);
    expect(await probeHttp('not a url', { timeoutMs: 500 })).toBe(false);
  });

  it('overrides the Host header (dashboard accepts only loopback hosts)', async () => {
    await probeHttp(`${base}/ok`, { hostHeader: '127.0.0.1:4318', timeoutMs: 1000 });
    expect(seenHosts.at(-1)).toBe('127.0.0.1:4318');
  });
});

describe('createProbes', () => {
  it('unconfigured http targets are null; disk and runtime return sane numbers; bad path gives null disk', async () => {
    const p = createProbes({ diskPath: tmpdir(), dashboardUrl: null, tailscaleUrl: null, timeoutMs: 500 });
    try {
      expect(await p.http('dashboard')).toBeNull();
      expect(await p.http('tailscale')).toBeNull();
      const d = p.disk();
      expect(d).not.toBeNull();
      expect(d!.usedPct).toBeGreaterThan(0);
      expect(d!.usedPct).toBeLessThanOrEqual(100);
      expect(d!.freeBytes).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 60)); // event-loop histogramma namunalari
      const rt = p.runtime();
      expect(rt.rssBytes).toBeGreaterThan(0);
      expect(rt.heapUsedPct).toBeGreaterThan(0);
      expect(rt.lagP99Ms === null || rt.lagP99Ms >= 0).toBe(true);
    } finally {
      p.stop();
    }
    const bad = createProbes({ diskPath: '/definitely/not/here', dashboardUrl: `${base}/ok`, tailscaleUrl: `${base}/boom`, timeoutMs: 500 });
    try {
      expect(bad.disk()).toBeNull();
      expect(await bad.http('dashboard')).toBe(true);
      expect(await bad.http('tailscale')).toBe(false);
    } finally {
      bad.stop();
    }
  });
});
