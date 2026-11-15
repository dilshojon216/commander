import { describe, expect, it } from 'vitest';
import { ProjectRootResolver } from './project-root.js';

describe('ProjectRootResolver (POSIX)', () => {
  const gits = new Set(['/w/repo/.git', '/Users/a/.git']);
  const r = () => new ProjectRootResolver((p) => gits.has(p), 100, '/Users/a', 'linux');

  it("yuqoriga qarab birinchi .git, topilmasa cwd o'zi", () => {
    expect(r().resolve('/w/repo/src/deep')).toBe('/w/repo');
    expect(r().resolve('/w/repo')).toBe('/w/repo');
    expect(r().resolve('/tmp/x')).toBe('/tmp/x');
  });

  it("home'dagi .git (dotfiles) ildiz emas, faqat cwd o'zi bo'lsa", () => {
    expect(r().resolve('/Users/a/notes')).toBe('/Users/a/notes');
    expect(r().resolve('/Users/a')).toBe('/Users/a');
  });
});

describe('ProjectRootResolver (Windows)', () => {
  const gits = new Set(['C:\\Users\\Dil\\repo\\.git', 'D:\\w\\mono\\.git', 'C:\\Users\\Dil\\.git']);
  const exists = (p: string): boolean => gits.has(p.replace(/\//g, '\\'));
  const mk = (canon: (p: string) => string = (p) => p) => new ProjectRootResolver(exists, 100, 'C:\\Users\\Dil', 'win32', canon);

  it('backslash va disk harfi: ildiz topiladi va yagona ko\'rinishda qaytadi', () => {
    expect(mk().resolve('C:\\Users\\Dil\\repo\\src\\a')).toBe('C:/Users/Dil/repo');
    expect(mk().resolve('D:\\w\\mono\\packages\\x')).toBe('D:/w/mono');
  });

  it("bitta loyiha ikkiga bo'linmaydi: turli yozilishlar (registr, ajratgich) bir ildiz beradi", () => {
    // Claude cwd'si va git toplevel turlicha yozilishi mumkin; haqiqiy yozilishni realpath.native beradi (bu yerda taqlid).
    const canon = (p: string): string => p.replace(/\//g, '\\').replace(/^c:/, 'C:').replace(/\\users\\dil\\/i, '\\Users\\Dil\\');
    const r = mk(canon);
    const roots = new Set(['C:\\Users\\Dil\\repo\\src', 'c:\\users\\dil\\repo\\src', 'C:/Users/Dil/repo/src'].map((p) => r.resolve(p)));
    expect([...roots]).toEqual(['C:/Users/Dil/repo']);
  });

  it("home'dagi .git ildiz emas (registrga bog'liq emas); cwd home bo'lsa o'zi", () => {
    expect(mk().resolve('C:\\Users\\Dil\\notes')).toBe('C:/Users/Dil/notes');
    expect(mk().resolve('c:\\users\\dil\\notes')).toBe('C:/users/dil/notes');
    expect(mk().resolve('C:\\Users\\Dil')).toBe('C:/Users/Dil');
  });

  it(".git topilmasa cwd o'zi (normallashgan)", () => {
    expect(mk().resolve('E:\\tmp\\x\\')).toBe('E:/tmp/x');
  });
});
