import { describe, expect, it } from 'vitest';
import { buildClaudeCommand } from './claude-exec.js';

describe('buildClaudeCommand', () => {
  it("POSIX: to'g'ridan-to'g'ri, shell yo'q", () => {
    expect(buildClaudeCommand('/usr/local/bin/claude', ['agents', '--json'], 'linux', undefined)).toEqual({ file: '/usr/local/bin/claude', args: ['agents', '--json'], options: {} });
    expect(buildClaudeCommand('/opt/claude.cmd', ['--version'], 'darwin', undefined).file).toBe('/opt/claude.cmd');
  });

  it("Windows .exe: to'g'ridan-to'g'ri", () => {
    expect(buildClaudeCommand('C:\\Users\\a\\claude.exe', ['--version'], 'win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
      file: 'C:\\Users\\a\\claude.exe',
      args: ['--version'],
      options: {},
    });
  });

  it('Windows .cmd: cmd.exe /d /s /c, bo\'sh joyli yo\'l ham to\'g\'ri o\'ralgan', () => {
    const c = buildClaudeCommand('C:\\Program Files\\x y\\claude.cmd', ['agents', '--json'], 'win32', 'C:\\Windows\\System32\\cmd.exe');
    expect(c.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(c.args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\x y\\claude.cmd" agents --json"']);
    expect(c.options.windowsVerbatimArguments).toBe(true);
    expect(buildClaudeCommand('C:\\a\\CLAUDE.CMD', ['--version'], 'win32', undefined).file).toBe('cmd.exe');
  });

  it("shell-injection: xavfli yo'l va argumentlar rad etiladi", () => {
    for (const bad of ['C:\\a" & calc & "\\claude.cmd', 'C:\\a\\%PATH%\\claude.cmd', 'C:\\a&b\\claude.cmd', 'C:\\a|b\\claude.cmd', 'C:\\a^b\\claude.cmd', 'C:\\a\nb\\claude.cmd']) {
      expect(() => buildClaudeCommand(bad, ['--version'], 'win32', undefined)).toThrow();
    }
    expect(() => buildClaudeCommand('C:\\a\\claude.cmd', ['agents', '& calc'], 'win32', undefined)).toThrow();
    expect(() => buildClaudeCommand('C:\\a\\claude.cmd', ['--json;x'], 'win32', undefined)).toThrow();
  });
});
