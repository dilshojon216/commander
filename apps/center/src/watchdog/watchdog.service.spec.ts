import { describe, expect, it } from 'vitest';
import { formatAlertText, toAlertDto } from './watchdog.service.js';

describe('Telegram ogohlantirish matni', () => {
  const dto = { kind: 'burn' as const, title: 'G\'ayritabiiy token sarfi', detail: 'Oxirgi 10 daqiqada 5.2M', projectName: 'a<b>&c', sessionName: 'abcd1234', autoStopped: false };

  it('HTML escape qilinadi, eslatma raqami va avto-stop belgisi', () => {
    const t = formatAlertText(dto, null);
    expect(t).toContain('🔥 <b>G\'ayritabiiy token sarfi</b>');
    expect(t).toContain('a&lt;b&gt;&amp;c · abcd1234');
    expect(formatAlertText(dto, 2)).toContain('(eslatma 2)');
    expect(formatAlertText({ ...dto, autoStopped: true }, null)).toContain('Avtomatik to\'xtatish');
    expect(t.length).toBeLessThan(4096);
  });

  it('toAlertDto: sessiya nomi bo\'lmasa Claude id\'sining boshi', () => {
    const d = toAlertDto({
      id: 'x', kind: 'waiting', state: 'open', session_id: 's', machine_id: 'm', project_id: null, episode_key: '1', title: 't', detail: 'd', payload: { minutes: 3 },
      reminders_sent: 0, last_notified_at: null, auto_stopped: false, created_at: new Date(0), updated_at: new Date(0), resolved_at: null, session_name: null, project_name: 'p', claude_session_id: 'abcdefgh-1234',
    });
    expect(d.sessionName).toBe('abcdefgh');
    expect(d.createdAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
