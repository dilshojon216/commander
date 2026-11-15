import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgeUrl, classifyRcPane, parseBridgeSessionId, planRcCommandSteps, readBridgeSessionId, safeRcName, toggleRemoteControl } from './remote-control.js';
import type { RcToggleDeps } from './remote-control.js';
import type { TmuxStep, TmuxTarget } from './tmux.js';

// Haqiqiy pane namunalari (Claude Code 2.1.304, macOS, 2026-11-13; yon panel `│ ...` ham shu yerda: parser unga e'tibor bermaydi).
const URL = 'https://claude.ai/code/session_01Lb25s1rUPNVGEwNscyZi6y';
const ACTIVE = `
 ▝▝   ▝▝   ~/working/_rc_spike · /rc                                                             │
  ⎿  SessionStart:startup says: ○○○ Semgrep Guardian (x): this session is protected             │
❯ /remote-control                                                                                │
  /remote-control is active · Continue here, on your phone, or at                                │
  ${URL}                                         │
 ◐ medium · /effort
`;
const menu = (cursor: 'Disconnect this session' | 'Show QR code' | 'Continue'): string => `
❯ /remote-control
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Remote Control
   This session is available in the Claude mobile app and at ${URL}
${['Disconnect this session', 'Show QR code', 'Continue'].map((l) => `${l === cursor ? '   ❯' : '    '} ${l}${l === 'Show QR code' ? '   Scan with your phone to open this session' : ''}`).join('\n')}
   Enter to select · Esc to continue
`;
const DISCONNECTED = `
❯ /remote-control
❯ /remote-control
  ⎿  Remote Control disconnected.
 ◐ medium · /effort
`;

describe('classifyRcPane (haqiqiy pane namunalari)', () => {
  it('yoqildi: ekran active + havola', () => {
    expect(classifyRcPane(ACTIVE)).toEqual({ screen: 'active', url: URL });
  });
  it('dialog: kursor holati', () => {
    expect(classifyRcPane(menu('Continue'))).toEqual({ screen: 'menu', cursor: 'continue', url: URL });
    expect(classifyRcPane(menu('Show QR code'))).toMatchObject({ screen: 'menu', cursor: 'qr' });
    expect(classifyRcPane(menu('Disconnect this session'))).toMatchObject({ screen: 'menu', cursor: 'disconnect' });
  });
  it('o\'chirildi', () => {
    expect(classifyRcPane(DISCONNECTED)).toEqual({ screen: 'disconnected' });
  });
  it('oxirgi xabar yutadi (avval yoqilgan, keyin o\'chirilgan)', () => {
    expect(classifyRcPane(`${ACTIVE}\n${DISCONNECTED}`).screen).toBe('disconnected');
    expect(classifyRcPane(`${DISCONNECTED}\n${ACTIVE}`).screen).toBe('active');
  });
  it('begona matn / begona havola: other yoki url=null (hech narsa qaytmaydi)', () => {
    expect(classifyRcPane('hello\nworld')).toEqual({ screen: 'other' });
    expect(classifyRcPane('/remote-control is active\nhttps://evil.example/code/session_abcdefgh12')).toEqual({ screen: 'active', url: null });
    expect(classifyRcPane('/remote-control is active\nhttps://claude.ai/code/session_abc')).toEqual({ screen: 'active', url: null });
  });
  it('natijada faqat ekran turi, kursor va havola bor (pane matni sizib chiqmaydi)', () => {
    const r = classifyRcPane(ACTIVE);
    expect(Object.keys(r).sort()).toEqual(['screen', 'url']);
    expect(JSON.stringify(classifyRcPane(menu('Continue')))).not.toContain('Semgrep');
  });
});

describe('sessiya fayli va nom', () => {
  it('bridgeSessionId faqat yaroqli formatda', () => {
    expect(parseBridgeSessionId('{"pid":1,"bridgeSessionId":"session_01Lb25s2Dn3M6hUHbx2evC6F"}')).toBe('session_01Lb25s2Dn3M6hUHbx2evC6F');
    expect(parseBridgeSessionId('{"pid":1}')).toBeNull();
    expect(parseBridgeSessionId('{"bridgeSessionId":"../etc/passwd"}')).toBeNull();
    expect(parseBridgeSessionId('not json')).toBeNull();
    expect(bridgeUrl('session_01Lb25s2Dn3M6hUHbx2evC6F')).toBe('https://claude.ai/code/session_01Lb25s2Dn3M6hUHbx2evC6F');
  });
  it('readBridgeSessionId: fayl o\'qiladi, yo\'q bo\'lsa null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-'));
    try {
      mkdirSync(join(dir, 'sessions'));
      writeFileSync(join(dir, 'sessions', '42.json'), '{"bridgeSessionId":"session_01Lb25s2Dn3M6hUHbx2evC6F","name":"x"}');
      expect(readBridgeSessionId(42, dir)).toBe('session_01Lb25s2Dn3M6hUHbx2evC6F');
      expect(readBridgeSessionId(43, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('safeRcName va tmux rejasi (nom literal -l bilan, shell yo\'q)', () => {
    expect(safeRcName(undefined)).toBeUndefined();
    expect(safeRcName('my rc-1')).toBe('my rc-1');
    expect(safeRcName('x; rm -rf /')).toBeNull();
    expect(safeRcName('/exit')).toBeNull();
    expect(planRcCommandSteps('%4', 'my rc')).toEqual([{ args: ['send-keys', '-t', '%4', '-l', '--', '/remote-control my rc'] }, { args: ['send-keys', '-t', '%4', 'Enter'] }]);
    expect(planRcCommandSteps('%4')[0]?.args.at(-1)).toBe('/remote-control '); // oxirgi probel: autocomplete Enter'ni yutmasin
  });
});

// --- soxta TUI: haqiqiy xatti-harakat (yoniq paytda /remote-control = dialog) ------------------------------------

function fakeTui(init: { enabled: boolean; knownByFile?: boolean; neverActivates?: boolean }) {
  const s = { enabled: init.enabled, menu: false, cursor: 'continue' as 'disconnect' | 'qr' | 'continue', typed: '', lastMsg: '' as '' | 'active' | 'disconnected', keys: [] as string[] };
  let t = 0;
  const cursors = ['disconnect', 'qr', 'continue'] as const;
  const deps: RcToggleDeps = {
    capture: async () => {
      if (s.menu) return menu(s.cursor === 'disconnect' ? 'Disconnect this session' : s.cursor === 'qr' ? 'Show QR code' : 'Continue');
      return s.lastMsg === 'active' ? ACTIVE : s.lastMsg === 'disconnected' ? DISCONNECTED : 'prompt idle';
    },
    run: async (_t: TmuxTarget, steps: TmuxStep[]) => {
      for (const st of steps) {
        const a = st.args;
        if (a.includes('-l')) s.typed = (a.at(-1) ?? '').trimEnd();
        else if (a.at(-1) === 'Enter') {
          if (s.menu) {
            if (s.cursor === 'disconnect') {
              s.enabled = false;
              s.lastMsg = 'disconnected';
            }
            s.menu = false;
            s.keys.push('Enter');
          } else if (s.typed.startsWith('/remote-control')) {
            if (s.enabled) {
              s.menu = true;
              s.cursor = 'continue';
            } else if (!init.neverActivates) {
              s.enabled = true;
              s.lastMsg = 'active';
            }
            s.typed = '';
            s.keys.push('cmd');
          }
        } else if (a.at(-1) === 'Up') {
          s.cursor = cursors[Math.max(0, cursors.indexOf(s.cursor) - 1)]!;
          s.keys.push('Up');
        } else if (a.at(-1) === 'Escape') {
          s.menu = false;
          s.keys.push('Esc');
        } else if (a.at(-1) === 'C-u') {
          s.typed = '';
          s.keys.push('C-u');
        }
      }
    },
    bridge: () => ({ known: init.knownByFile !== false, id: s.enabled && init.knownByFile !== false ? 'session_01Lb25s1rUPNVGEwNscyZi6y' : null }),
    sleep: async (ms) => void (t += ms),
    now: () => t,
    typeSettleMs: 0,
    pollMs: 100,
    timeoutMs: 1000,
  };
  return { s, deps };
}
const TARGET: TmuxTarget = { socket: '/tmp/x', paneId: '%4', label: 's:0.0' };

describe('toggleRemoteControl', () => {
  it('yoqish: o\'chiq -> /remote-control -> active, havola qaytadi', async () => {
    const { s, deps } = fakeTui({ enabled: false });
    expect(await toggleRemoteControl(deps, TARGET, true, 'my-rc')).toEqual({ ok: true, detail: 'enabled', result: { enabled: true, name: 'my-rc', url: URL } });
    expect(s.typed === '' && s.keys).toEqual(['cmd']);
  });
  it('yoqish idempotent: allaqachon yoniq bo\'lsa hech narsa yuborilmaydi', async () => {
    const { s, deps } = fakeTui({ enabled: true });
    const out = await toggleRemoteControl(deps, TARGET, true);
    expect(out).toMatchObject({ ok: true, detail: 'already enabled', result: { enabled: true } });
    expect(s.keys).toEqual([]);
  });
  it('o\'chirish: yoniq -> /remote-control -> dialog -> Up,Up -> Enter -> disconnected', async () => {
    const { s, deps } = fakeTui({ enabled: true });
    expect(await toggleRemoteControl(deps, TARGET, false)).toEqual({ ok: true, detail: 'disabled', result: { enabled: false } });
    expect(s.keys).toEqual(['cmd', 'Up', 'Up', 'Enter']);
    expect(s.enabled).toBe(false);
  });
  it('o\'chirish: ekranda eski "is active" xabari turgan bo\'lsa ham buyruq FAQAT bir marta yuboriladi (jonli xato: ikkinchi marta yozilib ketgan)', async () => {
    const { s, deps } = fakeTui({ enabled: true });
    s.lastMsg = 'active';
    expect(await toggleRemoteControl(deps, TARGET, false)).toMatchObject({ ok: true, detail: 'disabled' });
    expect(s.keys).toEqual(['cmd', 'Up', 'Up', 'Enter']);
    expect(s.enabled).toBe(false);
  });
  it('yoqish: ekranda eski "is active" turgan, lekin fayl bridge yo\'qligini aytsa tasdiqlanmaydi', async () => {
    const { s, deps } = fakeTui({ enabled: false, neverActivates: true });
    s.lastMsg = 'active';
    expect(await toggleRemoteControl(deps, TARGET, true)).toMatchObject({ ok: false, code: 'remote_control_unverified' });
  });
  it('o\'chirish idempotent: o\'chiq bo\'lsa hech narsa yuborilmaydi', async () => {
    const { s, deps } = fakeTui({ enabled: false });
    expect(await toggleRemoteControl(deps, TARGET, false)).toMatchObject({ ok: true, detail: 'already disabled', result: { enabled: false } });
    expect(s.keys).toEqual([]);
  });
  it('holat noma\'lum (fayl yo\'q, pane bo\'sh) + yoqish, aslida yoniq: dialog chiqadi -> Escape, holat = yoniq', async () => {
    const { s, deps } = fakeTui({ enabled: true, knownByFile: false });
    const out = await toggleRemoteControl(deps, TARGET, true);
    expect(out).toMatchObject({ ok: true, detail: 'already enabled', result: { enabled: true } });
    expect(s.keys).toEqual(['cmd', 'Esc']);
    expect(s.enabled).toBe(true);
  });
  it('holat noma\'lum + o\'chirish, aslida o\'chiq: yoqib qo\'yilib, qayta dialog orqali o\'chiriladi (yakuniy holat o\'chiq)', async () => {
    const { s, deps } = fakeTui({ enabled: false, knownByFile: false });
    const out = await toggleRemoteControl(deps, TARGET, false);
    expect(out).toMatchObject({ ok: true, detail: 'disabled' });
    expect(s.enabled).toBe(false);
  });
  it('yoqilmasa (login yo\'q) remote_control_unverified; holat taxmin qilinmaydi', async () => {
    const { s, deps } = fakeTui({ enabled: false, neverActivates: true });
    expect(await toggleRemoteControl(deps, TARGET, true)).toMatchObject({ ok: false, code: 'remote_control_unverified' });
    expect(s.keys.at(-1)).toBe('C-u'); // kiritish qatorida qolgan buyruq tozalandi
  });
  it('dialog allaqachon ochiq: yoqishda Escape bilan yopiladi va yoniq deb qaytadi', async () => {
    const { s, deps } = fakeTui({ enabled: true });
    s.menu = true;
    expect(await toggleRemoteControl(deps, TARGET, true)).toMatchObject({ ok: true, detail: 'already enabled' });
    expect(s.keys).toEqual(['Esc']);
  });
});
