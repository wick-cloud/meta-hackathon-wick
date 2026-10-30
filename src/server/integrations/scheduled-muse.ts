import { isMoneyCents } from '../../shared/money.js';
import type { CatalogItem } from '../../shared/types.js';

const nullableString = { type: ['string', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const nullableMoney = { type: ['number', 'null'], multipleOf: 0.01 };
const properties = {
  timeZone: nullableString,
  startDate: nullableString,
  windowStart: nullableString,
  windowEnd: nullableString,
  minimumQuantity: nullableInteger,
  targetQuantity: nullableInteger,
  capacityQuantity: nullableInteger,
  region: nullableString,
  catalogId: nullableString,
  maxDiscountRateCentsPerHour: nullableMoney,
  discountRateCentsPerHour: nullableMoney,
  normalRateCentsPerHour: nullableMoney,
  continuationEnabled: { type: ['boolean', 'null'] },
  continuationUntil: nullableString,
  maxNormalRateCentsPerHour: nullableMoney,
  availableUntil: nullableString,
  weekdays: {
    anyOf: [{ type: 'array', items: { type: 'integer' }, maxItems: 7 }, { type: 'null' }],
  },
};
export const scheduledDraftSchema = {
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
};

/** Model output can only fill editable fields; never authority, funding or allocation identifiers. */
export function scheduledDraft(
  value: unknown,
  kind: 'agreement' | 'offering',
  catalog: CatalogItem[],
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid scheduled draft.');
  const row = value as Record<string, unknown>,
    result: Record<string, unknown> = {};
  if (Object.keys(row).some((key) => !(key in properties)))
    throw new Error('Scheduled draft contains unsupported fields.');
  const text = (key: string, max = 150) => {
    const value = row[key];
    if (value == null) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new Error('Invalid scheduled draft field.');
    return value.trim();
  };
  const number = (key: string, max = 100000000) => {
    const value = row[key];
    if (value == null) return undefined;
    const monetary = key.includes('Cents');
    if (
      !(monetary ? isMoneyCents(value) : Number.isSafeInteger(value)) ||
      Number(value) < (monetary ? 0.01 : 1) ||
      Number(value) > max
    )
      throw new Error('Invalid scheduled draft number.');
    return Number(value);
  };
  const zone = text('timeZone');
  if (zone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone }).format();
    } catch {
      throw new Error('Invalid schedule timezone.');
    }
    result.timeZone = zone;
  }
  const date = text('startDate', 10);
  if (date) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw new Error('Invalid schedule date.');
    result.startDate = date;
  }
  for (const field of ['windowStart', 'windowEnd', 'availableUntil', 'continuationUntil']) {
    const value = text(field, 5);
    if (value) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Invalid schedule time.');
      result[field] = value;
    }
  }
  const region = text('region', 120);
  if (region) result.region = region;
  const catalogId = text('catalogId', 200);
  if (catalogId) {
    if (!catalog.some((c) => c.approved && c.id === catalogId))
      throw new Error('Scheduled draft selected an unavailable configuration.');
    result.catalogId = catalogId;
  }
  for (const field of ['minimumQuantity', 'targetQuantity', 'capacityQuantity']) {
    const value = number(field, 20);
    if (value !== undefined) result[field] = value;
  }
  if (
    result.minimumQuantity &&
    result.targetQuantity &&
    Number(result.minimumQuantity) > Number(result.targetQuantity)
  )
    throw new Error('Minimum exceeds target quantity.');
  for (const field of [
    'maxDiscountRateCentsPerHour',
    'discountRateCentsPerHour',
    'normalRateCentsPerHour',
    'maxNormalRateCentsPerHour',
  ]) {
    const value = number(field);
    if (value !== undefined) result[field] = value;
  }
  if (row.weekdays != null) {
    if (
      !Array.isArray(row.weekdays) ||
      row.weekdays.length < 1 ||
      row.weekdays.length > 7 ||
      row.weekdays.some((n) => !Number.isInteger(n) || n < 0 || n > 6)
    )
      throw new Error('Invalid schedule weekdays.');
    result.weekdays = [...new Set(row.weekdays)];
  }
  if (row.continuationEnabled != null) {
    if (
      typeof row.continuationEnabled !== 'boolean' ||
      (row.continuationEnabled && !/continu|published|full.price|normal.rate/i.test(description))
    )
      throw new Error('Continuation was not explicitly requested.');
    result.continuationEnabled = row.continuationEnabled;
  }
  if (kind === 'agreement') {
    delete result.capacityQuantity;
    delete result.catalogId;
    delete result.availableUntil;
    delete result.weekdays;
    delete result.discountRateCentsPerHour;
    delete result.normalRateCentsPerHour;
    if (
      result.continuationEnabled !== undefined ||
      result.continuationUntil ||
      result.maxNormalRateCentsPerHour
    ) {
      result.continuation = {
        enabled: result.continuationEnabled ?? false,
        ...(result.continuationUntil ? { until: result.continuationUntil } : {}),
        ...(result.maxNormalRateCentsPerHour
          ? { maxRateCentsPerHour: result.maxNormalRateCentsPerHour }
          : {}),
      };
    }
    delete result.continuationEnabled;
    delete result.continuationUntil;
    delete result.maxNormalRateCentsPerHour;
  } else {
    for (const key of [
      'startDate',
      'minimumQuantity',
      'targetQuantity',
      'region',
      'maxDiscountRateCentsPerHour',
      'continuationEnabled',
      'continuationUntil',
      'maxNormalRateCentsPerHour',
    ])
      delete result[key];
  }
  return result;
}
