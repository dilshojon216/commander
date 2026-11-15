import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { MachineDtoSchema } from '@commander/contracts';
import { MachinesService, toMachineDto } from './machines.service.js';

const row = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', slug: 'mac', display_name: null, hostname: 'h', os: 'darwin', online: true, last_seen_at: null, connected_at: null,
  disconnected_at: null, agentd_version: '0.1.0', claude_version: '2.1.0', identity_status: 'verified', control: null, archived_at: null,
  open: 1, working: 1, waiting: 0, awaiting_approval: 0, idle: 0, done: 0, ...over,
});

function svc(rows: unknown[]) {
  const query = vi.fn(async (..._args: unknown[]) => rows);
  return { s: new MachinesService({ query } as unknown as DataSource, { get: () => 720 } as unknown as ConfigService), query };
}

describe('MachinesService arxiv filtri (N2.14)', () => {
  it('toMachineDto: archivedAt ISO yoki null, sxemaga mos', () => {
    expect(toMachineDto(row() as never).archivedAt).toBeNull();
    const dto = toMachineDto(row({ archived_at: new Date('2026-11-15T10:00:00.000Z') }) as never);
    expect(dto.archivedAt).toBe('2026-11-15T10:00:00.000Z');
    expect(MachineDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('list(): default faqat faollar ($2=false), archived=true faqat arxivlanganlar', async () => {
    const a = svc([row()]);
    await a.s.list();
    expect(a.query.mock.calls[0]![1]).toEqual([expect.any(Date), false]);
    expect((a.query.mock.calls[0]! as unknown as [string])[0]).toContain('(m.archived_at IS NOT NULL) = $2::boolean');
    const b = svc([row({ archived_at: new Date() })]);
    const res = await b.s.list(new Date(), true);
    expect(b.query.mock.calls[0]![1]).toEqual([expect.any(Date), true]);
    expect(res.items[0]!.archivedAt).not.toBeNull();
  });

  it('findById arxiv bo\'yicha filtrlamaydi (machine.updated push arxivlanganni ham yuboradi)', async () => {
    const a = svc([row({ archived_at: new Date() })]);
    const m = await a.s.findById('x');
    expect(m?.archivedAt).not.toBeNull();
    expect((a.query.mock.calls[0]! as unknown as [string])[0]).not.toContain('archived_at IS');
  });
});
