import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../src/server/context.js';
import { loadConfig } from '../src/server/config.js';
import { createDemoIdentity, demoIdentity, demoIpDigest } from '../src/server/demo/access.js';
import { demoBootstrapCommand, demoPythonScript } from '../src/server/demo/script.js';

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

const pythonHarness = `import contextlib, getpass, io, json, sys, urllib.error, urllib.request
case = json.load(sys.stdin)
seen = []
def no_network(req, timeout):
    headers = dict((name.lower(), value) for name, value in req.header_items())
    seen.append({"url": req.full_url, "body": json.loads(req.data), "timeout": timeout,
                 "authenticated": headers.get("authorization") == "Bearer wbk_fixture-test-key",
                 "operation": headers.get("idempotency-key")})
    if case["outcome"] == "timeout":
        raise TimeoutError("fixture timeout")
    if case["outcome"] == "rejected":
        raise urllib.error.HTTPError(req.full_url, 429, "Too many calls", {}, io.BytesIO(b'{"error":"Demo request allowance exhausted."}'))
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, limit):
            return json.dumps({"choices":[{"message":{"content":"Hello from fixture Muse"}}], "usage":{"prompt_tokens":86,"completion_tokens":148}}).encode()
    return Response()
getpass.getpass = lambda prompt: "wbk_fixture-test-key"
urllib.request.urlopen = no_network
out = io.StringIO()
namespace = {}
with contextlib.redirect_stdout(out):
    exec(compile(case["script"], "hello_muse.py", "exec"), namespace)
print(json.dumps({"requests": seen, "output": out.getvalue(), "keyCleared": namespace.get("key") == ""}))
`;
function runExample(outcome: 'success' | 'timeout' | 'rejected') {
  return JSON.parse(
    execFileSync('python3', ['-c', pythonHarness], {
      input: JSON.stringify({ script: demoPythonScript('https://broker.example'), outcome }),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 100000,
    }),
  ) as {
    requests: {
      url: string;
      body: Record<string, any>;
      authenticated: boolean;
      operation: string;
    }[];
    output: string;
    keyCleared: boolean;
  };
}

describe('preloaded hello Muse example (real Python, network replaced)', () => {
  it('uses only the purchased Broker batch key and a bounded Baseten-backed Muse request', () => {
    const result = runExample('success');
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      url: 'https://broker.example/api/v1/chat/completions',
      authenticated: true,
      body: { model: 'meta/muse-spark-open', max_tokens: 1024, stream: false },
    });
    expect(result.requests[0]!.operation).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.output).toContain('served by Baseten');
    expect(result.output).toContain('Hello from fixture Muse');
    expect(result.output).toContain('prompt_tokens');
    expect(result.output).not.toContain('wbk_fixture-test-key');
    expect(result.keyCleared).toBe(true);
  });
  it('does not automatically retry an uncertain or rejected paid request', () => {
    for (const outcome of ['timeout', 'rejected'] as const) {
      const result = runExample(outcome);
      expect(result.requests).toHaveLength(1);
      expect(result.keyCleared).toBe(true);
      expect(result.output).not.toContain('wbk_fixture-test-key');
      expect(result.output).toContain(
        outcome === 'timeout' ? 'Outcome unconfirmed' : 'Demo request allowance exhausted',
      );
    }
  });
  it('encodes the fixed script without leaking a service key or making the URL shell syntax', () => {
    const appUrl = 'https://broker.example';
    const command = demoBootstrapCommand(appUrl);
    const encoded = command.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded!, 'base64').toString()).toBe(demoPythonScript(appUrl));
    expect(command).toContain('/workspace/hello_muse.py');
    expect(command).toContain('os.replace(t,p)');
    expect(command).not.toContain(appUrl);
    expect(command).not.toContain('BASETEN_API_KEY');
  });
});
