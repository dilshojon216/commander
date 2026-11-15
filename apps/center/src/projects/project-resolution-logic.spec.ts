import { describe, expect, it } from 'vitest';
import { decideProject, isFsRoot, isStrictlyInside, nearestAncestor, stickyProjectId } from './project-resolution-logic.js';

const root = { id: 'p-root', path: '/Users/me/working/commander' };
const apps = { id: 'p-apps', path: '/Users/me/working/commander/apps' };

describe('isStrictlyInside', () => {
  it('chegara / bo\'yicha, teng yo\'l ichida emas', () => {
    expect(isStrictlyInside('/a/b/c', '/a/b')).toBe(true);
    expect(isStrictlyInside('/a/b', '/a/b')).toBe(false);
    expect(isStrictlyInside('/a/bc', '/a/b')).toBe(false);
    expect(isStrictlyInside('/a/b/c', '/a/b/')).toBe(true);
    expect(isStrictlyInside('C:/Users/x/p/sub', 'C:/Users/x/p')).toBe(true);
  });
  it('fayl tizimi ildizi ota bo\'lolmaydi', () => {
    expect(isFsRoot('/')).toBe(true);
    expect(isFsRoot('C:/')).toBe(true);
    expect(isStrictlyInside('/home/x', '/')).toBe(false);
    expect(isStrictlyInside('C:/Users', 'C:/')).toBe(false);
  });
});

describe('nearestAncestor', () => {
  it('eng uzun yo\'lli ota', () => {
    expect(nearestAncestor('/Users/me/working/commander/apps/dashboard', [root, apps])?.id).toBe('p-apps');
    expect(nearestAncestor('/Users/me/working/commander/docs', [root, apps])?.id).toBe('p-root');
  });
  it('ota yo\'q', () => {
    expect(nearestAncestor('/other/place', [root, apps])).toBeNull();
    expect(nearestAncestor(root.path, [root])).toBeNull();
  });
});

describe('decideProject', () => {
  const sub = '/Users/me/working/commander/apps/dashboard';
  it('aynan shu yo\'lli loyiha bor -> o\'sha', () => {
    expect(decideProject({ cwd: root.path, exactId: 'p-root', ancestors: [] })).toEqual({ action: 'use', projectId: 'p-root' });
  });
  it('git ildizi, loyiha yo\'q -> git loyiha yaratiladi (ota dir loyihaga yutilmaydi)', () => {
    expect(decideProject({ cwd: sub, rootKind: 'git', exactId: null, ancestors: [root] })).toEqual({ action: 'create', kind: 'git' });
  });
  it('git emas, ma\'lum ota bor -> ota (yangi pastki papka loyihasi ochilmaydi)', () => {
    expect(decideProject({ cwd: sub, rootKind: 'dir', exactId: null, ancestors: [root] })).toEqual({ action: 'use', projectId: 'p-root' });
    expect(decideProject({ cwd: sub, exactId: null, ancestors: [root, apps] })).toEqual({ action: 'use', projectId: 'p-apps' });
  });
  it('ota ham yo\'q -> yangi dir loyiha', () => {
    expect(decideProject({ cwd: '/x/y', exactId: null, ancestors: [] })).toEqual({ action: 'create', kind: 'dir' });
  });
});

describe('stickyProjectId', () => {
  it('belgilangan loyiha o\'zgarmaydi', () => {
    expect(stickyProjectId('p-root', 'p-sub')).toBe('p-root');
    expect(stickyProjectId(null, 'p-sub')).toBe('p-sub');
    expect(stickyProjectId(undefined, null)).toBeNull();
  });
});
