import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { forecastUsage, sizeUsagePurchase } from '../src/server/coding/usage-estimator.js';

// Numeric, same-owner / mode / model-contract observations, oldest first. No API calls.
const file = process.argv[2];
if (!file) throw new Error('Usage: npm run studio:usage:evaluate -- numeric-samples.json');
if ((await stat(file)).size > 1024 * 1024) throw new Error('Training input exceeds 1 MiB.');
const data = z
  .object({
    inputReservationFloor: z.number().int().min(1).max(10_000_000),
    outputReservationFloor: z.number().int().min(1).max(8192),
    samples: z
      .array(
        z
          .object({
            features: z
              .object({
                goalBytes: z.number().min(0).max(16000),
                scope: z.number().min(1).max(16),
                repositoryFiles: z.number().min(0).max(150),
                manifestBytes: z.number().min(0).max(24000),
              })
              .strict(),
            input: z.number().int().positive().max(800_000_000),
            output: z.number().int().positive().max(655360),
            calls: z.number().int().min(2).max(80),
          })
          .strict(),
      )
      .min(20)
      .max(200),
  })
  .strict()
  .parse(JSON.parse(await readFile(file, 'utf8')));
const cut = Math.floor(data.samples.length * 0.8),
  training = data.samples.slice(0, cut),
  heldOut = data.samples.slice(cut);
let inputError = 0,
  outputError = 0,
  inputUsed = 0,
  outputUsed = 0,
  inputBought = 0,
  outputBought = 0,
  reservationLimited = 0,
  underestimated = 0;
for (const s of heldOut) {
  const f = forecastUsage(s.features, training),
    p = sizeUsagePurchase(
      f,
      { input: 0, output: 0, calls: 0 },
      data.inputReservationFloor,
      data.outputReservationFloor,
      0,
    );
  inputError += Math.abs(f.expectedInput - s.input);
  outputError += Math.abs(f.expectedOutput - s.output);
  inputUsed += s.input;
  outputUsed += s.output;
  inputBought += p.inputTokens;
  outputBought += p.outputTokens;
  if (p.reservationLimited) reservationLimited++;
  if (s.input > p.inputTokens || s.output > p.outputTokens) underestimated++;
}
console.log(
  JSON.stringify(
    {
      trainingSamples: training.length,
      heldOutSamples: heldOut.length,
      inputWeightedAbsoluteError: inputError / inputUsed,
      outputWeightedAbsoluteError: outputError / outputUsed,
      initialPackInputUtilization: inputUsed / inputBought,
      initialPackOutputUtilization: outputUsed / outputBought,
      reservationLimited,
      underestimatedTasks: underestimated,
      targetUtilization: 0.9,
      note: 'Offline forecast replay, not live provider validation. Utilization above 1 indicates an insufficient initial pack; refills and final-call headroom require call-level replay.',
    },
    null,
    2,
  ),
);
