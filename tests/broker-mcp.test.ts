import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import type { BrokerClient, BrokerTerminal, TerminalEvent } from '@wick-cloud/broker-sdk';
import { buildTools, createBrokerMcp } from '../packages/mcp/src/index.js';
import { TerminalSessions } from '../packages/mcp/src/terminals.js';
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
describe('Broker MCP stdio interoperability', () => {
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
    let stdout = '',
      stderr = '',
      buffer = '';
    let next = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      buffer += chunk.toString();
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const message = JSON.parse(line);
          const item = pending.get(message.id);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(message.id);
            item.resolve(message);
          }
        } catch {
          for (const item of pending.values()) item.reject(new Error('Non-protocol stdout'));
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const call = (method: string, params?: unknown) =>
      new Promise<any>((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => reject(new Error('MCP response deadline: ' + stderr)), 5000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
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
      expect(stdout).not.toContain(key);
      expect(stderr).not.toContain(key);
      for (const line of stdout.trim().split('\n')) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    } finally {
      for (const item of pending.values()) clearTimeout(item.timer);
      child.stdin.end();
      child.kill('SIGTERM');
      await once(child, 'exit');
      await new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
