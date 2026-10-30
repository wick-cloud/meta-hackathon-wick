/** Public *Cents fields keep their unit; one hundredth of a cent is $0.0001. */
export const MONEY_STEP_CENTS = 0.01;
/** New standalone VM/token orders have a one-cent minimum; balances may be smaller. */
export const MIN_ORDER_PRICE_CENTS = 1;
export const MAX_MONEY_CENTS = 1_000_000_000_000;

export function isMoneyCents(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_MONEY_CENTS)
    return false;
  const units = Math.round(value * 100);
  return Number.isSafeInteger(units) && units / 100 === value;
}
export function moneyUnits(cents: number | string): bigint {
  const amount = typeof cents === 'string' ? Number(cents) : cents;
  if (!isMoneyCents(amount)) throw new Error('Use USD amounts with at most four decimal places.');
  return BigInt(Math.round(amount * 100));
}
export function centsFromUnits(units: bigint): number {
  if (units < -100_000_000_000_000n || units > 100_000_000_000_000n)
    throw new Error('Money amount exceeds the supported limit.');
  return Number(units) / 100;
}
export function addCents(...values: (number | string)[]): number {
  return centsFromUnits(values.reduce<bigint>((total, value) => total + moneyUnits(value), 0n));
}
export function subtractCents(a: number | string, b: number | string): number {
  return centsFromUnits(moneyUnits(a) - moneyUnits(b));
}
export function multiplyCents(cents: number | string, quantity: number): number {
  if (!Number.isSafeInteger(quantity)) throw new Error('Money quantities must be whole numbers.');
  return centsFromUnits(moneyUnits(cents) * BigInt(quantity));
}
/** Decimal USD spelling for form values, without binary division artifacts. */
export function centsToUsd(cents: number): string {
  const units = moneyUnits(cents),
    negative = units < 0n;
  const magnitude = negative ? -units : units;
  const fraction = (magnitude % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${magnitude / 10_000n}${fraction ? `.${fraction}` : ''}`;
}
/** Parse the input's decimal spelling, never round an extra entered digit. */
export function usdToCents(value: string): number | undefined {
  if (value.length > 100) return undefined;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || !(match[2] || match[3])) return undefined;
  const digits = BigInt((match[2] || '0') + (match[3] || ''));
  if (!digits) return 0;
  const shift = 4 + Number(match[4] || 0) - (match[3]?.length || 0);
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 100) return undefined;
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  if (digits % divisor) return undefined;
  const units = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / divisor;
  try {
    return centsFromUnits(match[1] === '-' ? -units : units);
  } catch {
    return undefined;
  }
}
export function usdToMicros(value: string): number | undefined {
  const cents = usdToCents(value);
  if (cents === undefined) return undefined;
  const micros = Number(moneyUnits(cents) * 100n);
  return Number.isSafeInteger(micros) ? micros : undefined;
}
const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
export const formatMoney = (cents: number = 0): string => currency.format(cents / 100);
/** BigInt rounding keeps large provider totals and negative adjustments exact. */
export function formatMoneyMicros(value: string | bigint): string {
  const micros = BigInt(value),
    negative = micros < 0n;
  const units = ((negative ? -micros : micros) + 50n) / 100n;
  const whole = units / 10_000n;
  const fraction = (units % 10_000n).toString().padStart(4, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${negative && units ? '-' : ''}$${whole.toLocaleString('en-US')}.${fraction}`;
}
