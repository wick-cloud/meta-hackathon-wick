import { addCents, multiplyCents, isMoneyCents } from '../../shared/money.js';
import { moneyCents } from '../marketplace/data.js';
import type { AgreementInput, ScheduledOfferingInput } from '../../shared/agreements.js';
import { HttpError } from '../context.js';
import { integer, positiveNumber, shortText } from '../marketplace/data.js';
import { operationKey } from './credits.js';
import * as schedule from '../../shared/schedule.js';
import type { WindowTimes } from '../../shared/schedule.js';
export type { WindowTimes } from '../../shared/schedule.js';

function apiSchedule<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof schedule.ScheduleError) throw new HttpError(400, error.message);
    throw error;
  }
}
export const timeZone = (value: unknown) => apiSchedule(() => schedule.timeZone(value));
export const clock = (value: unknown) => apiSchedule(() => schedule.clock(value));
export const datePlus = (date: string, days: number) =>
  apiSchedule(() => schedule.datePlus(date, days));
export const localDate = (epoch: number, zone: string) =>
  apiSchedule(() => schedule.localDate(epoch, zone));
export const localInstant = (date: string, time: string, zone: string) =>
  apiSchedule(() => schedule.localInstant(date, time, zone));
export const windowOn = (
  date: string,
  start: string,
  discount: string,
  end: string,
  zone: string,
) => apiSchedule(() => schedule.windowOn(date, start, discount, end, zone));
export const windowCost = (window: WindowTimes, discountRate: number, normalRate = 0) =>
  apiSchedule(() => schedule.windowCost(window, discountRate, normalRate));
export function validateAgreement(
  raw: unknown,
  now = Date.now(),
): { input: AgreementInput; windows: WindowTimes[]; maxAmountCents: number } {
  const v = (raw ?? {}) as AgreementInput;
  const zone = timeZone(v.timeZone),
    date = shortText(v.startDate, 'Start date', 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) ||
    datePlus(date, 0) !== date
  )
    throw new HttpError(400, 'Use a valid start date in YYYY-MM-DD format.');
  const today = localDate(now, zone);
  if (date < today || date > datePlus(today, 30))
    throw new HttpError(400, 'The first capacity window must start within the next 30 days.');
  const start = clock(v.windowStart),
    discount = clock(v.windowEnd);
  const continuation = v.continuation?.enabled
    ? {
        enabled: true,
        until: clock(v.continuation.until),
        maxRateCentsPerHour: moneyCents(
          v.continuation.maxRateCentsPerHour,
          'Continuation rate',
          0.01,
        ),
      }
    : undefined;
  const input: AgreementInput = {
    operationKey: operationKey(v.operationKey),
    description: shortText(v.description, 'Description'),
    startDate: date,
    timeZone: zone,
    windowStart: start,
    windowEnd: discount,
    minimumQuantity: integer(v.minimumQuantity, 'Minimum quantity', 1, 20),
    targetQuantity: integer(v.targetQuantity, 'Target quantity', 1, 20),
    requirements: {
      cpu: positiveNumber(v.requirements?.cpu, 'vCPU', 128),
      memoryGb: positiveNumber(v.requirements?.memoryGb, 'Memory GB', 1024),
      ...(v.requirements?.gpu ? { gpu: shortText(v.requirements.gpu, 'GPU', 100) } : {}),
    },
    region: shortText(v.region, 'Region', 100),
    maxDiscountRateCentsPerHour: moneyCents(v.maxDiscountRateCentsPerHour, 'Discount rate', 0.01),
    ...(v.maxReservationCents === undefined
      ? {}
      : {
          maxReservationCents: moneyCents(
            v.maxReservationCents,
            'Reviewed maximum reservation',
            0.01,
          ),
        }),
    ...(continuation ? { continuation } : {}),
  };
  if (input.minimumQuantity > input.targetQuantity)
    throw new HttpError(400, 'Minimum quantity cannot exceed the target.');
  const windows = apiSchedule(() => schedule.agreementWindows(input));
  if (Date.parse(windows[0].endsAt) <= now)
    throw new HttpError(400, 'The first capacity window has already ended.');
  const maxAmountCents = windows.reduce(
    (sum, w) =>
      addCents(
        sum,
        multiplyCents(
          windowCost(w, input.maxDiscountRateCentsPerHour, continuation?.maxRateCentsPerHour),
          input.targetQuantity,
        ),
      ),
    0,
  );
  if (!isMoneyCents(maxAmountCents) || maxAmountCents > 100000000)
    throw new HttpError(400, 'The maximum seven-day agreement exceeds the credit limit.');
  if (input.maxReservationCents !== undefined && maxAmountCents > input.maxReservationCents)
    throw new HttpError(
      409,
      'The current maximum reservation exceeds your reviewed credit ceiling. Refresh the server preview and review the new amount before submitting.',
    );
  return { input, windows, maxAmountCents };
}
export function validateOffering(raw: unknown): ScheduledOfferingInput {
  const v = (raw ?? {}) as ScheduledOfferingInput;
  const weekdays = Array.isArray(v.weekdays)
    ? [...new Set(v.weekdays.map((d) => integer(d, 'Weekday', 0, 6)))].sort()
    : [];
  if (!weekdays.length) throw new HttpError(400, 'Choose at least one weekday.');
  if (!['discount_schedule', 'capacity_window'].includes(v.kind))
    throw new HttpError(400, 'Choose a scheduled offering kind.');
  const value: ScheduledOfferingInput = {
    operationKey: operationKey(v.operationKey),
    catalogId: shortText(v.catalogId, 'Configuration', 200),
    name: shortText(v.name, 'Name', 200),
    kind: v.kind,
    timeZone: timeZone(v.timeZone),
    weekdays,
    windowStart: clock(v.windowStart),
    windowEnd: clock(v.windowEnd),
    availableUntil: clock(v.availableUntil),
    capacityQuantity: integer(v.capacityQuantity, 'Capacity', 1, 20),
    discountRateCentsPerHour: moneyCents(v.discountRateCentsPerHour, 'Discount rate', 0.01),
    normalRateCentsPerHour: moneyCents(v.normalRateCentsPerHour, 'Normal rate', 0.01),
  };
  windowOn('2026-01-15', value.windowStart, value.windowEnd, value.availableUntil, value.timeZone);
  return value;
}
export function offeringCovers(offer: ScheduledOfferingInput, wanted: WindowTimes) {
  const date = localDate(Date.parse(wanted.startsAt), offer.timeZone);
  for (const day of [-1, 0, 1]) {
    const d = datePlus(date, day);
    if (!offer.weekdays.includes(new Date(`${d}T12:00:00Z`).getUTCDay())) continue;
    let slot: WindowTimes;
    try {
      slot = windowOn(d, offer.windowStart, offer.windowEnd, offer.availableUntil, offer.timeZone);
    } catch {
      continue;
    }
    if (
      slot.startsAt <= wanted.startsAt &&
      slot.discountEndsAt >= wanted.discountEndsAt &&
      slot.endsAt >= wanted.endsAt
    )
      return true;
  }
  return false;
}
