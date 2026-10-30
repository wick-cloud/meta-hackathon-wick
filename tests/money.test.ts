import { describe, expect, it } from 'vitest';
import {
  addCents,
  centsFromUnits,
  centsToUsd,
  formatMoney,
  formatMoneyMicros,
  isMoneyCents,
  moneyUnits,
  multiplyCents,
  subtractCents,
  usdToCents,
} from '../src/shared/money.js';

describe('four-decimal USD money', () => {
  it('accepts dollar ten-thousandths while cents API units and old whole cents stay compatible', () => {
    expect(usdToCents('0.0001')).toBe(0.01);
    expect(usdToCents('1.2345')).toBe(123.45);
    expect(usdToCents('1.23000')).toBe(123);
    expect(usdToCents('1e-4')).toBe(0.01);
    expect(usdToCents('.0001')).toBe(0.01);
    expect(centsToUsd(123.45)).toBe('1.2345');
    expect(centsToUsd(0.01)).toBe('0.0001');
    expect(centsToUsd(101.67)).toBe('1.0167');
    expect(centsToUsd(174)).toBe('1.74');
    expect(centsToUsd(-0.01)).toBe('-0.0001');
    expect(usdToCents('1.23456')).toBeUndefined();
    expect(usdToCents('1e-5')).toBeUndefined();
    expect(usdToCents('1.23450000000000001')).toBeUndefined();
    expect(usdToCents('1e1000000')).toBeUndefined();
    for (const value of [NaN, Infinity, -Infinity, 0.001, '0.01', 1_000_000_000_001])
      expect(isMoneyCents(value)).toBe(false);
  });
  it('adds, subtracts and multiplies on the exact lattice without binary drift', () => {
    expect(addCents(0.1, 0.2)).toBe(0.3);
    expect(subtractCents(0.3, 0.1)).toBe(0.2);
    expect(multiplyCents(0.07, 3)).toBe(0.21);
    expect(centsFromUnits(moneyUnits('1000000000000.00'))).toBe(1_000_000_000_000);
    expect(() => moneyUnits(0.1 + 0.2)).toThrow();
  });
  it('shows at most four decimal places and rounds micros without converting large totals to Number', () => {
    expect(formatMoney(123.45)).toBe('$1.2345');
    expect(formatMoney(174)).toBe('$1.74');
    expect(formatMoney(0.01)).toBe('$0.0001');
    expect(formatMoneyMicros('1234567')).toBe('$1.2346');
    expect(formatMoneyMicros('-1234567')).toBe('-$1.2346');
    expect(formatMoneyMicros('999999')).toBe('$1.00');
    expect(formatMoneyMicros('900719925474099100')).toBe('$900,719,925,474.0991');
  });
});
