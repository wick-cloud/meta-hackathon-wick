import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import type { BrokerClient, BrokerTerminal, TerminalEvent } from '@wick-cloud/broker-sdk';
import { buildTools, createBrokerMcp } from '../packages/mcp/src/index.js';
import { TerminalSessions } from '../packages/mcp/src/terminals.js';
import { bodySchemas } from '../packages/mcp/src/schemas.js';

it('accepts four-decimal USD purchase amounts through MCP without allowing fractional tokens', () => {
  const input = { mode: 'auction', inputTokens: 100, outputTokens: 1, maxTotalCents: 0.01 };
  expect(bodySchemas.tokenOrder.parse(input)).toEqual(input);
  expect(bodySchemas.bid.parse({ totalPriceCents: 123.45 })).toEqual({ totalPriceCents: 123.45 });
  expect(bodySchemas.tokenOrder.safeParse({ ...input, maxTotalCents: 0.001 }).success).toBe(false);
  expect(bodySchemas.tokenOrder.safeParse({ ...input, outputTokens: 1.5 }).success).toBe(false);
});
const principal = {
  id: 'buyer-one',
  role: 'buyer',
  apiKey: { id: 'key-one', scopes: ['account:read', 'catalog:read', 'orders:read'], limits: {} },
};
const managers: TerminalSessions[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  vi.useRealTimers();
});
function manager(
  client: BrokerClient,
  options?: ConstructorParameters<typeof TerminalSessions>[1],
) {
  const value = new TerminalSessions(client, options);
  managers.push(value);
  return value;
}
class FakeTerminal {
  events: TerminalEvent[] = [];
  closed = false;
  wake: (() => void) | undefined;
  ack = vi.fn();
  write = vi.fn();
  resize = vi.fn();
  close = vi.fn(() => {
    this.closed = true;
    this.wake?.();
  });
  push(event: TerminalEvent) {
    this.events.push(event);
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<TerminalEvent> {
    while (!this.closed || this.events.length) {
      const event = this.events.shift();
      if (event) {
        yield event;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
describe('Broker MCP role and scope boundaries', () => {
  it('accepts long signed instant quotes and rejects out-of-contract inference quantities', async () => {
    const request = vi.fn(async () => ({ id: 'order-one' }));
    const client = { baseUrl: 'https://broker.example', request } as unknown as BrokerClient;
    const tools = buildTools(
      client,
      { ...principal, apiKey: { ...principal.apiKey, scopes: ['tokens:buy', 'inference:use'] } },
      manager(client),
    );
    const buy = tools.find((t) => t.name === 'token_order_create')!;
    const input = {
      mode: 'instant',
      inputTokens: 1000000,
      outputTokens: 100000,
      maxTotalCents: 500,
      quoteId: 'signed-quote.'.padEnd(700, 'a'),
    };
    await buy.run({ operationKey: 'long-quote-purchase', input });
    expect(request).toHaveBeenCalledExactlyOnceWith('POST', '/api/token-orders', {
      body: input,
      operationKey: 'long-quote-purchase',
      signal: undefined,
    });
    for (const invalid of [
      { ...input, quoteId: 'a'.repeat(4001) },
      { ...input, inputTokens: 10000001 },
      { ...input, outputTokens: 1000001 },
    ])
      expect(
        buy.schema.safeParse({ operationKey: 'invalid-purchase', input: invalid }).success,
      ).toBe(false);
    const complete = tools.find((t) => t.name === 'inference_complete')!;
    const body = {
      model: 'meta/muse-spark-open',
      messages: [{ role: 'user', content: '' }],
      max_tokens: 8192,
      top_p: 0,
    };
    expect(
      complete.schema.safeParse({ operationKey: 'completion-valid', input: body }).success,
    ).toBe(true);
    for (const invalid of [
      { ...body, max_tokens: 8193 },
      { ...body, messages: Array.from({ length: 65 }, () => ({ role: 'user', content: '' })) },
      { ...body, messages: [{ role: 'user', content: 'a'.repeat(60001) }] },
    ])
      expect(
        complete.schema.safeParse({ operationKey: 'completion-invalid', input: invalid }).success,
      ).toBe(false);
  });
  it('gives an inference grant only token-market tools and rejects unsupported completion capabilities', async () => {
    const request = vi.fn(async () => ({ id: 'call-one' }));
    const client = { baseUrl: 'https://broker.example', request } as unknown as BrokerClient;
    const tools = buildTools(
      client,
      {
        ...principal,
        apiKey: {
          id: 'grant-key',
          grantId: 'grant-one',
          scopes: ['account:read', 'inference:read', 'inference:use', 'tokens:buy'],
          limits: {},
        },
      },
      manager(client),
    );
    expect(tools.map((t) => t.name)).toEqual([
      'inference_compatible_models_list',
      'inference_models_get',
      'inference_grant_get',
      'inference_packs_list',
      'inference_quotes_get',
      'token_order_create',
      'token_order_get',
      'token_order_cancel',
      'inference_receipt_get',
      'inference_complete',
      'account_get',
      'token_order_wait',
    ]);
    const tool = tools.find((t) => t.name === 'inference_complete')!;
    const input = {
      model: 'meta/muse-spark-open',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 64,
      stream: false,
    };
    for (const invalid of [
      { input },
      { operationKey: 'completion-one', input: { ...input, stream: true } },
      { operationKey: 'completion-one', input: { ...input, tools: [] } },
      {
        operationKey: 'completion-one',
        input: { ...input, messages: [{ role: 'tool', content: 'Hidden tool call' }] },
      },
    ])
      await expect(tool.run(invalid)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await tool.run({ operationKey: 'completion-one', input });
    expect(request).toHaveBeenCalledExactlyOnceWith('POST', '/api/v1/chat/completions', {
      body: input,
      operationKey: 'completion-one',
      signal: undefined,
    });
    expect(tool.readOnly).toBe(false);
    expect(tools.find((t) => t.name === 'inference_quotes_get')!.readOnly).toBe(true);
    expect(tools.some((t) => /grant_create|budget_update|terminal|provider_/.test(t.name))).toBe(
      false,
    );
  });
  it('bounds token waits and links to the existing token order without mutating', async () => {
    const wait = vi.fn(async () => ({ id: 'token-order', state: 'pending' }));
    const client = {
      baseUrl: 'https://broker.example',
      inference: { orders: { wait } },
    } as unknown as BrokerClient;
    const tool = buildTools(
      client,
      {
        ...principal,
        apiKey: { ...principal.apiKey, scopes: ['inference:read'] },
      },
      manager(client),
    ).find((t) => t.name === 'token_order_wait')!;
    await expect(tool.run({ id: 'token-order', timeoutSeconds: 31 })).rejects.toThrow();
    expect(wait).not.toHaveBeenCalled();
    await expect(tool.run({ id: 'token-order' })).resolves.toMatchObject({
      data: { state: 'pending' },
      links: { ui: 'https://broker.example/token-orders/token-order' },
    });
    expect(wait).toHaveBeenCalledExactlyOnceWith('token-order', {
      timeoutMs: 30000,
      signal: undefined,
    });
  });
  it('exposes provider inference offers only under provider role and existing supplier scopes', () => {
    const client = { baseUrl: 'https://broker.example' } as BrokerClient;
    const provider = {
      ...principal,
      role: 'provider',
      apiKey: { ...principal.apiKey, scopes: ['provider:read', 'provider:offerings:write'] },
    };
    const tools = buildTools(client, provider, manager(client));
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'provider_inference_offering_get',
        'provider_inference_offering_update',
        'provider_inference_packs_list',
      ]),
    );
    expect(
      tools
        .find((t) => t.name === 'provider_inference_offering_update')!
        .schema.safeParse({ input: {} }).success,
    ).toBe(false);
    expect(
      buildTools(client, { ...provider, role: 'buyer' }, manager(client)).some((t) =>
        t.name.startsWith('provider_inference'),
      ),
    ).toBe(false);
  });
  it('advertises only the key role/scopes and no secret inputs or exec/file tools', () => {
    const client = { baseUrl: 'https://broker.example' } as BrokerClient;
    const tools = buildTools(client, principal, manager(client));
    expect(tools.map((t) => t.name)).toEqual([
      'auctions_list',
      'account_get',
      'catalog_list',
      'orders_list',
      'auction_get',
      'intents_list',
      'intent_get',
      'auction_wait',
    ]);
    const names = tools.map((t) => t.name).join(' ');
    expect(names).not.toContain('provider');
    expect(names).not.toMatch(/exec|files|key_create/);
    for (const tool of tools) expect(Object.keys(tool.schema.shape)).not.toContain('apiKey');
  });
  it('requires a stable operation key before a mutation request', async () => {
    const request = vi.fn();
    const client = { baseUrl: 'https://broker.example', request } as unknown as BrokerClient;
    const tools = buildTools(
      client,
      { ...principal, apiKey: { ...principal.apiKey, scopes: ['vms:terminate'] } },
      manager(client),
    );
    const tool = tools.find((t) => t.name === 'vm_terminate')!;
    await expect(tool.run({ id: 'vm-one' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({ accepted: true });
    const result = await tool.run({ id: 'vm-one', operationKey: 'cleanup-001' });
    expect(request).toHaveBeenCalledWith('POST', '/api/vms/vm-one/terminate', {
      body: {},
      operationKey: 'cleanup-001',
      signal: undefined,
    });
    expect(result).toMatchObject({
      data: { accepted: true },
      links: { ui: 'https://broker.example/vms/vm-one' },
    });
  });
  it('keeps provider proposals separate from publication and policy apply', () => {
    const client = { baseUrl: 'https://broker.example' } as BrokerClient;
    const tools = buildTools(
      client,
      { ...principal, role: 'provider', apiKey: { ...principal.apiKey, scopes: ['muse:propose'] } },
      manager(client),
    );
    expect(tools.map((t) => t.name).sort()).toEqual([
      'muse_provider_schedule_draft',
      'provider_bid_propose',
      'provider_offerings_propose',
      'provider_policy_propose',
    ]);
  });
  it('bounds wait inputs to 30 seconds and requires a machine principal', async () => {
    const client = {
      baseUrl: 'https://broker.example',
      me: vi.fn(async () => ({ user: { id: 'buyer-one', role: 'buyer' } })),
    } as unknown as BrokerClient;
    const tool = buildTools(client, principal, manager(client)).find(
      (t) => t.name === 'auction_wait',
    )!;
    expect(() => tool.schema.parse({ id: 'auction-one', timeoutSeconds: 31 })).toThrow();
    await expect(createBrokerMcp(client)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
describe('Broker MCP bounded terminal handles', () => {
  it('acknowledges only output consumed by terminal_read and closes without VM termination', async () => {
    const terminal = new FakeTerminal(),
      terminate = vi.fn();
    const client = {
      vms: { terminal: vi.fn(async () => terminal), terminate },
    } as unknown as BrokerClient;
    const sessions = manager(client),
      opened = await sessions.open('vm-one');
    terminal.push({ type: 'output', data: Buffer.from('abcdef') });
    await flush();
    expect(terminal.ack).not.toHaveBeenCalled();
    expect(await sessions.read(opened.sessionId, { maxBytes: 3 })).toMatchObject({
      output: 'abc',
      remainingBytes: 3,
    });
    expect(terminal.ack).toHaveBeenLastCalledWith(3);
    expect(await sessions.read(opened.sessionId, { maxBytes: 3 })).toMatchObject({
      output: 'def',
      remainingBytes: 0,
    });
    expect(sessions.close(opened.sessionId)).toMatchObject({ vmTerminated: false });
    expect(terminate).not.toHaveBeenCalled();
  });
  it.each([
    ['NUL bytes', Buffer.alloc(65536)],
    ['malformed UTF-8', Buffer.alloc(65536, 0xff)],
  ])('preserves 64 KiB of %s within the response bound', async (_label, data) => {
    const terminal = new FakeTerminal();
    const client = { vms: { terminal: vi.fn(async () => terminal) } } as unknown as BrokerClient;
    const sessions = manager(client),
      opened = await sessions.open('vm-one');
    terminal.push({ type: 'output', data });
    await flush();
    const result = await sessions.read(opened.sessionId, { maxBytes: 65536 });
    expect(result.bytes).toBe(65536);
    expect(result.output.length).toBeLessThanOrEqual(8192);
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.from(result.outputBase64, 'base64')).toEqual(data);
    expect(Buffer.byteLength(JSON.stringify({ data: result, links: {} }))).toBeLessThan(196608);
    expect(terminal.ack).toHaveBeenCalledExactlyOnceWith(65536);
    expect(await sessions.read(opened.sessionId)).toMatchObject({
      bytes: 0,
      output: '',
      outputTruncated: false,
    });
    expect(terminal.ack).toHaveBeenCalledTimes(1);
  });
  it('limits sessions and read size, reports overflow explicitly', async () => {
    const all: FakeTerminal[] = [];
    const client = {
      vms: {
        terminal: vi.fn(async () => {
          const t = new FakeTerminal();
          all.push(t);
          return t;
        }),
      },
    } as unknown as BrokerClient;
    const sessions = manager(client);
    const first = await sessions.open('vm-one');
    await sessions.open('vm-two');
    await sessions.open('vm-three');
    await sessions.open('vm-four');
    await expect(sessions.open('vm-five')).rejects.toMatchObject({ code: 'terminal_limit' });
    await expect(sessions.read(first.sessionId, { maxBytes: 65537 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    all[0]!.push({ type: 'output', data: new Uint8Array(262145) });
    await flush();
    await expect(sessions.read(first.sessionId)).rejects.toMatchObject({
      code: 'terminal_overflow',
    });
    expect(all[0]!.close).toHaveBeenCalled();
  });
  it('expires idle handles without terminating the environment', async () => {
    vi.useFakeTimers();
    const terminal = new FakeTerminal();
    const client = { vms: { terminal: vi.fn(async () => terminal) } } as unknown as BrokerClient;
    const sessions = manager(client);
    const opened = await sessions.open('vm-one');
    await vi.advanceTimersByTimeAsync(120001);
    expect(sessions.size).toBe(0);
    expect(terminal.close).toHaveBeenCalled();
    await expect(sessions.read(opened.sessionId)).rejects.toMatchObject({
      code: 'terminal_not_found',
    });
  });
});
function jsonRpcProcess(child: ChildProcessWithoutNullStreams) {
  let stdout = '',
    stderr = '',
    buffer = '',
    next = 0;
  let failure: Error | undefined;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const rejectPending = (error: Error) => {
    failure = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  const exited = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      rejectPending(error);
      resolve();
    });
    child.once('exit', (code, signal) => {
      rejectPending(
        new Error(
          `MCP process exited before a response (code ${code}, signal ${signal}): ${stderr}`,
        ),
      );
      resolve();
    });
  });
  child.stdin.on('error', rejectPending);
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    buffer += chunk.toString();
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at < 0) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message: { id?: number };
      try {
        message = JSON.parse(line);
      } catch {
        rejectPending(new Error('Non-protocol stdout'));
        continue;
      }
      const item = message.id === undefined ? undefined : pending.get(message.id);
      if (item) {
        clearTimeout(item.timer);
        pending.delete(message.id!);
        item.resolve(message);
      }
    }
  });
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    call: (method: string, params?: unknown) =>
      new Promise<any>((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('MCP response deadline: ' + stderr));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
          (error) => {
            if (error) rejectPending(error);
          },
        );
      }),
    close: async () => {
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    },
  };
}
describe('Broker MCP stdio interoperability', () => {
  it('rejects pending and later requests immediately when the subprocess exits', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(23)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rpc = jsonRpcProcess(child);
    try {
      await expect(rpc.call('initialize', {})).rejects.toThrow(/exited|EPIPE/);
      await expect(rpc.call('tools/list', {})).rejects.toThrow(/exited|EPIPE/);
    } finally {
      await rpc.close();
    }
  });
  it('serves legacy MCP initialization, scoped tools and JSON-only stdout', async () => {
    const key = `wbk_12345678-1234-1234-1234-123456789012.${'a'.repeat(43)}`;
    const api = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          user: { ...principal, email: 'buyer@test.invalid', name: 'Buyer' },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        }),
      );
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const port = (api.address() as { port: number }).port;
    const child = spawn(process.execPath, [resolve('node_modules/.bin/wick-broker-mcp')], {
      env: {
        ...process.env,
        WICK_BROKER_API_KEY: key,
        WICK_BROKER_API_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rpc = jsonRpcProcess(child);
    const call = rpc.call;
    try {
      const initialized = await call('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      expect(initialized.result.serverInfo.name).toBe('wick-broker');
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
      const list = await call('tools/list', {});
      expect(list.result.tools.some((t: { name: string }) => t.name === 'catalog_list')).toBe(true);
      expect(list.result.tools.some((t: { name: string }) => t.name === 'auction_create')).toBe(
        false,
      );
      const account = await call('tools/call', { name: 'account_get', arguments: {} });
      expect(account.result.structuredContent.data.user.email).toBe('buyer@test.invalid');
      expect(rpc.stdout).not.toContain(key);
      expect(rpc.stderr).not.toContain(key);
      for (const line of rpc.stdout.trim().split('\n'))
        expect(JSON.parse(line).jsonrpc).toBe('2.0');
    } finally {
      await rpc.close();
      await new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
