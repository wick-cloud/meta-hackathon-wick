/** Output quota includes the model's reasoning and its visible answer. */
export const RECOMMENDED_OUTPUT_TOKENS = 2048;
export const INFERENCE_STARTER_PROMPT = 'Say hello in one sentence.';
export const OUTPUT_LIMIT_GUIDANCE =
  'Output tokens include reasoning and the visible answer. Start with 2,048 when your quota allows. Reaching the limit can leave an empty or partial answer; generated tokens still consume quota. A larger limit reduces this risk but does not guarantee an answer.';

export function exampleOutputBudget({
  availableOutputTokens = Infinity,
  minimumOutputTokens = 256,
  maximumOutputTokens = RECOMMENDED_OUTPUT_TOKENS,
}: {
  availableOutputTokens?: number;
  minimumOutputTokens?: number;
  maximumOutputTokens?: number;
}): number | null {
  const limit = Math.floor(
    Math.min(RECOMMENDED_OUTPUT_TOKENS, availableOutputTokens, maximumOutputTokens),
  );
  return Number.isFinite(limit) && limit >= Math.max(1, minimumOutputTokens) ? limit : null;
}

/** Kept as plain runnable JS so the same example can be copied and tested with a fake SDK. */
export function buildInferenceJavaScriptExample({
  baseURL,
  model,
  maxOutputTokens,
}: {
  baseURL: string;
  model: string;
  maxOutputTokens: number;
}): string {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
    throw new Error('A positive output budget is required.');
  return `import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';

const client = new OpenAI({
  apiKey: process.env.BROKER_API_KEY,
  baseURL: ${JSON.stringify(baseURL)},
  maxRetries: 0,
});

// Save this ID and request body for timeout recovery; reuse both unchanged.
// Only choose a new operation ID when you explicitly want a new paid call.
const requestId = process.env.BROKER_OPERATION_KEY || randomUUID();
console.error('Operation ID:', requestId);
const response = await client.chat.completions.create({
  model: ${JSON.stringify(model)},
  messages: [{ role: 'user', content: ${JSON.stringify(INFERENCE_STARTER_PROMPT)} }],
  max_tokens: ${maxOutputTokens}, // Includes reasoning and the visible answer.
  stream: false,
}, { headers: { 'Idempotency-Key': requestId } });

console.error('Receipt ID:', response.id);
console.error('Usage:', response.usage);
const choice = response.choices?.[0];
const answer = choice?.message?.content ?? '';
if (choice?.finish_reason === 'length') {
  if (answer.trim()) {
    console.log(answer);
    console.error('Partial answer: output limit reached. Generated tokens consumed quota.');
  } else {
    console.error('No final answer: output limit reached before a visible answer. Generated tokens consumed quota.');
  }
  console.error('Review the receipt and remaining quota before choosing a larger limit for a new paid call. No automatic retry was made.');
} else if (answer.trim()) {
  console.log(answer);
} else {
  console.error('No final answer returned. Review the receipt and usage before making another paid call.');
}`;
}
