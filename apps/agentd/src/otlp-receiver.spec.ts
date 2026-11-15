import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from './logger.js';
import { OTLP_MAX_BODY_BYTES, OTLP_TOKEN_HEADER, OtlpReceiver, isLoopbackHostHeader, type OtlpReceiverOptions } from './otlp-receiver.js';
import type { ParsedApiRequest } from './otlp.js';

const fixture = readFileSync(new URL('../test/fixtures/otlp-logs-api-request.json', import.meta.url), 'utf8');
const open: OtlpReceiver[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.stop()));
});

async function start(opts?: OtlpReceiverOptions) {
  const got: ParsedApiRequest[] = [];
  const r = new OtlpReceiver(0, (reqs) => got.push(...reqs), silentLogger, opts);
  open.push(r);
  const port = await r.start();
  return { got, base: `http://127.0.0.1:${port}`, r };
}

const post = (url: string, body: BodyInit, headers: Record<string, string> = { 'content-type': 'application/json' }) => fetch(url, { method: 'POST', headers, body });

describe('OtlpReceiver', () => {
  it('/v1/logs: api_request qabul qilinadi, 200 {}', async () => {
    const { got, base } = await start();
    const res = await post(`${base}/v1/logs`, fixture);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(got).toHaveLength(1);
    expect(got[0]!.record.requestId).toBe('req_TESTFIXTURE00000000000001');
  });

  it("/v1/metrics qabul qilinadi va e'tiborsiz (200)", async () => {
    const { got, base } = await start();
    const res = await post(`${base}/v1/metrics`, '{"resourceMetrics":[]}');
    expect(res.status).toBe(200);
    expect(got).toHaveLength(0);
  });

  it('gzip tana qo\'llab-quvvatlanadi', async () => {
    const { got, base } = await start();
    const res = await post(`${base}/v1/logs`, gzipSync(fixture), { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(got).toHaveLength(1);
  });

  it("protobuf 415, noto'g'ri JSON 400, noma'lum yo'l 404, GET 405", async () => {
    const { base } = await start();
    expect((await post(`${base}/v1/logs`, 'x', { 'content-type': 'application/x-protobuf' })).status).toBe(415);
    expect((await post(`${base}/v1/logs`, '{bad')).status).toBe(400);
    expect((await post(`${base}/v2/other`, '{}')).status).toBe(404);
    expect((await fetch(`${base}/v1/logs`)).status).toBe(405);
  });

  it('tana hajmi cheklangan (413)', async () => {
    const { base } = await start();
    const big = '{"x":"' + 'a'.repeat(OTLP_MAX_BODY_BYTES + 10) + '"}';
    let status = 0;
    try {
      status = (await post(`${base}/v1/logs`, big)).status;
    } catch {
      status = 413; // server ulanishni uzishi ham chegara ishlaganini bildiradi
    }
    expect(status).toBe(413);
  });
});

describe('OtlpReceiver: token va brauzer himoyasi (M-20)', () => {
  const TOKEN = 'tok_' + 'a'.repeat(40);
  const json = { 'content-type': 'application/json' };

  it("to'g'ri token: qabul; noto'g'ri token: 401 (moslik rejimida ham); hisoblagichlar", async () => {
    const { got, base, r } = await start({ token: TOKEN });
    expect((await post(`${base}/v1/logs`, fixture, { ...json, [OTLP_TOKEN_HEADER]: TOKEN })).status).toBe(200);
    expect(got).toHaveLength(1);
    expect((await post(`${base}/v1/logs`, fixture, { ...json, [OTLP_TOKEN_HEADER]: 'wrong' + TOKEN })).status).toBe(401);
    expect(got).toHaveLength(1);
    expect(r.counters).toMatchObject({ accepted: 1, rejected: 1, unauthenticated: 0 });
  });

  it("token sarlavhasiz: moslik rejimida qabul + 'unauthenticated' hisoblagich; strict'da 401", async () => {
    const compat = await start({ token: TOKEN });
    expect((await post(`${compat.base}/v1/logs`, fixture)).status).toBe(200);
    expect(compat.got).toHaveLength(1);
    expect(compat.r.counters.unauthenticated).toBe(1);

    const strict = await start({ token: TOKEN, strict: true });
    expect((await post(`${strict.base}/v1/logs`, fixture)).status).toBe(401);
    expect(strict.got).toHaveLength(0);
  });

  it("Origin bor so'rov (brauzer) 403, content-type text/plain 415 (no-cors POST)", async () => {
    const { got, base } = await start({ token: TOKEN });
    expect((await fetch(`${base}/v1/logs`, { method: 'POST', headers: { ...json, origin: 'https://evil.example', [OTLP_TOKEN_HEADER]: TOKEN }, body: fixture })).status).toBe(403);
    expect((await post(`${base}/v1/logs`, fixture, { 'content-type': 'text/plain', [OTLP_TOKEN_HEADER]: TOKEN })).status).toBe(415);
    expect(got).toHaveLength(0);
  });

  it('Host sarlavhasi loopback bo\'lishi shart (DNS rebinding)', () => {
    expect(isLoopbackHostHeader('127.0.0.1:4319')).toBe(true);
    expect(isLoopbackHostHeader('localhost:4319')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:4319')).toBe(true);
    expect(isLoopbackHostHeader('evil.com:4319')).toBe(false);
    expect(isLoopbackHostHeader('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });
});
