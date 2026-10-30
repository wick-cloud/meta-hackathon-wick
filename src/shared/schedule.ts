import type { AgreementInput } from './agreements.js';
import { isMoneyCents, moneyUnits, centsFromUnits, addCents, multiplyCents } from './money.js';

/** Browser-safe validation; the API owner converts this to its HTTP error contract. */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}
export interface WindowTimes {
  startsAt: string;
  discountEndsAt: string;
  endsAt: string;
}
export function timeZone(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100)
    throw new ScheduleError('Time zone is required and must be at most 100 characters.');
  const zone = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
  } catch {
    throw new ScheduleError('Choose a valid IANA time zone.');
  }
  return zone;
}
export function clock(value: unknown) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new ScheduleError('Use a local time in HH:mm format.');
  return value;
}
export function datePlus(date: string, days: number) {
  const epoch = Date.parse(`${date}T12:00:00Z`) + days * 86400000;
  if (!Number.isFinite(epoch))
    throw new ScheduleError('Use a valid start date in YYYY-MM-DD format.');
  return new Date(epoch).toISOString().slice(0, 10);
}
export function localDate(epoch: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(epoch);
  return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k)!.value).join('-');
}
/** Reject DST gaps and duplicate local times; each booked endpoint has one UTC interpretation. */
export function localInstant(date: string, time: string, zone: string) {
  const [year, month, day] = date.split('-').map(Number),
    [hour, minute] = time.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (epoch: number) => {
    const p = fmt.formatToParts(epoch);
    return ['year', 'month', 'day', 'hour', 'minute'].map((k) =>
      Number(p.find((v) => v.type === k)!.value),
    );
  };
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const at = naive + h * 3600000,
      p = parts(at);
    offsets.add(Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]) - at);
  }
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((at) => parts(at).join() === [year, month, day, hour, minute].join());
  if (matches.length !== 1)
    throw new ScheduleError(
      'A chosen local time is missing or ambiguous at a daylight-saving transition. Choose another time.',
    );
  return new Date(matches[0]).toISOString();
}
export function windowOn(
  date: string,
  start: string,
  discount: string,
  end: string,
  zone: string,
): WindowTimes {
  const discountDate = discount <= start ? datePlus(date, 1) : date;
  const endDate = end < discount ? datePlus(discountDate, 1) : discountDate;
  const times = {
    startsAt: localInstant(date, start, zone),
    discountEndsAt: localInstant(discountDate, discount, zone),
    endsAt: localInstant(endDate, end, zone),
  };
  const seconds = (Date.parse(times.endsAt) - Date.parse(times.startsAt)) / 1000;
  if (seconds < 60 || seconds > 86400)
    throw new ScheduleError('Each capacity window must last between one minute and 24 hours.');
  return times;
}
export function windowCost(window: WindowTimes, discountRate: number, normalRate = 0) {
  const discountMs = Date.parse(window.discountEndsAt) - Date.parse(window.startsAt);
  const normalMs = Date.parse(window.endsAt) - Date.parse(window.discountEndsAt);
  const weighted =
    BigInt(discountMs) * moneyUnits(discountRate) + BigInt(normalMs) * moneyUnits(normalRate);
  const units = (weighted + 3_599_999n) / 3_600_000n;
  return centsFromUnits(units < 1n ? 1n : units);
}
type ScheduleInput = Pick<
  AgreementInput,
  'startDate' | 'timeZone' | 'windowStart' | 'windowEnd' | 'continuation'
>;
export function agreementWindows(input: ScheduleInput): WindowTimes[] {
  const zone = timeZone(input.timeZone),
    date = input.startDate;
  if (
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) ||
    datePlus(date, 0) !== date
  )
    throw new ScheduleError('Use a valid start date in YYYY-MM-DD format.');
  const start = clock(input.windowStart),
    discount = clock(input.windowEnd),
    end = input.continuation?.enabled ? clock(input.continuation.until) : discount;
  const windows = Array.from({ length: 7 }, (_, i) =>
    windowOn(datePlus(date, i), start, discount, end, zone),
  );
  if (windows.some((w, i) => i > 0 && w.startsAt < windows[i - 1].endsAt))
    throw new ScheduleError('Daily booked windows cannot overlap at a daylight-saving transition.');
  return windows;
}
export type AgreementFundingInput = ScheduleInput &
  Pick<AgreementInput, 'minimumQuantity' | 'targetQuantity' | 'maxDiscountRateCentsPerHour'>;
export function agreementEstimate(input: AgreementFundingInput) {
  for (const [value, label, max] of [
    [input.minimumQuantity, 'Minimum approved slots', 20],
    [input.targetQuantity, 'Target slots', 20],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new ScheduleError(`${label} must be a whole number between 1 and ${max}.`);
  }
  if (input.minimumQuantity > input.targetQuantity)
    throw new ScheduleError('Minimum quantity cannot exceed the target.');
  const normalRate = input.continuation?.enabled ? input.continuation.maxRateCentsPerHour : 0;
  if (
    !isMoneyCents(input.maxDiscountRateCentsPerHour) ||
    input.maxDiscountRateCentsPerHour < 0.01 ||
    input.maxDiscountRateCentsPerHour > 100000000
  )
    throw new ScheduleError('Discount rate must be positive with at most four USD decimal places.');
  if (
    input.continuation?.enabled &&
    (!isMoneyCents(normalRate) || normalRate < 0.01 || normalRate > 100000000)
  )
    throw new ScheduleError(
      'Continuation rate must be positive with at most four USD decimal places.',
    );
  const windows = agreementWindows(input),
    perWindow = windows.map((w) => windowCost(w, input.maxDiscountRateCentsPerHour, normalRate));
  // Round once per VM/window to $0.0001, then multiply whole slot quantities.
  const perSlotTerm = perWindow.reduce((sum, cost) => addCents(sum, cost), 0),
    maximum = multiplyCents(perSlotTerm, input.targetQuantity),
    minimum = multiplyCents(perSlotTerm, input.minimumQuantity);
  if (!isMoneyCents(maximum) || maximum > 100000000)
    throw new ScheduleError('The maximum seven-day agreement exceeds the credit limit.');
  return { daily: perWindow[0], maximum, minimum };
}
