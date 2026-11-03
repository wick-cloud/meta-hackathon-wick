import { describe, expect, it } from 'vitest';
import { parseExplicitBuyerDescription } from '../src/shared/muse-contracts.js';

describe('explicit buyer budgets preserve sentence punctuation and money precision', () => {
  it.each([
    ['maximum total $0.05.', 5],
    ['budget $10.00.', 1000],
    ['budget $10.', 1000],
    ['under $1.2, with 2 CPUs', 120],
    ['maximum $1.23.', 123],
    ['up to $1.234.', 123.4],
    ['budget $1.2345.', 123.45],
    ['budget $0.0001.', 0.01],
    ['budget $ 1.2345 USD.', 123.45],
    ['budget 1.2345 USD.', 123.45],
    ['maximum total 1.2345 dollars, including compute', 123.45],
    ['budget $1.2345; 2 CPUs', 123.45],
    ['budget ($1.2345).', 123.45],
  ])('parses the exact budget in %j', (description, expected) => {
    expect(parseExplicitBuyerDescription(description).maxPriceCents).toBe(expected);
  });

  it.each([
    'budget $1.23456',
    'budget $1.23456.',
    'budget $1.23456, including compute',
    'budget $ 1.23456 USD.',
    'budget 1.23456 USD.',
    'maximum 1.23456 dollars.',
    'budget $0.00001.',
    'budget $12.345678901.',
    'budget $1.23.45.',
    'budget $1234567.',
  ])('does not recover a shorter price prefix from %j', (description) => {
    expect(parseExplicitBuyerDescription(description).maxPriceCents).toBeUndefined();
  });

  it('keeps the smallest valid explicit budget across currency spans', () => {
    expect(
      parseExplicitBuyerDescription('Previous quote $10.00. Maximum total $0.05. Budget 1 USD.'),
    ).toMatchObject({ maxPriceCents: 5 });
  });

  it('does not change resource or region interpretation while preserving a punctuated budget', () => {
    expect(
      parseExplicitBuyerDescription(
        'I need 999 vCPUs and 17.5 GiB RAM in region: moon-1 for 45 minutes, maximum total $0.05.',
      ),
    ).toEqual({
      requirements: { cpu: 999, memoryGb: 17.5 },
      region: 'moon-1',
      durationMinutes: 45,
      maxPriceCents: 5,
    });
  });
});
