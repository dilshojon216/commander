import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RC_NAME_RE, RC_URL_RE } from '@commander/contracts';
import type { CommandErrorCode, RemoteControlResult } from '@commander/contracts';
import type { TmuxStep, TmuxTarget } from './tmux.js';

/**
 * Remote Control (3.10, Claude Code 2.1.304, macOS: jonli tekshirilgan, PLAN ADR "3.10").
 *
 * Faktlar:
 *  - tmux sessiyada `/remote-control [nom]` + Enter RC'ni YOQADI: pane'da `/remote-control is active · Continue here, on your phone,
 *    or at` va keyingi qatorda `https://claude.ai/code/session_...`; sarlavhada `/rc` belgisi; `~/.claude/sessions/<pid>.json` ga
 *    `bridgeSessionId` yoziladi;
 *  - RC yoniq paytda `/remote-control` TOGGLE EMAS: dialog ochadi (`Disconnect this session` / `Show QR code` / `Continue`, kursor `Continue`da).
 *    O'chirish = Up (kursor `Disconnect`ga), Enter; natija `Remote Control disconnected.` va `bridgeSessionId` yo'qoladi;
 *  - `claude --bg --remote-control [nom] ...` bg sessiyani RC bilan ochadi (`bridgeSessionId` faylda paydo bo'ladi);
 *  - `claude remote-control -c` boshqa (bg/interaktiv) sessiyani qayta biriktirMAYDI (faqat o'zi yozgan sessiyani): ishlatilmaydi.
 *
 * Maxfiylik: pane matnidan FAQAT RC holat qatori (ekran turi, kursor, claude.ai/code havolasi) olinadi; xom matn hech qayerga
 * yuborilmaydi va logga yozilmaydi.
 */

export type RcCursor = 'disconnect' | 'qr' | 'continue';

export type RcScreen =
  | { screen: 'menu'; cursor: RcCursor | null; url: string | null }
  | { screen: 'active'; url: string | null }
  | { screen: 'disconnected' }
  | { screen: 'other' };

const URL_FIND_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}/;
const MENU_RE = /Disconnect this session/;
const CURSOR_RE = /^[ \t]*[❯>][ \t]*(Disconnect this session|Show QR code|Continue)\b/m;
const ACTIVE_MARK = '/remote-control is active';
const DISCONNECTED_MARK = 'Remote Control disconnected';

function validUrl(text: string): string | null {
  const m = URL_FIND_RE.exec(text);
  return m && RC_URL_RE.test(m[0]) ? m[0] : null;
}

/** `tmux capture-pane -p -J` chiqishidan RC ekranini aniqlaydi (sof). Dialog ochiq bo'lsa u ustun; aks holda oxirgi RC xabari. */
export function classifyRcPane(pane: string): RcScreen {
  if (MENU_RE.test(pane)) {
    const c = CURSOR_RE.exec(pane)?.[1];
    const cursor: RcCursor | null = c === 'Disconnect this session' ? 'disconnect' : c === 'Show QR code' ? 'qr' : c === 'Continue' ? 'continue' : null;
    return { screen: 'menu', cursor, url: validUrl(pane) };
  }
  const a = pane.lastIndexOf(ACTIVE_MARK);
  const d = pane.lastIndexOf(DISCONNECTED_MARK);
  if (a < 0 && d < 0) return { screen: 'other' };
  if (a > d) return { screen: 'active', url: validUrl(pane.slice(a)) };
  return { screen: 'disconnected' };
}

// --- sessiya fayli (`<pid>.json`): faqat `bridgeSessionId` -----------------------------------------

const BRIDGE_ID_RE = /^session_[A-Za-z0-9]{8,64}$/;

export function parseBridgeSessionId(json: string): string | null {
  try {
    const v: unknown = JSON.parse(json);
    const id = typeof v === 'object' && v !== null ? (v as { bridgeSessionId?: unknown }).bridgeSessionId : undefined;
    return typeof id === 'string' && BRIDGE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export const bridgeUrl = (bridgeSessionId: string): string => `https://claude.ai/code/${bridgeSessionId}`;

/** Sessiya fayli holati: `known=false` = fayl o'qilmadi (holat noma'lum); `known=true, id=null` = fayl bor, RC yoqilmagan. */
export interface BridgeState {
  known: boolean;
  id: string | null;
}

/** `<claude config>/sessions/<pid>.json` dan RC bridge id. */
export function readBridgeState(pid: number, configDir: string = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): BridgeState {
  try {
    const text = readFileSync(join(configDir, 'sessions', `${pid}.json`), 'utf8');
    JSON.parse(text);
    return { known: true, id: parseBridgeSessionId(text) };
  } catch {
    return { known: false, id: null };
  }
}

export function readBridgeSessionId(pid: number, configDir?: string): string | null {
  return readBridgeState(pid, configDir).id;
}

// --- tmux rejalari -----------------------------------------------------------------------------------

/** Nom faqat xavfsiz belgilar bilan (argumentga `-l` literal sifatida boradi); noto'g'ri nom = `null`. */
export function safeRcName(name: string | undefined): string | null | undefined {
  if (name === undefined) return undefined;
  return RC_NAME_RE.test(name) ? name : null;
}

/**
 * `/remote-control [nom]` + Enter. Nom yo'q = oxirida BO'SH JOY bilan: jonli tekshirilgan (CC 2.1.304) — argumentsiz `/remote-control` +
 * Enter autocomplete oynasi tomonidan "yeb qo'yiladi" (matn kiritish qatorida qoladi, buyruq bajarilmaydi), probel bilan bitta Enter yetadi.
 */
export function planRcCommandSteps(paneId: string, name?: string): TmuxStep[] {
  const text = name ? `/remote-control ${name}` : '/remote-control ';
  return [{ args: ['send-keys', '-t', paneId, '-l', '--', text] }, { args: ['send-keys', '-t', paneId, 'Enter'] }];
}

export const planRcKeyStep = (paneId: string, key: 'Up' | 'Enter' | 'Escape' | 'C-u'): TmuxStep[] => [{ args: ['send-keys', '-t', paneId, key] }];

// --- yoqish/o'chirish oqimi --------------------------------------------------------------------------

export interface RcOutcome {
  ok: boolean;
  result?: RemoteControlResult;
  detail?: string;
  code?: CommandErrorCode;
  message?: string;
}

export interface RcToggleDeps {
  /** Tekshirilgan (yangi) pane; xato = `out`. */
  capture(target: TmuxTarget): Promise<string>;
  run(target: TmuxTarget, steps: TmuxStep[], betweenMs?: number): Promise<void>;
  /** `<pid>.json` holati (RC yoqilgan bo'lsa bridge id). */
  bridge(): BridgeState;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Matn yozilgandan keyin Enter'dan oldin kutish (autocomplete oynasi chiqib ulgursin). */
  typeSettleMs?: number;
  pollMs?: number;
  timeoutMs?: number;
}

/** Remote Control holati tasdiqlanishini kutish chegarasi. */
export const RC_WAIT_MS = 45_000;

const fail = (code: CommandErrorCode, message: string): RcOutcome => ({ ok: false, code, message });

/**
 * Hozirgi holat: avval sessiya fayli (ishonchli), bo'lmasa pane. `unknown` bo'lsa oqim har qadamdan keyin pane'ni o'qib to'g'rilaydi.
 */
async function currentState(d: RcToggleDeps, target: TmuxTarget): Promise<{ enabled: boolean | null; url: string | null; menu: boolean }> {
  const pane = classifyRcPane(await d.capture(target));
  if (pane.screen === 'menu') return { enabled: true, url: pane.url, menu: true };
  const b = d.bridge();
  // Sessiya fayli o'qilsa FAQAT u hal qiladi (CC 2.1.304: RC yoqilganda `bridgeSessionId` doim yoziladi, o'chirilganda yo'qoladi);
  // pane'dagi eski "is active" / "disconnected" xabarlari ekranda qolib ketadi va ishonchsiz.
  if (b.known) return { enabled: b.id !== null, url: b.id ? bridgeUrl(b.id) : null, menu: false };
  if (pane.screen === 'active') return { enabled: true, url: pane.url, menu: false };
  if (pane.screen === 'disconnected') return { enabled: false, url: null, menu: false };
  return { enabled: null, url: null, menu: false };
}

async function waitFor<T>(d: RcToggleDeps, probe: () => Promise<T | null>): Promise<T | null> {
  // 12 s qisqa edi: uzun tarixli (resume qilingan) sessiyada claude.ai'ga ulanish sekinroq (2026-11-14 testserver'da
  // `remote_control_unverified`). Natija topilishi bilan qaytadi, shuning uchun uzun kutish tez holatni sekinlashtirmaydi.
  const deadline = d.now() + (d.timeoutMs ?? RC_WAIT_MS);
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (d.now() >= deadline) return null;
    await d.sleep(d.pollMs ?? 400);
  }
}

/**
 * tmux sessiyada RC'ni `enable`ga keltiradi. Idempotent: allaqachon shu holatda bo'lsa hech narsa yuborilmaydi.
 * Har qadamdan keyin pane/fayl bilan TASDIQLANADI; tasdiqlanmasa `remote_control_unverified` (holat taxmin qilinmaydi).
 */
export async function toggleRemoteControl(d: RcToggleDeps, target: TmuxTarget, enable: boolean, name?: string): Promise<RcOutcome> {
  const st = await currentState(d, target);
  if (st.menu) {
    // Dialog allaqachon ochiq (oldingi urinish/foydalanuvchi): Escape bilan yopamiz. RC yoniq ekani aniq.
    await d.run(target, planRcKeyStep(target.paneId, 'Escape'));
    await d.sleep(d.pollMs ?? 400);
    if (enable) return { ok: true, detail: 'already enabled', result: { enabled: true, url: st.url } };
  } else if (st.enabled === enable) {
    return { ok: true, detail: enable ? 'already enabled' : 'already disabled', result: enable ? { enabled: true, url: st.url } : { enabled: false } };
  }

  const base = enable ? planRcCommandSteps(target.paneId, name) : planRcCommandSteps(target.paneId);
  const typeSettle = d.typeSettleMs ?? 600;

  if (enable) {
    await d.run(target, base, typeSettle);
    // Pane'dagi eski "is active" xabari tasdiq emas (ekranda qolib ketadi): sessiya fayli o'qilsa FAQAT u hal qiladi.
    const seen = await waitFor<{ url: string | null } | 'menu'>(d, async () => {
      const b = d.bridge();
      const p = classifyRcPane(await d.capture(target));
      if (p.screen === 'menu') return 'menu';
      if (b.known) return b.id ? { url: p.screen === 'active' && p.url ? p.url : bridgeUrl(b.id) } : null;
      return p.screen === 'active' ? { url: p.url } : null;
    });
    if (seen === 'menu') {
      // RC aslida yoniq edi (holat noma'lum bo'lgan): dialog chiqdi. Yopamiz, holat = yoniq.
      const url = classifyRcPane(await d.capture(target));
      await d.run(target, planRcKeyStep(target.paneId, 'Escape'));
      return { ok: true, detail: 'already enabled', result: { enabled: true, url: url.screen === 'menu' ? url.url : null } };
    }
    if (!seen) {
      await d.run(target, planRcKeyStep(target.paneId, 'C-u')); // buyruq bajarilmay kiritish qatorida qolgan bo'lsa tozalaymiz
      return fail('remote_control_unverified', 'Remote Control did not report as active (is the session logged in with claude.ai?)');
    }
    return { ok: true, detail: 'enabled', result: { enabled: true, name: name ?? null, url: seen.url } };
  }

  // o'chirish: `/remote-control` -> dialog -> kursor `Disconnect`ga -> Enter.
  // Pane'dagi eski "is active" xabari ekranda qoladi: yoniqligi ma'lum bo'lsa FAQAT dialog (menu) kutiladi. Holat noma'lum bo'lgan
  // va dialog chiqmagan holda (aslida o'chiq edi, buyruq yoqib qo'ydi) buyruq yana bir marta yuboriladi.
  await d.run(target, base, typeSettle);
  const menuProbe = async (): Promise<RcScreen | null> => {
    const p = classifyRcPane(await d.capture(target));
    return p.screen === 'menu' ? p : null;
  };
  let first = await waitFor<RcScreen>(d, menuProbe);
  if (!first && st.enabled === null) {
    await d.run(target, planRcCommandSteps(target.paneId), typeSettle);
    first = await waitFor<RcScreen>(d, menuProbe);
  }
  if (!first) {
    await d.run(target, planRcKeyStep(target.paneId, 'C-u'));
    return fail('remote_control_unverified', 'The Remote Control dialog did not appear');
  }
  for (let i = 0; i < 4; i++) {
    // Dialog yarim chizilgan paytda (sarlavha bor, kursor qatori hali yo'q) kutamiz: kursor aniq bo'lgandagina qaror.
    const p = await waitFor<Extract<RcScreen, { screen: 'menu' }>>(d, async () => {
      const x = classifyRcPane(await d.capture(target));
      return x.screen === 'menu' && x.cursor !== null ? x : null;
    });
    if (!p || p.cursor === null) {
      await d.run(target, planRcKeyStep(target.paneId, 'Escape'));
      return fail('remote_control_unverified', 'Could not read the Remote Control dialog');
    }
    if (p.cursor === 'disconnect') {
      await d.run(target, planRcKeyStep(target.paneId, 'Enter'));
      const done = await waitFor<true>(d, async () => {
        const b = d.bridge();
        if (b.known) return b.id === null ? true : null;
        return classifyRcPane(await d.capture(target)).screen === 'disconnected' ? true : null;
      });
      return done ? { ok: true, detail: 'disabled', result: { enabled: false } } : fail('remote_control_unverified', 'Remote Control did not report as disconnected');
    }
    await d.run(target, planRcKeyStep(target.paneId, 'Up'));
    await d.sleep(d.pollMs ?? 400);
  }
  await d.run(target, planRcKeyStep(target.paneId, 'Escape'));
  return fail('remote_control_failed', 'Could not move to "Disconnect this session"');
}
