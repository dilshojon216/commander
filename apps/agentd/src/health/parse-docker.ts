import type { ContainerHealth, HealthContainer } from '@commander/contracts';

/** Image nomidagi `user:pass@` (registry hisob ma'lumoti) olib tashlanadi. */
export function sanitizeImage(image: string): string {
  return image.replace(/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/@\s]+@/i, '').slice(0, 256);
}

const HEALTH_FROM_STATUS = /\((healthy|unhealthy|health: starting)\)/i;

export function healthFromStatus(status: string): ContainerHealth {
  const m = HEALTH_FROM_STATUS.exec(status)?.[1]?.toLowerCase();
  if (m === 'healthy') return 'healthy';
  if (m === 'unhealthy') return 'unhealthy';
  if (m) return 'starting';
  return 'none';
}

export interface PsRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

/**
 * `docker ps -a --format '{{json .}}'`: har qator alohida JSON. FAQAT ID, Names, Image, State, Status o'qiladi
 * (Labels, Ports, Mounts, Command e'tiborsiz: ularda sirlar bo'lishi mumkin). Buzuq qatorlar o'tkazib yuboriladi.
 */
export function parseDockerPs(stdout: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const id = typeof o['ID'] === 'string' ? o['ID'] : '';
      const names = typeof o['Names'] === 'string' ? o['Names'] : '';
      const name = (names.split(',')[0] ?? '').replace(/^\//, '').trim();
      const image = typeof o['Image'] === 'string' ? o['Image'] : '';
      const status = typeof o['Status'] === 'string' ? o['Status'] : '';
      const state = (typeof o['State'] === 'string' && o['State'] ? o['State'] : status.split(/\s+/)[0] ?? '').toLowerCase();
      if (!id || !name || !image || !state) continue;
      out.push({ id, name: name.slice(0, 128), image: sanitizeImage(image), state: state.slice(0, 32), status: status.slice(0, 160) });
    } catch {
      /* buzuq qator */
    }
  }
  return out;
}

export interface InspectRow {
  id: string;
  restartCount: number;
  health: ContainerHealth;
}

/** `docker inspect --format '{{.Id}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'`. */
export const INSPECT_FORMAT = '{{.Id}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}';

export function parseDockerInspect(stdout: string): InspectRow[] {
  const out: InspectRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([0-9a-f]{12,64})\|(\d+)\|(\w*)\s*$/i.exec(line.trim());
    if (!m) continue;
    const h = (m[3] as string).toLowerCase();
    out.push({ id: m[1] as string, restartCount: Number(m[2]), health: h === 'healthy' ? 'healthy' : h === 'unhealthy' ? 'unhealthy' : h === 'starting' ? 'starting' : 'none' });
  }
  return out;
}

/** ps (qisqa ID) va inspect (to'liq ID) qatorlarini ID prefiksi bo'yicha birlashtiradi; inspect yo'q bo'lsa Status'dan taxmin. */
export function mergeContainers(ps: PsRow[], inspect: InspectRow[]): HealthContainer[] {
  return ps.map((p) => {
    const i = inspect.find((x) => x.id.startsWith(p.id) || p.id.startsWith(x.id));
    return { name: p.name, image: p.image, state: p.state, status: p.status, restartCount: i?.restartCount ?? 0, health: i?.health ?? healthFromStatus(p.status) };
  });
}
