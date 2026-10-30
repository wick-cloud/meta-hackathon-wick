import { describe, expect, it } from 'vitest';
import { packPrice } from '../src/server/inference/market.js';

const rates = {
  cost_input_rate: 1250000,
  cost_output_rate: 4250000,
  input_rate: 1650000,
  output_rate: 5500000,
  instant_markup_bps: 1000,
  minimum_price_cents: 1,
};
describe('prepaid pack pricing uses exact combined dimensions', () => {
  it('covers uncached provider costs after the fifteen percent fee', () => {
    expect(packPrice(rates, 100000, 20000)).toEqual({ costFloorCents: 24.71, priceCents: 27.5 });
    expect(packPrice({ ...rates, input_rate: 1, output_rate: 1 }, 100000, 20000)).toEqual({
      costFloorCents: 24.71,
      priceCents: 24.71,
    });
  });
  it('applies an explicit instant markup before rounding once', () => {
    expect(packPrice(rates, 100000, 20000, true)).toEqual({
      costFloorCents: 24.71,
      priceCents: 30.25,
    });
  });
  it('rounds the two dimensions together, without a separate rounding charge', () => {
    expect(
      packPrice(
        {
          ...rates,
          cost_input_rate: 1,
          cost_output_rate: 1,
          input_rate: 5000000000,
          output_rate: 5000000000,
        },
        1,
        1,
      ).priceCents,
    ).toBe(1);
  });
  it('keeps the integer result exact above the safe intermediate Number range', () => {
    expect(
      packPrice(
        { ...rates, input_rate: 1000000000000, output_rate: 1000000000000 },
        10000000,
        1000000,
      ).priceCents,
    ).toBe(1100000000);
  });
});
