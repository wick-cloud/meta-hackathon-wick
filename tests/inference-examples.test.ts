import { describe, expect, it, vi } from 'vitest';
import {
  buildInferenceJavaScriptExample,
  exampleOutputBudget,
} from '../src/client/inference-examples';

const options = {
  baseURL: 'https://broker.example/api/v1',
  model: 'meta/muse-spark-open',
  maxOutputTokens: 2048,
};
const usage = { prompt_tokens: 159, completion_tokens: 512, total_tokens: 671 };
function response(content: string | null, finishReason = 'stop') {
  return {
    id: 'fixture-receipt',
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage,
  };
}
async function executeExample(
  result: ReturnType<typeof response>,
  operationKey: string | undefined = 'saved-logical-call',
) {
  const create = vi.fn().mockResolvedValue(result);
  const constructor = vi.fn();
  class FakeOpenAI {
    constructor(config: unknown) {
      constructor(config);
    }
    chat = { completions: { create } };
  }
  const output = { log: vi.fn(), error: vi.fn() };
  const randomUUID = vi.fn(() => 'generated-logical-call');
  const source = buildInferenceJavaScriptExample(options).replace(/^import .*;\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('OpenAI', 'randomUUID', 'process', 'console', source)(
    FakeOpenAI,
    randomUUID,
    { env: { BROKER_API_KEY: 'fixture-key', BROKER_OPERATION_KEY: operationKey } },
    output,
  );
  return {
    create,
    constructor,
    output,
    randomUUID,
    diagnostics: output.error.mock.calls.map((args) => args.join(' ')).join('\n'),
  };
}

describe('copied inference JavaScript example', () => {
  it('executes a single bounded SDK call, prints normal content and reports usage', async () => {
    const run = await executeExample(response('Hello!'));
    expect(run.constructor).toHaveBeenCalledExactlyOnceWith({
      apiKey: 'fixture-key',
      baseURL: options.baseURL,
      maxRetries: 0,
    });
    expect(run.create).toHaveBeenCalledExactlyOnceWith(
      {
        model: options.model,
        messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
        max_tokens: 2048,
        stream: false,
      },
      { headers: { 'Idempotency-Key': 'saved-logical-call' } },
    );
    expect(run.output.log).toHaveBeenCalledExactlyOnceWith('Hello!');
    expect(run.output.error).toHaveBeenCalledWith('Usage:', usage);
    expect(run.output.error).toHaveBeenCalledWith('Receipt ID:', 'fixture-receipt');
    expect(run.diagnostics).not.toMatch(/No final answer|Partial answer/);
  });

  it('diagnoses empty length-limited output and preserves usage without another paid call', async () => {
    const run = await executeExample(response('', 'length'));
    expect(run.create).toHaveBeenCalledTimes(1);
    expect(run.output.log).not.toHaveBeenCalled();
    expect(run.output.error).toHaveBeenCalledWith('Usage:', usage);
    expect(run.output.error).toHaveBeenCalledWith('Receipt ID:', 'fixture-receipt');
    expect(run.diagnostics).toContain(
      'No final answer: output limit reached before a visible answer',
    );
    expect(run.diagnostics).toContain('Generated tokens consumed quota');
    expect(run.diagnostics).toContain('No automatic retry was made');
  });

  it('shows partial content while identifying it as incomplete', async () => {
    const run = await executeExample(response('The first step is', 'length'));
    expect(run.output.log).toHaveBeenCalledExactlyOnceWith('The first step is');
    expect(run.diagnostics).toContain('Partial answer: output limit reached');
    expect(run.diagnostics).toContain('Generated tokens consumed quota');
    expect(run.create).toHaveBeenCalledTimes(1);
  });

  it.each([null, '', ' \n '])(
    'diagnoses missing final content %j on other finishes',
    async (content) => {
      const run = await executeExample(response(content, 'stop'));
      expect(run.output.log).not.toHaveBeenCalled();
      expect(run.diagnostics).toContain('No final answer returned');
      expect(run.output.error).toHaveBeenCalledWith('Usage:', usage);
      expect(run.output.error).toHaveBeenCalledWith('Receipt ID:', 'fixture-receipt');
      expect(run.create).toHaveBeenCalledTimes(1);
    },
  );

  it('reuses the saved logical operation ID when a caller investigates the same request', async () => {
    const first = await executeExample(response('Hello!'), 'persisted-call-id');
    const second = await executeExample(response('Hello!'), 'persisted-call-id');
    for (const run of [first, second]) {
      expect(run.randomUUID).not.toHaveBeenCalled();
      expect(run.create.mock.calls[0][1].headers['Idempotency-Key']).toBe('persisted-call-id');
      expect(run.output.error).toHaveBeenCalledWith('Operation ID:', 'persisted-call-id');
    }
  });

  it('generates one operation ID and prints the exact ID sent on a new call', async () => {
    const run = await executeExample(response('Hello!'), '');
    expect(run.randomUUID).toHaveBeenCalledTimes(1);
    expect(run.create.mock.calls[0][1].headers['Idempotency-Key']).toBe('generated-logical-call');
    expect(run.output.error).toHaveBeenCalledWith('Operation ID:', 'generated-logical-call');
  });
});

describe('example output allowance', () => {
  it('recommends 2048 tokens when remaining quota and route capacity allow it', () => {
    expect(exampleOutputBudget({})).toBe(2048);
    expect(exampleOutputBudget({ availableOutputTokens: 8000, maximumOutputTokens: 8192 })).toBe(
      2048,
    );
  });

  it.each([
    [400, 256, 4096, 400],
    [8000, 256, 1024, 1024],
    [300.9, 256, 4096, 300],
    [256, 256, 256, 256],
  ])('caps quota %s and route %s/%s at %s', (available, minimum, maximum, expected) => {
    const budget = exampleOutputBudget({
      availableOutputTokens: available,
      minimumOutputTokens: minimum,
      maximumOutputTokens: maximum,
    });
    expect(budget).toBe(expected);
    expect(budget).toBeLessThanOrEqual(available);
    expect(budget).toBeLessThanOrEqual(maximum);
  });

  it.each([
    [255, 256, 4096],
    [0, 1, 4096],
    [8000, 512, 256],
    [8000, 4096, 8192],
  ])(
    'withholds a call below the route minimum (%s remaining, %s minimum, %s maximum)',
    (available, minimum, maximum) => {
      expect(
        exampleOutputBudget({
          availableOutputTokens: available,
          minimumOutputTokens: minimum,
          maximumOutputTokens: maximum,
        }),
      ).toBeNull();
    },
  );
});
