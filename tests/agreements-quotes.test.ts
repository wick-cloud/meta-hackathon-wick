import { describe, expect, it } from 'vitest';
import type { AgreementInput } from '../src/shared/agreements.js';
import {
  agreementEstimate,
  agreementWindows,
  ScheduleError,
  windowCost,
} from '../src/shared/schedule.js';
import { validateAgreement, localInstant } from '../src/server/agreements/recurrence.js';
import { HttpError } from '../src/server/context.js';

describe('one shared browser/server scheduled funding calculation', () => {
  const input: AgreementInput = {
    operationKey: 'quote-regression',
    description: 'Seven daily capacity windows',
    startDate: '2026-10-29',
    timeZone: 'Asia/Singapore',
    windowStart: '00:00',
    windowEnd: '06:00',
    minimumQuantity: 12,
    targetQuantity: 20,
    requirements: { cpu: 1, memoryGb: 1 },
    region: 'any',
    maxDiscountRateCentsPerHour: 10,
    continuation: { enabled: true, until: '08:00', maxRateCentsPerHour: 20 },
  };
  const now = Date.parse('2026-10-28T00:00:00Z');
  it('shows the Singapore $140 target maximum and $84 minimum exactly as the server reserves them', () => {
    const estimate = agreementEstimate(input),
      server = validateAgreement(input, now);
    expect(estimate).toEqual({ daily: 100, maximum: 14000, minimum: 8400 });
    expect(estimate.maximum).toBe(server.maxAmountCents);
    expect(agreementWindows(input)).toEqual(server.windows);
  });
  it('applies the one-cent minimum per VM/window before multiplying quantity and seven days', () => {
    const spec = {
      ...input,
      timeZone: 'UTC',
      windowEnd: '00:01',
      maxDiscountRateCentsPerHour: 1,
      continuation: undefined,
    };
    expect(agreementEstimate(spec)).toEqual({ daily: 1, maximum: 140, minimum: 84 });
    expect(validateAgreement(spec, now).maxAmountCents).toBe(140);
  });
  it('rounds a partial hour per VM/window, with one combined rounding for both price segments', () => {
    const spec = {
      ...input,
      timeZone: 'UTC',
      windowEnd: '00:14',
      continuation: { enabled: true, until: '00:15', maxRateCentsPerHour: 20 },
    };
    expect(agreementEstimate(spec)).toEqual({ daily: 3, maximum: 420, minimum: 252 });
    expect(validateAgreement(spec, now).maxAmountCents).toBe(420);
  });
  it('charges actual UTC elapsed hours across the November Vancouver transition rather than seven identical local-clock durations', () => {
    const spec = { ...input, timeZone: 'America/Vancouver' },
      server = validateAgreement(spec, now),
      estimate = agreementEstimate(spec);
    expect(server.windows.map((w) => windowCost(w, 10, 20))).toEqual([
      100, 100, 100, 110, 100, 100, 100,
    ]);
    expect(estimate.maximum).toBe(14200);
    expect(estimate.minimum).toBe(8520);
    expect(estimate.maximum).toBe(server.maxAmountCents);
  });
  it.each([
    { startDate: '2026-10-29', windowStart: '01:30', now: '2026-10-28T00:00:00Z' },
    { startDate: '2026-03-07', windowStart: '02:30', now: '2026-03-06T00:00:00Z' },
  ])(
    'rejects an ambiguous or missing Vancouver endpoint within the complete term: $startDate',
    ({ now, ...values }) => {
      const spec = { ...input, ...values, timeZone: 'America/Vancouver' };
      expect(() => agreementEstimate(spec)).toThrow(ScheduleError);
      expect(() => agreementEstimate(spec)).toThrow(/missing or ambiguous.*daylight-saving/);
      try {
        validateAgreement(spec, Date.parse(now));
        expect.unreachable('The API must reject the same invalid term.');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect(error).toMatchObject({
          statusCode: 400,
          message: expect.stringMatching(/missing or ambiguous.*daylight-saving/),
        });
      }
    },
  );
  it.each([
    { startDate: '' },
    { timeZone: '' },
    { windowEnd: '' },
    { continuation: { enabled: true, until: '', maxRateCentsPerHour: 20 } },
  ])('rejects incomplete inputs rather than returning a zero or NaN estimate: %j', (patch) => {
    expect(() => agreementEstimate({ ...input, ...patch })).toThrow(ScheduleError);
  });
  it('preserves HTTP400 wrapping for existing server schedule helper exports', () => {
    try {
      localInstant('2026-11-01', '01:30', 'America/Vancouver');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ statusCode: 400 });
    }
  });
});
