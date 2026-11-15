import { describe, expect, it } from 'vitest';
import { findMatchingRule, isProtectedPath, matchGlob, normalizeTargetPath, ruleMatches, ruleStatus, underRateCap } from './approval-rules-logic.js';
import type { RuleLike } from './approval-rules-logic.js';

const NOW = new Date('2026-11-13T12:00:00Z');
const rule = (over: Partial<RuleLike> = {}): RuleLike => ({
  id: 1,
  tools: ['Edit', 'Write'],
  pathGlobs: [],
  expiresAt: new Date(NOW.getTime() + 3600_000),
  revokedAt: null,
  ...over,
});
const file = (p: string | null, inside = true) => ({ path: p, insideCwd: inside });
const m = (r: RuleLike, tool: string, target?: { path: string | null; insideCwd: boolean }) => ruleMatches(r, { toolName: tool, target }, NOW);

describe('ruleMatches: vosita ruxsat ro\'yxati va qat\'iy istisnolar', () => {
  it("ro'yxatdagi vosita cwd ichidagi yo'l bilan mos keladi", () => {
    expect(m(rule(), 'Edit', file('src/a.ts'))).toBe(true);
    expect(m(rule(), 'Write', file('new.txt'))).toBe(true);
  });
  it("qoidada yo'q vosita (Read) mos kelmaydi", () => {
    expect(m(rule(), 'Read', file('src/a.ts'))).toBe(false);
  });
  it('Bash va shell/exec ma\'noli vositalar hech qachon (qoidada yozilgan bo\'lsa ham)', () => {
    const r = rule({ tools: ['Bash', 'BashOutput', 'KillShell', 'PowerShell', 'Task', 'Agent', 'ExitPlanMode', 'WebFetch', 'mcp__sh__run_command', 'mcp__a__exec'] });
    for (const t of r.tools) expect(m(r, t, file('a'))).toBe(false);
    expect(m(r, 'bash', file('a'))).toBe(false);
  });
  it("noma'lum vosita, qoidada bo'lsa ham, mos kelmaydi (allow-list)", () => {
    expect(m(rule({ tools: ['SomethingNew'] }), 'SomethingNew', file('a'))).toBe(false);
  });
  it("aniq MCP vosita nomi mos keladi (glob'siz); boshqa MCP vosita yo'q", () => {
    const r = rule({ tools: ['mcp__figma__get_screenshot'] });
    expect(m(r, 'mcp__figma__get_screenshot')).toBe(true);
    expect(m(r, 'mcp__figma__other')).toBe(false);
    expect(m(rule({ tools: ['mcp__figma__get_screenshot'], pathGlobs: ['src/**'] }), 'mcp__figma__get_screenshot')).toBe(false);
  });
});

describe('ruleMatches: yo\'l shartlari', () => {
  it("target yo'q (eski agentd) yoki cwd tashqarisi yoki path null: mos emas", () => {
    expect(m(rule(), 'Edit')).toBe(false);
    expect(m(rule(), 'Edit', file('a.ts', false))).toBe(false);
    expect(m(rule(), 'Edit', file(null, true))).toBe(false);
    expect(m(rule(), 'Edit', file(null, false))).toBe(false);
  });
  it("markazda qayta tekshiriladi: '..', absolyut, teskari slesh, NUL", () => {
    for (const p of ['../x', 'a/../../x', '/etc/passwd', 'a\\b', 'a\0b', 'C:/x']) expect(m(rule(), 'Edit', file(p))).toBe(false);
  });
  it('glob: mos keladi / kelmaydi', () => {
    const r = rule({ pathGlobs: ['src/**/*.ts', 'docs/*.md'] });
    expect(m(r, 'Edit', file('src/a.ts'))).toBe(true);
    expect(m(r, 'Edit', file('src/deep/er/b.ts'))).toBe(true);
    expect(m(r, 'Edit', file('src/b.js'))).toBe(false);
    expect(m(r, 'Edit', file('docs/readme.md'))).toBe(true);
    expect(m(r, 'Edit', file('docs/sub/readme.md'))).toBe(false);
    expect(m(r, 'Edit', file('other/a.ts'))).toBe(false);
  });
  it("Glob/Grep katalog maqsadi glob bilan solishtiriladi ('.' faqat keng glob'ga)", () => {
    const r = rule({ tools: ['Glob', 'Grep'], pathGlobs: ['src/**'] });
    expect(m(r, 'Grep', file('src'))).toBe(true);
    expect(m(r, 'Grep', file('src/x'))).toBe(true);
    expect(m(r, 'Glob', file('.'))).toBe(false);
    expect(m(rule({ tools: ['Glob'], pathGlobs: ['**'] }), 'Glob', file('.'))).toBe(true);
  });
  it("himoyalangan yo'llar (.git, .claude, .env, .ssh, kalitlar) hech qachon, glob '**' bo'lsa ham", () => {
    const r = rule({ tools: ['Edit', 'Write', 'Read'], pathGlobs: ['**'] });
    for (const p of ['.git/hooks/pre-commit', '.claude/settings.json', 'sub/.claude/hooks/x.sh', '.env', '.env.production', 'a/.ssh/id_rsa', 'id_ed25519', 'cert.pem', '.mcp.json', '.zshrc', 'x/.husky/pre-commit']) {
      expect(m(r, 'Edit', file(p)), p).toBe(false);
      expect(m(r, 'Read', file(p)), p).toBe(false);
    }
    expect(m(rule({ pathGlobs: [] }), 'Write', file('.claude/settings.local.json'))).toBe(false);
    expect(m(rule({ pathGlobs: [] }), 'Write', file('src/environment.ts'))).toBe(true);
    expect(m(rule({ pathGlobs: [] }), 'Write', file('.github/workflows/ci.yml'))).toBe(false); // M-13: CI endi himoyalangan
  });
});

describe('ruleMatches: muddat, bekor qilish; tanlov; cheklov', () => {
  it("muddati o'tgan yoki bekor qilingan qoida mos kelmaydi (chegarada ham)", () => {
    expect(m(rule({ expiresAt: new Date(NOW.getTime() - 1) }), 'Edit', file('a'))).toBe(false);
    expect(m(rule({ expiresAt: NOW }), 'Edit', file('a'))).toBe(false);
    expect(m(rule({ expiresAt: new Date(NOW.getTime() + 1) }), 'Edit', file('a'))).toBe(true);
    expect(m(rule({ revokedAt: new Date(NOW.getTime() - 5) }), 'Edit', file('a'))).toBe(false);
    expect(ruleStatus(rule({ revokedAt: NOW }), NOW)).toBe('revoked');
    expect(ruleStatus(rule({ expiresAt: NOW }), NOW)).toBe('expired');
    expect(ruleStatus(rule(), NOW)).toBe('active');
  });
  it('findMatchingRule eng past id ni tanlaydi; hech biri mos kelmasa null', () => {
    const a = rule({ id: 7 });
    const b = rule({ id: 3 });
    const c = rule({ id: 1, revokedAt: NOW });
    expect(findMatchingRule([a, b, c], { toolName: 'Edit', target: file('x') }, NOW)?.id).toBe(3);
    expect(findMatchingRule([c], { toolName: 'Edit', target: file('x') }, NOW)).toBeNull();
    expect(findMatchingRule([a], { toolName: 'Bash', target: undefined }, NOW)).toBeNull();
  });
  it('soatlik cheklov: chegarada qo\'lda tasdiqqa tushadi', () => {
    expect(underRateCap(499)).toBe(true);
    expect(underRateCap(500)).toBe(false);
    expect(underRateCap(10, 10)).toBe(false);
  });
});

describe('yordamchilar', () => {
  it('normalizeTargetPath', () => {
    expect(normalizeTargetPath('a/./b//c')).toBe('a/b/c');
    expect(normalizeTargetPath('.')).toBe('.');
    expect(normalizeTargetPath('a/..')).toBeNull();
    expect(normalizeTargetPath('')).toBeNull();
    expect(normalizeTargetPath('x'.repeat(1025))).toBeNull();
  });
  it('matchGlob chekka holatlar', () => {
    expect(matchGlob('**', 'a/b/c')).toBe(true);
    expect(matchGlob('a/**', 'a')).toBe(true);
    expect(matchGlob('a/**/c', 'a/c')).toBe(true);
    expect(matchGlob('a/**/c', 'a/b/b/c')).toBe(true);
    expect(matchGlob('*.ts', 'a.ts')).toBe(true);
    expect(matchGlob('*.ts', 'dir/a.ts')).toBe(false);
    expect(matchGlob('a?c', 'abc')).toBe(true);
    expect(matchGlob('a?c', 'ac')).toBe(false);
    expect(matchGlob('a*b*c', 'aXXbYYc')).toBe(true);
    // ReDoS: uzun mos kelmaydigan kiritma tez tugaydi
    expect(matchGlob('*a*a*a*a*a*a*a*b', 'a'.repeat(200))).toBe(false);
  });
  it('M-13: CI, paket, build va skript fayllari himoyalangan (avto-ruxsat yo\'q)', () => {
    for (const p of ['.github/workflows/ci.yml', '.gitlab-ci.yml', 'package.json', 'apps/web/package.json', 'package-lock.json', 'pnpm-lock.yaml', 'Makefile', 'scripts/deploy.sh', 'run.ps1', 'Dockerfile', 'Dockerfile.prod', 'docker-compose.yml', 'docker-compose.prod.yaml', 'CLAUDE.md', 'sub/AGENTS.md', '.claude/settings.json', '.husky/pre-commit', '.git/hooks/pre-commit', 'foo.service', 'crontab', '.circleci/config.yml', '.devcontainer/devcontainer.json', 'pyproject.toml', 'vite.config.ts', '.cargo/config.toml', 'build.rs'])
      expect(isProtectedPath(p), p).toBe(true);
    for (const p of ['src/index.ts', 'README.md', 'docs/guide.md', 'src/app.tsx', 'tsconfig.json', 'data/notes.txt', 'package.json.md'])
      expect(isProtectedPath(p), p).toBe(false);
  });
  it('isProtectedPath', () => {
    expect(isProtectedPath('src/index.ts')).toBe(false);
    expect(isProtectedPath('.')).toBe(false);
    expect(isProtectedPath('.GIT/config')).toBe(true);
  });
});
