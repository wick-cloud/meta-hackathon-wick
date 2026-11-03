import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../src/server/context.js';
import { loadConfig } from '../src/server/config.js';
import { createDemoIdentity, demoIdentity, demoIpDigest } from '../src/server/demo/access.js';
import { demoBootstrapCommand, demoPythonScript } from '../src/server/demo/script.js';
import { demoReceiptFacts, type DemoReceiptFacts } from '../src/server/demo/receipt.js';
import { inputReservation, type RuntimeRoute } from '../src/server/inference/runtime.js';

function context(trustProxy = false, production = false) {
  return {
    config: loadConfig({
      NODE_ENV: production ? 'production' : 'test',
      APP_URL: production ? 'https://broker.example' : 'http://localhost:3000',
      DATABASE_URL: 'postgresql://fixture:fixture@localhost/unused',
      BETTER_AUTH_SECRET: 'homepage-demo-unit-secret-at-least-32-characters',
      WICK_MODE: 'fixture',
      MUSE_MODE: 'fixture',
      AUTH_TRUST_RAILWAY_PROXY: String(trustProxy),
    }),
  } as AppContext;
}
function request(headers: Record<string, string> = {}, remoteAddress = '192.0.2.15') {
  return { headers, raw: { socket: { remoteAddress } } } as FastifyRequest;
}

describe('anonymous demo identity', () => {
  it('defaults live sponsorship and explicit fixture demo admission off', () => {
    const { config } = context();
    expect(config.liveDemoEnabled).toBe(false);
    expect(config.liveDemoAllowFixtures).toBe(false);
  });
  it('ignores forwarded headers unless the trusted Railway edge is explicitly configured', () => {
    const ctx = context();
    const direct = demoIpDigest(ctx, request());
    expect(
      demoIpDigest(
        ctx,
        request({ 'x-real-ip': '203.0.113.77', 'x-forwarded-for': '198.51.100.9' }),
      ),
    ).toBe(direct);
    expect(demoIpDigest(ctx, request({}, '::ffff:192.0.2.15'))).toBe(direct);
    expect(direct).toMatch(/^[a-f0-9]{64}$/);
    expect(direct).not.toContain('192.0.2.15');
  });
  it('uses a valid edge-observed address and never an attacker-controlled XFF chain', () => {
    const ctx = context(true);
    const first = demoIpDigest(
      ctx,
      request({ 'x-real-ip': '203.0.113.77', 'x-forwarded-for': '192.0.2.8' }),
    );
    expect(
      demoIpDigest(
        ctx,
        request({ 'x-real-ip': '203.0.113.77', 'x-forwarded-for': '198.51.100.9, 127.0.0.1' }),
      ),
    ).toBe(first);
    expect(demoIpDigest(ctx, request({ 'x-real-ip': '203.0.113.78' }))).not.toBe(first);
    expect(demoIpDigest(ctx, request({ 'x-real-ip': 'not-an-IP' }))).toBe(
      demoIpDigest(ctx, request()),
    );
    expect(demoIpDigest(ctx, request({ 'x-real-ip': '192.0.2.4, 192.0.2.5' }))).toBe(
      demoIpDigest(ctx, request()),
    );
  });
  it('rejects malformed and duplicate anonymous cookies', () => {
    const ctx = context();
    const secret = randomBytes(32).toString('base64url');
    for (const cookie of [
      '',
      'wick_demo=short',
      `wick_demo=${secret}; wick_demo=${secret}`,
      `wick_demo=${secret}%00`,
      'other=cookie',
    ])
      expect(demoIdentity(ctx, request({ cookie }))).toBeNull();
    const parsed = demoIdentity(ctx, request({ cookie: `unrelated=x; wick_demo=${secret}` }));
    expect(parsed?.visitorDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });
  it('mints secure opaque cookies and retains the same identity across a repeat request', () => {
    const ctx = context(false, true);
    let cookie = '';
    const reply = {
      header: (_name: string, value: string) => {
        cookie = value;
      },
    } as unknown as FastifyReply;
    const issued = createDemoIdentity(ctx, request(), reply);
    expect(cookie).toMatch(/^wick_demo=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('; Secure');
    const received = request({ cookie: cookie.split(';')[0]! });
    expect(demoIdentity(ctx, received)).toEqual(issued);
    cookie = '';
    expect(createDemoIdentity(ctx, received, reply)).toEqual(issued);
    expect(cookie).toBe('');
  });
});

/** Public rows as the award stores them, including private catalog fields that must not leak. */
function sampleReceipt(extraBids = 0): DemoReceiptFacts {
  const sponsored = {
    total_price_cents: '7.2',
    created_at: new Date('2026-11-03T12:00:00Z'),
    offering_snapshot: {
      catalog: { provider: 'modal', id: 'modal:micro:auto' },
      demoSponsorship: { effectivePriceCents: 1, sponsorCreditCents: 6.2 },
    },
  };
  const rival = {
    total_price_cents: '3.14',
    created_at: new Date('2026-11-03T12:00:01Z'),
    offering_snapshot: { catalog: { provider: 'e2b', id: 'e2b:micro:auto' } },
  };
  return demoReceiptFacts({
    vm: {
      catalog_snapshot: {
        provider: 'modal',
        profile: 'micro',
        cpu: 0.25,
        memoryGb: 0.5,
        organizationId: 'org_private_fixture',
        groupId: 'group_private_fixture',
      },
      quote_snapshot: {
        totalPriceCents: 7.2,
        demoSponsorship: { effectivePriceCents: 1, sponsorCreditCents: 6.2 },
      },
    },
    bids: [sponsored, rival, ...Array.from({ length: extraBids }, () => rival)],
    tokenPriceCents: '1.8',
    leaseMinutes: 15,
    inputTokens: 5000,
    outputTokens: 2048,
  });
}

const pythonHarness = `import builtins, contextlib, getpass, io, json, sys, urllib.error, urllib.request
case = json.load(sys.stdin)
state = {"input": case["availableInput"], "output": case["availableOutput"], "consumed": case["consumed"]}
seen = []
def network(req, timeout):
    headers = dict((name.lower(), value) for name, value in req.header_items())
    entry = {"url": req.full_url, "timeout": timeout,
             "authenticated": headers.get("authorization") == "Bearer wbk_fixture-test-key"}
    seen.append(entry)
    if req.data is None:
        entry["method"] = "GET"
        if case["balance"] == "unavailable":
            raise urllib.error.HTTPError(req.full_url, 503, "Unavailable", {}, io.BytesIO(b"{}"))
        payload = {"items": [{"availableInputTokens": state["input"], "availableOutputTokens": state["output"],
                              "consumedOutputTokens": state["consumed"], "heldOutputTokens": 0}]}
    else:
        entry.update({"method": "POST", "body": json.loads(req.data), "operation": headers.get("idempotency-key"),
                      "availableInput": state["input"], "availableOutput": state["output"]})
        outcome = case["outcomes"].pop(0) if case["outcomes"] else "success"
        if outcome == "timeout":
            raise TimeoutError("fixture timeout")
        if outcome == "rejected":
            raise urllib.error.HTTPError(req.full_url, 429, "Too many calls", {}, io.BytesIO(b'{"error":"Demo request allowance exhausted."}'))
        # Roughly Muse's observed framing plus byte-level BPE content.
        prompt = 150 + sum(len(m["content"].encode()) for m in entry["body"]["messages"]) // 3
        state["input"] -= prompt
        state["output"] -= 148
        state["consumed"] += 148
        answer = case["answers"].pop(0) if case["answers"] else "Hello from fixture Muse"
        payload = {"choices": [{"message": {"content": answer}}], "usage": {"prompt_tokens": prompt, "completion_tokens": 148}}
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, limit): return json.dumps(payload).encode()
    return Response()
def ask(prompt):
    print(prompt, end="")
    if not case["questions"]:
        raise EOFError
    return case["questions"].pop(0)
getpass.getpass = lambda prompt: "wbk_fixture-test-key"
builtins.input = ask
urllib.request.urlopen = network
out = io.StringIO()
namespace = {}
with contextlib.redirect_stdout(out):
    exec(compile(case["script"], "hello_muse.py", "exec"), namespace)
print(json.dumps({"requests": seen, "output": out.getvalue(), "keyCleared": namespace.get("key") == ""}))
`;
interface ExampleRequest {
  method: 'GET' | 'POST';
  url: string;
  authenticated: boolean;
  timeout: number;
  body?: { model: string; max_tokens: number; stream: boolean; messages: Message[] };
  operation?: string;
  availableInput?: number;
  availableOutput?: number;
}
interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
function runExample(
  options: {
    outcomes?: ('success' | 'timeout' | 'rejected')[];
    questions?: string[];
    answers?: string[];
    availableInput?: number;
    availableOutput?: number;
    consumed?: number;
    balance?: 'ok' | 'unavailable';
    receipt?: DemoReceiptFacts | null;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'hello-muse-'));
  const receiptPath = join(dir, 'receipt.json');
  if (options.receipt !== null)
    writeFileSync(receiptPath, JSON.stringify(options.receipt ?? sampleReceipt()));
  const script = demoPythonScript('https://broker.example').replace(
    '/workspace/receipt.json',
    receiptPath,
  );
  const result = JSON.parse(
    execFileSync('python3', ['-I', '-c', pythonHarness], {
      input: JSON.stringify({
        script,
        outcomes: options.outcomes ?? [],
        questions: options.questions ?? [],
        answers: options.answers ?? [],
        availableInput: options.availableInput ?? 5000,
        availableOutput: options.availableOutput ?? 2048,
        consumed: options.consumed ?? 0,
        balance: options.balance ?? 'ok',
      }),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 200000,
    }),
  ) as { requests: ExampleRequest[]; output: string; keyCleared: boolean };
  return { ...result, calls: result.requests.filter((r) => r.method === 'POST') };
}
/** The production gateway's request-sized reservation for the qualified Baseten route. */
const route = {
  mode: 'real',
  inputAccounting: 'utf8-bytes-v1',
  inputBound: 1_048_576,
} as RuntimeRoute;
function expectWithinAllowance(call: ExampleRequest) {
  expect(inputReservation(route, { messages: call.body!.messages })).toBeLessThanOrEqual(
    call.availableInput!,
  );
  expect(call.body!.max_tokens).toBeLessThanOrEqual(Math.min(1024, call.availableOutput!));
}

describe('preloaded hello Muse example (real Python, network replaced)', () => {
  it('explains the visitor receipt, then answers one question within the batch allowance', () => {
    const result = runExample({
      questions: ['Why did Modal win when its gross bid was higher?'],
      answers: ['You rented a Modal Micro VM.\n$ uname -a', 'Sponsorship lowered its price.'],
    });
    expect(result.requests.every((r) => r.authenticated)).toBe(true);
    expect(result.requests.map((r) => r.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
    expect(result.requests[0]!.url).toBe('https://broker.example/api/inference/packs');
    const [explain, answer] = result.calls;
    for (const call of result.calls) {
      expect(call).toMatchObject({
        url: 'https://broker.example/api/v1/chat/completions',
        body: { model: 'meta/muse-spark-open', max_tokens: 1024, stream: false },
      });
      expect(call.operation).toMatch(/^[a-f0-9-]{36}$/);
      expect(call.body!.messages[0]).toMatchObject({ role: 'system' });
      expect(call.body!.messages[0]!.content.startsWith('Reasoning strength: 8.\n')).toBe(true);
      expectWithinAllowance(call);
    }
    expect(explain!.operation).not.toBe(answer!.operation);
    const facts = JSON.parse(explain!.body!.messages[1]!.content);
    expect(facts.compute).toMatchObject({
      winner: 'Modal',
      paid: '$0.01',
      grossBid: '$0.072',
      sponsorCredit: '$0.062',
    });
    expect(facts.compute.bids).toEqual([
      ['Modal', '$0.01'],
      ['E2B', '$0.0314'],
    ]);
    expect(facts.tokens).toMatchObject({ seller: 'Baseten', paid: '$0.018' });
    expect(facts.vm.cpus).toBeGreaterThan(0);
    expect(answer!.body!.messages[1]!.content).toBe(
      'This VM: Modal Micro, 15-minute lease. Question: Why did Modal win when its gross bid was higher?',
    );
    expect(result.output).toContain('served by Baseten');
    expect(result.output).toContain('You rented a Modal Micro VM.');
    expect(result.output).toContain('Nothing was run');
    expect(result.output).toContain('Sponsorship lowered its price.');
    expect(result.output.match(/Usage: /g)).toHaveLength(2);
    expect(result.output).not.toContain('wbk_fixture-test-key');
    expect(result.keyCleared).toBe(true);
  });
  it('keeps the live verifier transcript shape and leaves the second call unused on skip', () => {
    const result = runExample({ questions: [''] });
    expect(result.calls).toHaveLength(1);
    expect(result.output).toMatch(
      /Calling Meta Muse\. Request: [0-9a-f-]{36}\nHello from fixture Muse\nUsage: \{[^\n]*\}/,
    );
    expect(result.output).toMatch(/\nAsk Muse one question[^\n]*: No question sent/);
    expect(runExample().calls).toHaveLength(1); // EOF at the prompt is a skip.
  });
  it('goes straight to the question when an earlier run already used the explanation', () => {
    const result = runExample({
      availableInput: 4650,
      availableOutput: 1900,
      consumed: 148,
      questions: ['What can I run here?'],
    });
    expect(result.calls).toHaveLength(1);
    expect(result.output).toContain('already explained this demo');
    expect(result.calls[0]!.body!.messages[1]!.content).toMatch(/Question: What can I run here\?$/);
    expectWithinAllowance(result.calls[0]!);
  });
  it('shrinks the explanation and shortens a long question to fit a small remaining balance', () => {
    const tight = runExample({ availableInput: 4780, questions: [''] });
    expectWithinAllowance(tight.calls[0]!);
    expect(JSON.parse(tight.calls[0]!.body!.messages[1]!.content).compute?.bids).toBeUndefined();
    const long = runExample({
      availableInput: 4650,
      consumed: 148,
      questions: ['Explain every part of this marketplace in depth please. '.repeat(6)],
    });
    expect(long.output).toContain('shortened to fit');
    expectWithinAllowance(long.calls[0]!);
    const empty = runExample({ availableInput: 4300, consumed: 148, questions: ['Hello?'] });
    expect(empty.calls).toHaveLength(0);
    expect(empty.output).toContain('Not enough input allowance is left for a question');
  });
  it('still explains the machine when the receipt or balance cannot be read', () => {
    const result = runExample({ receipt: null, balance: 'unavailable', questions: ['Hi?'] });
    expect(result.calls).toHaveLength(2);
    expect(Object.keys(JSON.parse(result.calls[0]!.body!.messages[1]!.content))).toEqual(['vm']);
    expect(result.calls[1]!.body!.messages[1]!.content).toBe('Question: Hi?');
    for (const call of result.calls) expectWithinAllowance(call);
  });
  it('does not automatically retry or continue after an uncertain or rejected paid request', () => {
    for (const outcome of ['timeout', 'rejected'] as const) {
      const result = runExample({ outcomes: [outcome], questions: ['Should not be asked'] });
      expect(result.calls).toHaveLength(1);
      expect(result.output).not.toContain('Ask Muse one question');
      expect(result.keyCleared).toBe(true);
      expect(result.output).not.toContain('wbk_fixture-test-key');
      expect(result.output).toContain(
        outcome === 'timeout' ? 'Outcome unconfirmed' : 'Demo request allowance exhausted',
      );
    }
  });
  it('never executes model output', () => {
    const script = demoPythonScript('https://broker.example');
    for (const runner of ['subprocess', 'os.system', 'popen', 'exec(', 'eval('])
      expect(script).not.toContain(runner);
  });
});

describe('demo bootstrap', () => {
  it('builds the receipt from public award values only', () => {
    const receipt = sampleReceipt();
    expect(receipt.compute).toMatchObject({ cpu: 0.25, memoryGb: 0.5, leaseMinutes: 15 });
    expect(JSON.stringify(receipt)).not.toMatch(/org_private|group_private|organizationId/);
  });
  it('writes the fixed script, README and receipt within the native command limit', () => {
    const appUrl = 'https://broker.example';
    const receipt = sampleReceipt();
    const command = demoBootstrapCommand(appUrl, 'terminal', false, receipt);
    const encoded = command.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded!, 'base64').toString()).toBe(demoPythonScript(appUrl));
    expect(command).toContain('/workspace/hello_muse.py');
    expect(command).toContain('os.replace(t,p)');
    expect(command).not.toContain(appUrl);
    expect(command).not.toContain('BASETEN_API_KEY');
    // Worst case: reused-disk reset prefix, eight bids and the production origin.
    const longest = demoBootstrapCommand(
      'https://meta-hackathon-wick-production.up.railway.app',
      'terminal',
      true,
      sampleReceipt(6),
    );
    expect(longest.length).toBeLessThan(15000);

    const dir = mkdtempSync(join(tmpdir(), 'demo-workspace-'));
    const output = execFileSync('sh', ['-c', command.replaceAll('/workspace', dir)], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(output.trim()).toBe('WICK_DEMO_SCRIPT_READY');
    expect(readFileSync(join(dir, 'hello_muse.py'), 'utf8')).toBe(demoPythonScript(appUrl));
    expect(JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'))).toEqual(receipt);
    expect(readFileSync(join(dir, 'README.txt'), 'utf8')).toContain('answers one question');
  });
});
