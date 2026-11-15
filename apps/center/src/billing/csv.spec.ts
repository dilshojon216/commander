import { describe, expect, it } from 'vitest';
import { csvCell, csvEscapeText, neutralizeFormula, toCsv } from './csv.js';

describe('CSV in\'ektsiyadan himoya', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+cmd|x', "'+cmd|x"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1', "'\t=1"],
    ['\r=1', "'\r=1"],
    ['  =HYPERLINK("x")', `'  =HYPERLINK("x")`],
    ['oddiy matn', 'oddiy matn'],
    ["a=b", "a=b"],
    ["Mijoz - A", "Mijoz - A"],
  ])('neutralizeFormula(%j)', (input, expected) => {
    expect(neutralizeFormula(input)).toBe(expected);
  });

  it("qo'shtirnoq, vergul, yangi qator o'raladi", () => {
    expect(csvEscapeText('a,b')).toBe('"a,b"');
    expect(csvEscapeText('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscapeText('x\ny')).toBe('"x\ny"');
    expect(csvEscapeText('=A1,2')).toBe('"\'=A1,2"');
  });

  it('raqam va null', () => {
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it("toCsv: BOM, CRLF, sarlavhalar ham himoyalangan", () => {
    const out = toCsv(['A', '=B'], [['x', 1], ['=2+2', null]]);
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).toBe("﻿A,'=B\r\nx,1\r\n'=2+2,\r\n");
  });
});
