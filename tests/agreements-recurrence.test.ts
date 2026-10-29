import { describe, expect, it } from 'vitest';
import {
  localInstant,
  offeringCovers,
  validateAgreement,
  windowCost,
  windowOn,
} from '../src/server/agreements/recurrence.js';

describe('scheduled agreement recurrence and immutable budget', () => {
  const input = {
    operationKey: 'test-order-key',
    description: 'Overnight development capacity',
    startDate: '2026-10-29',
    timeZone: 'UTC',
    windowStart: '00:00',
    windowEnd: '06:00',
    minimumQuantity: 12,
    targetQuantity: 20,
    requirements: { cpu: 1, memoryGb: 1 },
    region: 'any',
    maxDiscountRateCentsPerHour: 10,
    continuation: { enabled: true, until: '08:00', maxRateCentsPerHour: 20 },
  };
  it('freezes seven UTC occurrences and reserves the full $140 maximum', () => {
    const result = validateAgreement(input, Date.parse('2026-10-28T12:00:00Z'));
    expect(result.windows).toHaveLength(7);
    expect(result.maxAmountCents).toBe(14000);
    expect(windowCost(result.windows[0], 10, 20)).toBe(100);
    expect(result.windows[6].endsAt).toBe('2026-11-04T08:00:00.000Z');
  });
  it('converts an overnight IANA schedule and preserves the physical continuation cutoff', () => {
    const w = windowOn('2026-10-29', '22:00', '04:00', '06:00', 'Asia/Singapore');
    expect(w).toEqual({
      startsAt: '2026-10-29T14:00:00.000Z',
      discountEndsAt: '2026-10-29T20:00:00.000Z',
      endsAt: '2026-10-29T22:00:00.000Z',
    });
  });
  it('rejects nonexistent and ambiguous daylight-saving local times', () => {
    expect(() => localInstant('2026-03-08', '02:30', 'America/Los_Angeles')).toThrow(
      /missing or ambiguous/,
    );
    expect(() => localInstant('2026-11-01', '01:30', 'America/Los_Angeles')).toThrow(
      /missing or ambiguous/,
    );
  });
  it('never covers a buyer continuation beyond the published physical cutoff', () => {
    const w = windowOn('2026-10-29', '00:00', '06:00', '08:00', 'UTC');
    expect(
      offeringCovers(
        {
          operationKey: 'provider-key',
          name: 'Capacity',
          catalogId: 'micro',
          kind: 'capacity_window',
          timeZone: 'UTC',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          windowStart: '00:00',
          windowEnd: '06:00',
          availableUntil: '07:00',
          capacityQuantity: 20,
          discountRateCentsPerHour: 10,
          normalRateCentsPerHour: 20,
        },
        w,
      ),
    ).toBe(false);
  });
  it('does not silently turn off continuation or accept a minimum above target', () => {
    expect(() =>
      validateAgreement({ ...input, minimumQuantity: 21 }, Date.parse('2026-10-28T12:00Z')),
    ).toThrow();
    expect(() =>
      validateAgreement(
        { ...input, continuation: { enabled: true, until: '09:00', maxRateCentsPerHour: 0 } },
        Date.parse('2026-10-28T12:00Z'),
      ),
    ).toThrow();
  });
});
