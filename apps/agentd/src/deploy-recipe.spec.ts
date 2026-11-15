import { describe, expect, it } from 'vitest';
import { argvInvokesShell, parseRecipe, placeholderIssues, substitute } from './deploy-recipe.js';

const base = (extra = ''): string => `version: 1
targets:
  prod:
    machine: ubuntu-1
    cwd: .
    steps:
      - name: build
        run: [npm, run, build]
${extra}`;

describe('parseRecipe', () => {
  it('oddiy retsept: normallashtiriladi, xesh barqaror (bo\'shliq/izoh/kalit tartibi ta\'sir qilmaydi)', () => {
    const a = parseRecipe(base());
    expect(a.issues).toEqual([]);
    expect(a.recipe?.targets[0]).toMatchObject({ name: 'prod', machine: 'ubuntu-1', cwd: '.', usesShell: false, timeoutSec: 1800 });
    expect(a.recipe?.targets[0]?.steps[0]).toMatchObject({ kind: 'argv', argv: ['npm', 'run', 'build'], shell: null, timeoutSec: 300 });
    expect(a.recipeHash).toMatch(/^[0-9a-f]{64}$/);
    const b = parseRecipe(`# izoh\nversion: 1\ntargets:\n  prod:\n\n    steps: [ { run: [npm, run, build], name: build } ]\n    cwd: "."\n    machine: ubuntu-1   # mashina\n`);
    expect(b.recipeHash).toBe(a.recipeHash);
    const c = parseRecipe(base().replace('npm, run, build', 'npm, run, build2'));
    expect(c.recipeHash).not.toBe(a.recipeHash);
  });

  it('argv-only: `run` qator bo\'lsa rad; birinchi element bo\'shliqli buyruq qatori bo\'lsa rad; son/bool qatorga aylanadi', () => {
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: npm run build')).issues.join(' ')).toMatch(/MASSIV/);
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: ["npm run build"]')).issues.join(' ')).toMatch(/bo'shliqsiz/);
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [--evil]')).issues.join(' ')).toMatch(/'-' bilan/);
    const ok = parseRecipe(base().replace('run: [npm, run, build]', 'run: [serve, --port, 3000, true]'));
    expect(ok.recipe?.targets[0]?.steps[0]?.argv).toEqual(['serve', '--port', '3000', 'true']);
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: []')).recipe).toBeNull();
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [a, null]')).recipe).toBeNull();
  });

  it('shell: faqat o\'zi tanlasa; usesShell belgilanadi; `bash -c` va `env sh` ham shell hisoblanadi', () => {
    const sh = parseRecipe(base().replace('run: [npm, run, build]', 'shell: "npm ci && npm run build"'));
    expect(sh.recipe?.targets[0]?.steps[0]).toMatchObject({ kind: 'shell', shell: 'npm ci && npm run build', argv: [] });
    expect(sh.usesShell).toBe(true);
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [bash, -c, "echo hi"]')).usesShell).toBe(true);
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [env, FOO=1, sh, -c, x]')).usesShell).toBe(true);
    expect(parseRecipe(base()).usesShell).toBe(false);
    // ikkalasi yoki hech biri
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [a]\n        shell: b')).issues.join(' ')).toMatch(/aynan bittasi/);
    expect(argvInvokesShell(['sudo', '-u', 'app', '/bin/bash', 'x.sh'])).toBe(true);
    expect(argvInvokesShell(['node', 'server.js'])).toBe(false);
    expect(argvInvokesShell(['nice', '-n', '10', 'zsh'])).toBe(true);
  });

  it('yo\'llar: step cwd nisbiy va `..`siz; target cwd `..`siz nisbiy yoki mutlaq; `~` rad', () => {
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [a]\n        cwd: ../x')).issues.join(' ')).toMatch(/'\.\.'/);
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [a]\n        cwd: /etc')).issues.join(' ')).toMatch(/nisbiy/);
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [a]\n        cwd: web/app')).recipe?.targets[0]?.steps[0]?.cwd).toBe('web/app');
    expect(parseRecipe(base().replace('cwd: .', 'cwd: ../other')).issues.join(' ')).toMatch(/'\.\.'/);
    expect(parseRecipe(base().replace('cwd: .', 'cwd: ~/x')).issues.join(' ')).toMatch(/~/);
    expect(parseRecipe(base().replace('cwd: .', 'cwd: /srv/app')).recipe?.targets[0]?.cwd).toBe('/srv/app');
  });

  it('env: faqat A-Z0-9_, taqiqlangan nomlar (PATH, LD_*, GIT_*, NODE_*) rad; sirga o\'xshash qiymat rad', () => {
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [a]\n        env: { NODE_ENV: production }')).issues.join(' ')).toMatch(/ruxsat etilmagan/);
    for (const k of ['PATH', 'LD_PRELOAD', 'GIT_SSH_COMMAND', 'DYLD_INSERT_LIBRARIES', 'COMMANDER_X', 'lower']) {
      expect(parseRecipe(base().replace('run: [npm, run, build]', `run: [a]\n        env: { ${k}: x }`)).recipe).toBeNull();
    }
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [a]\n        env: { APP_MODE: prod, PORT: 8080 }')).recipe?.targets[0]?.steps[0]?.env).toEqual({ APP_MODE: 'prod', PORT: '8080' });
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [a, "--token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"]')).issues.join(' ')).toMatch(/sirga o'xshash/);
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [a]\n        env: { APP_SECRET: "hunter2hunter2" }')).issues.join(' ')).toMatch(/sirga o'xshash/);
  });

  it('noma\'lum kalit, takroriy nom, ko\'p qadam, versiya, bo\'sh maqsad: rad', () => {
    expect(parseRecipe(base('    bogus: 1\n')).issues.join(' ')).toMatch(/noma'lum kalit/);
    expect(parseRecipe(base().replace('name: build', 'name: build\n        timout: 5')).issues.join(' ')).toMatch(/noma'lum kalit/);
    expect(parseRecipe(base().replace('version: 1', 'version: 2')).issues.join(' ')).toMatch(/version: 1/);
    expect(parseRecipe('version: 1\ntargets: {}\n').recipe).toBeNull();
    expect(parseRecipe('- a\n- b').issues.join(' ')).toMatch(/ildiz/);
    const dup = base().replace('        run: [npm, run, build]', '        run: [npm, run, build]\n      - name: build\n        run: [x]');
    expect(parseRecipe(dup).issues.join(' ')).toMatch(/takroriy/);
    const many = '      - [a]\n'.repeat(41);
    expect(parseRecipe(`version: 1\ntargets:\n  prod:\n    machine: m\n    steps:\n${many}`).issues.join(' ')).toMatch(/juda ko'p qadam/);
  });

  it('YAML xavfsizligi: teglar/yaroqsiz YAML/alias bombasi/katta fayl rad; hech qachon throw qilmaydi', () => {
    expect(parseRecipe('version: !!js/function "function(){}"\ntargets: {}').recipe).toBeNull();
    expect(parseRecipe('a: [unclosed').issues.join(' ')).toMatch(/YAML/);
    const bomb = ['a: &a [x,x,x,x,x,x,x,x,x,x]', ...'bcdefghi'.split('').map((c, i) => `${c}: &${c} [${Array(10).fill(`*${'abcdefghi'[i]}`).join(',')}]`), 'version: 1', 'targets: *i'].join('\n');
    const r = parseRecipe(bomb);
    expect(r.recipe).toBeNull();
    expect(parseRecipe('x'.repeat(70_000)).issues.join(' ')).toMatch(/katta/);
    expect(parseRecipe('').recipe).toBeNull();
  });

  it('health: url yoki run; faqat http(s), login/parol yo\'q; chegaralar', () => {
    const h = (y: string): ReturnType<typeof parseRecipe> => parseRecipe(base(`    health:\n${y}`));
    expect(h('      url: http://127.0.0.1:3000/health\n      retries: 10\n      interval: 2\n      timeout: 4\n      expect: [200, 204]').recipe?.targets[0]?.health).toMatchObject({ kind: 'http', retries: 10, intervalSec: 2, timeoutSec: 4, expectStatus: [200, 204] });
    expect(h('      url: ftp://x/y').recipe).toBeNull();
    expect(h('      url: http://user:pw@host/x').recipe).toBeNull();
    expect(h('      url: http://h/x\n      run: [a]').issues.join(' ')).toMatch(/aynan bittasi/);
    expect(h('      url: http://h/x\n      retries: 999').recipe).toBeNull();
    expect(h('      run: [curl-check, --ok]').recipe?.targets[0]?.health).toMatchObject({ kind: 'command', argv: ['curl-check', '--ok'] });
    expect(h('      url: http://h/x\n      expect: 99').recipe).toBeNull();
  });

  it('o\'rinbosarlar: faqat {{commit}} {{short_commit}} {{target}}', () => {
    expect(placeholderIssues('a {{commit}} b {{ target }} {{nope}}')).toEqual(['nope']);
    expect(substitute('git checkout {{commit}} && {{short_commit}} {{target}} {{nope}}', { commit: 'abcdef0123456789', target: 'prod' })).toBe('git checkout abcdef0123456789 && abcdef01 prod {{nope}}');
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [git, checkout, "{{commit}}"]')).recipe).not.toBeNull();
    expect(parseRecipe(base().replace('run: [npm, run, build]', 'run: [git, checkout, "{{branch}}"]')).issues.join(' ')).toMatch(/o'rinbosar/);
  });

  it('maqsadlar nomi/mashina nomi tekshiriladi; maqsadlar saralanadi', () => {
    expect(parseRecipe(base().replace('prod:', 'Prod:')).recipe).toBeNull();
    expect(parseRecipe(base().replace('machine: ubuntu-1', 'machine: "bad name"')).recipe).toBeNull();
    const two = `version: 1\ntargets:\n  zeta:\n    machine: m\n    steps: [[a]]\n  alpha:\n    machine: m\n    steps: [[b]]\n`;
    expect(parseRecipe(two).recipe?.targets.map((t) => t.name)).toEqual(['alpha', 'zeta']);
  });
});
