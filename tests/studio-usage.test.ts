import { describe, expect, it } from 'vitest';
import {
  forecastUsage,
  priorUsage,
  sizeUsagePurchase,
  usageFeatures,
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
    expect(small.targetUtilization).toBe(0.9);
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
    expect(after.expectedInput / purchase.inputTokens).toBeCloseTo(0.9, 3);
    expect(after.expectedOutput / purchase.outputTokens).toBeCloseTo(0.9, 3);
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
    expect(p.inputTokens).toBe(1063576);
    expect(p.outputTokens).toBe(5048);
    expect(p.outputTokens).toBeLessThan(8192);
  });
  it('replays a settled small Python task without a second costly input-floor pack', () => {
    // Sanitized historical receipt counts; this is offline replay, not a new live test
    // or held-out evidence that the cold-start prior generalizes to other tasks.
    const goal =
      'Add a dependency-free greeting utility and tests. Create broker_greeting.py at the repository root with greet(name): trim surrounding whitespace, return a greeting and raise ValueError for an empty or whitespace-only name. Create broker_tests/test_greeting.py using stdlib unittest to check a normal name, trimming, and empty-name rejection. Run python3 -m unittest discover -s broker_tests. Keep the change small and return the verified patch.';
    const f = forecastUsage(usageFeatures(goal), []);
    const p = sizeUsagePurchase(f, { input: 0, output: 0, calls: 0 }, 1048576, 2048, 0);
    let input = p.inputTokens,
      output = p.outputTokens;
    const receipts = [
      [2480, 1343],
      [895, 116],
      [2683, 1106],
      [2894, 233],
      [3102, 682],
      [2723, 150],
      [1041, 441],
      [1123, 100],
      [1124, 57],
      [1136, 275],
    ];
    for (const [usedInput, usedOutput] of receipts) {
      expect(input).toBeGreaterThanOrEqual(1048576);
      expect(output).toBeGreaterThanOrEqual(2048);
      input -= usedInput!;
      output -= usedOutput!;
    }
    expect(p.inputTokens).toBeLessThan(1179648);
    const newPrice = (p.inputTokens * 1.7 + p.outputTokens * 5.6) / 1000000;
    const oldPrice = (1179648 * 1.7 + 8192 * 5.6) / 1000000;
    expect(newPrice).toBeLessThan(oldPrice);
    expect(p.reservationLimited).toBe(true);
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
