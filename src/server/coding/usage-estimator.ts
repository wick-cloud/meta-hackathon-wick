import type { UsageFeatures, UsageForecast } from '../../shared/studio-usage.js';

export const USAGE_ESTIMATOR_VERSION = 'studio-usage-v2-low-planning';
export const TARGET_UTILIZATION = 0.9;
export const MAX_TRAINING_SAMPLES = 200;
const MIN_TRAINING_SAMPLES = 12;
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
export interface UsageSample {
  features: UsageFeatures;
  input: number;
  output: number;
  calls: number;
}
/** Numeric metadata only. Repository contents and goals are never training records. */
export function usageFeatures(
  goal: string,
  context: { files?: string[]; manifests?: { content: string }[] } = {},
): UsageFeatures {
  const actions =
    goal.match(
      /\b(add|fix|implement|create|change|update|refactor|migrate|test|integrate|remove|support)\b/gi,
    )?.length ?? 0;
  const files = new Set(
    goal.match(/[\w/-]+\.(?:py|tsx?|jsx?|rs|go|java|json|sql|css|html|ya?ml)\b/g) ?? [],
  ).size;
  return {
    goalBytes: Math.min(16000, Buffer.byteLength(goal, 'utf8')),
    scope: clamp(actions + files, 1, 16),
    repositoryFiles: Math.min(150, context.files?.length ?? 0),
    manifestBytes: Math.min(
      24000,
      (context.manifests ?? []).reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0),
    ),
  };
}
function validFeatures(f: UsageFeatures): boolean {
  return (
    !!f &&
    ['goalBytes', 'scope', 'repositoryFiles', 'manifestBytes'].every(
      (k) => Number.isFinite(f[k as keyof UsageFeatures]) && f[k as keyof UsageFeatures] >= 0,
    ) &&
    f.scope >= 1 &&
    f.goalBytes <= 16000 &&
    f.scope <= 16 &&
    f.repositoryFiles <= 150 &&
    f.manifestBytes <= 24000
  );
}
function vector(f: UsageFeatures): number[] {
  return [
    1,
    Math.log1p(f.goalBytes) / 8,
    f.scope / 8,
    Math.log1p(f.repositoryFiles) / 5,
    Math.log1p(f.manifestBytes) / 10,
  ];
}
/** Expert prior until enough completed, fully reconciled tasks exist. Includes reasoning. */
export function priorUsage(f: UsageFeatures): Omit<UsageSample, 'features'> {
  if (!validFeatures(f)) throw new Error('Invalid usage features.');
  const calls = clamp(5 + f.scope * 0.65 + Math.log1p(f.repositoryFiles) * 0.45, 6, 24);
  return {
    calls,
    input: 1800 + f.manifestBytes / 3 + f.goalBytes / 3 + calls * (1300 + f.scope * 100),
    output: 900 + calls * (280 + f.scope * 22),
  };
}
function clean(samples: UsageSample[]): UsageSample[] {
  // Callers supply chronological, same-owner / mode / output-contract observations.
  return samples
    .slice(-MAX_TRAINING_SAMPLES)
    .filter(
      (s) =>
        validFeatures(s.features) &&
        Number.isInteger(s.calls) &&
        s.calls >= 2 &&
        s.calls <= 80 &&
        Number.isInteger(s.input) &&
        s.input > 0 &&
        s.input <= 800_000_000 &&
        Number.isInteger(s.output) &&
        s.output > 0 &&
        s.output <= 655360,
    );
}
type Target = 'input' | 'output' | 'calls';
/** Ridge regression on log residuals of the prior; five coefficients, no ML service. */
function fit(samples: UsageSample[], target: Target): number[] {
  const size = 5;
  const a = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size + 1 }, (_, j) => (i === j ? 3 : 0)),
  );
  for (const s of samples) {
    const x = vector(s.features),
      y = clamp(Math.log(s[target] / priorUsage(s.features)[target]), -2.3, 2.3);
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) a[i]![j]! += x[i]! * x[j]!;
      a[i]![size]! += x[i]! * y;
    }
  }
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let r = col + 1; r < size; r++)
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const divisor = a[col]![col]!;
    for (let j = col; j <= size; j++) a[col]![j]! /= divisor;
    for (let r = 0; r < size; r++)
      if (r !== col) {
        const multiplier = a[r]![col]!;
        for (let j = col; j <= size; j++) a[r]![j]! -= multiplier * a[col]![j]!;
      }
  }
  return a.map((row) => row[size]!);
}
function predictor(samples: UsageSample[]) {
  const coefficients =
    samples.length >= MIN_TRAINING_SAMPLES
      ? (['input', 'output', 'calls'] as const).map((target) => fit(samples, target))
      : null;
  return (f: UsageFeatures) => {
    const prior = priorUsage(f),
      x = vector(f);
    const predict = (target: Target, i: number) =>
      prior[target] *
      (coefficients
        ? Math.exp(
            clamp(
              coefficients[i]!.reduce((sum, c, j) => sum + c * x[j]!, 0),
              Math.log(0.25),
              Math.log(4),
            ),
          )
        : 1);
    return {
      input: predict('input', 0),
      output: predict('output', 1),
      calls: clamp(predict('calls', 2), 2, 64),
    };
  };
}
export function forecastUsage(features: UsageFeatures, history: UsageSample[]): UsageForecast {
  const samples = clean(history),
    predict = predictor(samples),
    expected = predict(features);
  let validation: UsageForecast['validation'] = null;
  // Conservative cold-start interval; learned one-sided errors replace it once measurable.
  let inputMultiplier = samples.length >= MIN_TRAINING_SAMPLES ? 1.25 : 1.5,
    outputMultiplier = inputMultiplier;
  // Chronological holdout, never random train/test mixing. No score from fitted examples.
  if (samples.length >= 20) {
    const cut = Math.floor(samples.length * 0.8),
      heldOut = samples.slice(cut),
      baseline = predictor(samples.slice(0, cut));
    let inputError = 0,
      outputError = 0,
      inputTotal = 0,
      outputTotal = 0;
    const inputRatios: number[] = [],
      outputRatios: number[] = [];
    for (const s of heldOut) {
      const p = baseline(s.features);
      inputError += Math.abs(s.input - p.input);
      outputError += Math.abs(s.output - p.output);
      inputTotal += s.input;
      outputTotal += s.output;
      inputRatios.push(s.input / p.input);
      outputRatios.push(s.output / p.output);
    }
    validation = {
      samples: heldOut.length,
      inputError: inputError / inputTotal,
      outputError: outputError / outputTotal,
    };
    const upper = (ratios: number[]) =>
      clamp(ratios.sort((a, b) => a - b)[Math.ceil(ratios.length * 0.9) - 1]!, 1, 3);
    inputMultiplier = upper(inputRatios);
    outputMultiplier = upper(outputRatios);
  }
  return {
    version: USAGE_ESTIMATOR_VERSION,
    basis: samples.length >= MIN_TRAINING_SAMPLES ? 'learned' : 'cold_start',
    trainingSamples: samples.length,
    targetUtilization: TARGET_UTILIZATION,
    expectedInput: Math.ceil(expected.input),
    expectedOutput: Math.ceil(expected.output),
    expectedCalls: Math.ceil(expected.calls),
    headroom: { inputMultiplier, outputMultiplier },
    validation,
  };
}
export interface UsageProgress {
  input: number;
  output: number;
  calls: number;
}
/** Forecasts size a purchase; qualified per-call reservations remain hard constraints. */
export function sizeUsagePurchase(
  forecast: UsageForecast,
  progress: UsageProgress,
  inputFloor: number,
  outputFloor: number,
  round: number,
) {
  if (
    ![
      progress.input,
      progress.output,
      progress.calls,
      inputFloor,
      outputFloor,
      round,
      forecast.expectedInput,
      forecast.expectedOutput,
      forecast.expectedCalls,
    ].every(Number.isInteger) ||
    progress.input < 0 ||
    progress.output < 0 ||
    progress.calls < 0 ||
    inputFloor < 1 ||
    outputFloor < 1 ||
    inputFloor > 10_000_000 ||
    outputFloor > 8192 ||
    round < 0 ||
    round > 20 ||
    forecast.expectedInput < 1 ||
    forecast.expectedOutput < 1 ||
    forecast.expectedCalls < 1 ||
    forecast.expectedCalls > 64 ||
    ![forecast.headroom.inputMultiplier, forecast.headroom.outputMultiplier].every(
      (n) => Number.isFinite(n) && n >= 1 && n <= 3,
    )
  )
    throw new Error('Invalid usage purchase bounds.');
  // A missed forecast buys a bounded remaining chunk, not the entire original allowance again.
  const remainingCalls =
    round === 0 ? forecast.expectedCalls : clamp(forecast.expectedCalls - progress.calls, 2, 6);
  const inputPerCall = Math.max(
    forecast.expectedInput / forecast.expectedCalls,
    progress.calls ? progress.input / progress.calls : 0,
  );
  const outputPerCall = Math.max(
    forecast.expectedOutput / forecast.expectedCalls,
    progress.calls ? progress.output / progress.calls : 0,
  );
  const input = round === 0 ? forecast.expectedInput : inputPerCall * remainingCalls;
  const output = round === 0 ? forecast.expectedOutput : outputPerCall * remainingCalls;
  const targetInput = Math.ceil(input / TARGET_UTILIZATION),
    targetOutput = Math.ceil(output / TARGET_UTILIZATION);
  // When a hard reservation dominates, a refill repeats that costly reservation.
  // Include calibrated demand headroom plus one complete final call; never shrink
  // the certified bound to make an attractive statistical estimate fit.
  const inputTokens = Math.min(
    10_000_000,
    Math.max(
      targetInput,
      Math.ceil(
        inputFloor > targetInput
          ? inputFloor + input * forecast.headroom.inputMultiplier
          : inputFloor + input - inputPerCall,
      ),
    ),
  );
  const outputTokens = Math.min(
    10_000_000,
    Math.max(
      targetOutput,
      Math.ceil(
        inputFloor > targetInput
          ? outputFloor + output * forecast.headroom.outputMultiplier
          : outputFloor + output - outputPerCall,
      ),
    ),
  );
  return {
    inputTokens,
    outputTokens,
    reservationLimited: inputTokens > targetInput || outputTokens > targetOutput,
  };
}
