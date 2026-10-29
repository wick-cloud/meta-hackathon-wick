import type { AgreementInput, ScheduledOfferingInput } from '../../shared/agreements.js';
import { HttpError } from '../context.js';
import { integer, positiveNumber, shortText } from '../marketplace/data.js';
import { operationKey } from './credits.js';

export interface WindowTimes {
  startsAt: string;
  discountEndsAt: string;
  endsAt: string;
}
export function timeZone(value: unknown) {
  const zone = shortText(value, 'Time zone', 100);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
  } catch {
    throw new HttpError(400, 'Choose a valid IANA time zone.');
  }
  return zone;
}
export function clock(value: unknown) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new HttpError(400, 'Use a local time in HH:mm format.');
  return value;
}
export function datePlus(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
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
/** Reject DST gaps and duplicate local times; accepted bookings have one frozen UTC interpretation. */
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
    const at = naive + h * 3600000;
    const p = parts(at);
    offsets.add(Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]) - at);
  }
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((at) => parts(at).join() === [year, month, day, hour, minute].join());
  if (matches.length !== 1)
    throw new HttpError(
      400,
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
    throw new HttpError(400, 'Each capacity window must last between one minute and 24 hours.');
  return times;
}
export function windowCost(window: WindowTimes, discountRate: number, normalRate = 0) {
  const discountSeconds = (Date.parse(window.discountEndsAt) - Date.parse(window.startsAt)) / 1000;
  const normalSeconds = (Date.parse(window.endsAt) - Date.parse(window.discountEndsAt)) / 1000;
  return Math.max(
    1,
    Math.ceil((discountSeconds * discountRate + normalSeconds * normalRate) / 3600),
  );
}
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
        maxRateCentsPerHour: integer(v.continuation.maxRateCentsPerHour, 'Continuation rate', 1),
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
    maxDiscountRateCentsPerHour: integer(v.maxDiscountRateCentsPerHour, 'Discount rate', 1),
    ...(continuation ? { continuation } : {}),
  };
  if (input.minimumQuantity > input.targetQuantity)
    throw new HttpError(400, 'Minimum quantity cannot exceed the target.');
  const windows = Array.from({ length: 7 }, (_, i) =>
    windowOn(datePlus(date, i), start, discount, continuation?.until ?? discount, zone),
  );
  if (windows.some((w, i) => i > 0 && w.startsAt < windows[i - 1].endsAt))
    throw new HttpError(
      400,
      'Daily booked windows cannot overlap at a daylight-saving transition.',
    );
  if (Date.parse(windows[0].endsAt) <= now)
    throw new HttpError(400, 'The first capacity window has already ended.');
  const maxAmountCents = windows.reduce(
    (sum, w) =>
      sum +
      windowCost(w, input.maxDiscountRateCentsPerHour, continuation?.maxRateCentsPerHour) *
        input.targetQuantity,
    0,
  );
  if (!Number.isSafeInteger(maxAmountCents) || maxAmountCents > 100000000)
    throw new HttpError(400, 'The maximum seven-day agreement exceeds the credit limit.');
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
    discountRateCentsPerHour: integer(v.discountRateCentsPerHour, 'Discount rate', 1),
    normalRateCentsPerHour: integer(v.normalRateCentsPerHour, 'Normal rate', 1),
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
