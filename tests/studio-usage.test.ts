import { describe, expect, it } from 'vitest';
import {
  forecastUsage,
  priorUsage,
  sizeUsagePurchase,
  usageFeatures,
  TARGET_UTILIZATION,
  type UsageSample,
} from '../src/server/coding/usage-estimator.js';

function history(size: number): UsageSample[] {
  return Array.from({ length: size }, (_, i) => {
    const features = {
      goalBytes: 80 + (i % 10) * 65,
      scope: 2 + (i % 7),
      repositoryFiles: 5 + (i % 12) * 8,
      manifestBytes: (i % 9) * 150,
    };
    const prior = priorUsage(features),
      noise = 1 + Math.sin(i * 7) * 0.03;
    return {
      features,
      input: Math.round(prior.input * 0.72 * noise),
      output: Math.round(prior.output * 0.65 * noise),
      calls: Math.round(prior.calls),
    };
  });
}
describe('Studio token usage estimator', () => {
  it('uses an explicit cold-start forecast instead of a fixed multi-call pack', () => {
    const small = forecastUsage(
      usageFeatures('Add a greeting function in greeting.py and add tests.'),
      [],
    );
    const large = forecastUsage(
      usageFeatures(
        'Migrate the API, refactor authentication, implement billing, add tests, integrate database and update migrations.',
      ),
      [],
    );
    expect(small.basis).toBe('cold_start');
    expect(small.validation).toBeNull();
    expect(small.targetUtilization).toBe(TARGET_UTILIZATION);
    expect(small.expectedInput).toBeLessThan(30000);
    expect(small.expectedOutput).toBeLessThan(6000);
    expect(large.expectedInput).toBeGreaterThan(small.expectedInput);
    expect(large.expectedOutput).toBeGreaterThan(small.expectedOutput);
  });
  it('learns lower usage from settled observations and reports a separate chronological holdout', () => {
    const data = history(100),
      f = data[80]!.features;
    const before = forecastUsage(f, []),
      after = forecastUsage(f, data);
    expect(after.basis).toBe('learned');
    expect(after.expectedInput).toBeLessThan(before.expectedInput);
    expect(after.expectedOutput).toBeLessThan(before.expectedOutput);
    expect(after.validation?.samples).toBe(20);
    expect(after.validation!.inputError).toBeLessThan(0.1);
    expect(after.validation!.outputError).toBeLessThan(0.1);
    const purchase = sizeUsagePurchase(after, { input: 0, output: 0, calls: 0 }, 1, 1, 0);
    expect(after.expectedInput / purchase.inputTokens).toBeCloseTo(TARGET_UTILIZATION, 3);
    expect(after.expectedOutput / purchase.outputTokens).toBeCloseTo(TARGET_UTILIZATION, 3);
  });
  it('does not pretend a one-million-token provider minimum achieves 90% utilization', () => {
    const estimate = forecastUsage(usageFeatures('Fix a typo and add a regression test.'), []);
    const p = sizeUsagePurchase(estimate, { input: 0, output: 0, calls: 0 }, 1048576, 2048, 0);
    expect(p.reservationLimited).toBe(true);
    expect(p.inputTokens).toBeGreaterThanOrEqual(1048576);
    expect(p.inputTokens).toBeLessThan(1179648);
    expect(estimate.expectedInput / p.inputTokens).toBeLessThan(0.1);
    expect(p.outputTokens).toBeGreaterThanOrEqual(2048);
  });
  it('uses actual per-call consumption to size a bounded refill after an underestimate', () => {
    const f = forecastUsage(usageFeatures('Add an average utility and tests.'), []);
    const p = sizeUsagePurchase(f, { input: 50000, output: 10000, calls: 10 }, 1048576, 2048, 1);
    expect(p.inputTokens).toBe(1054076);
    expect(p.outputTokens).toBe(2200);
    expect(p.outputTokens).toBeLessThan(8192);
  });
  it('keeps a two-call refill usable after its first input reservation settles', () => {
    const f = {
      ...forecastUsage(usageFeatures('Add a utility.'), []),
      expectedInput: 9000,
      expectedOutput: 1800,
      expectedCalls: 9,
    };
    const refill = sizeUsagePurchase(f, { input: 15000, output: 1500, calls: 15 }, 8000, 1024, 3);
    expect(refill.inputTokens).toBe(9100);
    expect(refill.inputTokens - 1000).toBeGreaterThanOrEqual(8000);
    expect(refill.outputTokens).toBe(1024);
    expect(
      sizeUsagePurchase(f, { input: 8000, output: 800, calls: 8 }, 8000, 1024, 1).inputTokens,
    ).toBe(8000);
  });
  it('buys near the reported task estimate rather than an extra full-context pack', () => {
    const f = {
      ...forecastUsage(usageFeatures('Add a small utility and test it.'), []),
      expectedInput: 13443,
      expectedOutput: 3346,
      expectedCalls: 8,
    };
    const p = sizeUsagePurchase(f, { input: 0, output: 0, calls: 0 }, 7000, 2048, 0);
    expect(p).toEqual({ inputTokens: 14788, outputTokens: 3681, reservationLimited: false });
    const refill = sizeUsagePurchase(f, { input: 13000, output: 3200, calls: 8 }, 8000, 2048, 1);
    expect(refill.inputTokens).toBeLessThan(p.inputTokens);
    expect(refill.outputTokens).toBe(2048);
    expect(refill.inputTokens).toBeGreaterThanOrEqual(8000);
    expect(p.inputTokens).toBeLessThan(1048576 / 50);
  });
  it('only expands a small pack when the exact next request needs more, without integer rounding drift', () => {
    const f = {
      ...forecastUsage(usageFeatures('Fix a typo.'), []),
      expectedInput: 100,
      expectedOutput: 20,
      expectedCalls: 2,
    };
    expect(sizeUsagePurchase(f, { input: 0, output: 0, calls: 0 }, 1, 1, 0)).toEqual({
      inputTokens: 110,
      outputTokens: 22,
      reservationLimited: false,
    });
    expect(sizeUsagePurchase(f, { input: 0, output: 0, calls: 0 }, 5000, 2048, 0)).toEqual({
      inputTokens: 5000,
      outputTokens: 2048,
      reservationLimited: true,
    });
  });
  it('bounds training, rejects malformed observations and keeps singular histories stable', () => {
    const s = history(1)[0]!;
    const a = forecastUsage(
      s.features,
      Array.from({ length: 10000 }, () => s),
    );
    expect(a.trainingSamples).toBe(200);
    expect(a.expectedInput).toBeGreaterThan(0);
    expect(Number.isFinite(a.expectedOutput)).toBe(true);
    expect(
      forecastUsage(s.features, [
        { ...s, input: NaN },
        { ...s, calls: 1000 },
      ]).trainingSamples,
    ).toBe(0);
    expect(() => forecastUsage({ ...s.features, goalBytes: Infinity }, [])).toThrow(
      'Invalid usage features',
    );
    expect(() => sizeUsagePurchase(a, { input: -1, output: 0, calls: 0 }, 1, 1, 0)).toThrow(
      'Invalid usage purchase',
    );
  });
  it('retains only bounded numeric features, including Unicode and large manifests', () => {
    const f = usageFeatures('修复测试 🧪'.repeat(1000), {
      files: Array(1000).fill('secret.py'),
      manifests: [{ content: 'x'.repeat(100000) }],
    });
    expect(f.goalBytes).toBe(16000);
    expect(f.repositoryFiles).toBe(150);
    expect(f.manifestBytes).toBe(24000);
    expect(JSON.stringify(f)).not.toContain('secret');
    expect(Object.values(f).every(Number.isFinite)).toBe(true);
  });
});
