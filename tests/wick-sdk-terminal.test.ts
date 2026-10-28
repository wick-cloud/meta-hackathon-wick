import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWickAdapter } from '../src/server/integrations/wick.js';

const { sockets, FakeSocket } = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    sent: Record<string, unknown>[] = [];
    constructor(
      readonly url: URL,
      readonly options: Record<string, unknown>,
    ) {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    on(type: string, listener: (...args: unknown[]) => void) {
      this.addEventListener(type, listener);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    receive(value: object) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })));
    }
    terminate() {
      this.close();
    }
  }
  return { sockets, FakeSocket };
});
vi.mock('ws', () => ({ default: FakeSocket }));

const config = {
  wickMode: 'real' as const,
  wickApiBase: 'https://wick.example/api',
  wickApiKey: 'service-key-never-in-terminal',
  wickOrganizationId: 'org_test',
  wickGroupId: 'group_test',
};
function session(token = 'scoped-terminal-token') {
  return {
    session: {
      id: 'session_test',
      environmentId: 'env_test',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
    token,
    terminalWebsocketUrl: 'wss://terminal.wick.example/v1/environments/env_test/terminal',
  };
}
afterEach(() => {
  sockets.splice(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('published Wick SDK terminal wire contract (offline)', () => {
  it('authenticates with a scoped auth frame, decodes bytes, preserves acknowledgements, and renews after 120 seconds', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(session('scoped-token-' + fetcher.mock.calls.length))),
    );
    vi.stubGlobal('fetch', fetcher);
    const terminal = await createWickAdapter(config).terminal('env_test', { cols: 87, rows: 29 });
    const socket = sockets[0]!;
    expect(socket.sent).toEqual([{ type: 'auth', token: 'scoped-token-1', cols: 87, rows: 29 }]);
    expect(socket.options).not.toHaveProperty('headers');
    expect(socket.options).toMatchObject({ followRedirects: false, maxPayload: 262144 });
    const iterator = terminal[Symbol.asyncIterator]();
    const bytes = Buffer.from([0, 255, 195, 169, 13, 10]);
    socket.receive({ type: 'output', data: bytes.toString('base64') });
    const output = await iterator.next();
    expect(output.value).toEqual({ type: 'output', data: new Uint8Array(bytes) });
    terminal.ack(bytes.length); // SDK accepts output before ready, without losing backpressure.
    socket.receive({ type: 'ready', environmentId: 'env_test', console: 'terminal' });
    expect((await iterator.next()).value).toEqual({ type: 'ready' });
    terminal.input('echo diagnostic\r');
    terminal.resize(100, 30);
    expect(socket.sent.slice(1)).toEqual([
      { type: 'ack', bytes: 6 },
      { type: 'input', data: 'echo diagnostic\r' },
      { type: 'resize', cols: 100, rows: 30 },
    ]);
    expect(() => terminal.ack(1)).toThrow();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(socket.sent.at(-1)).toEqual({ type: 'reauth', token: 'scoped-token-2' });
    expect(JSON.stringify(socket.sent)).not.toContain(config.wickApiKey);
    terminal.close();
    await iterator.return?.();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects wrong-scope sessions before opening any socket', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...session(),
              session: { ...session().session, environmentId: 'other_environment' },
            }),
          ),
      ),
    );
    await expect(createWickAdapter(config).terminal('env_test')).rejects.toThrow('reconciliation');
    expect(sockets).toHaveLength(0);
  });

  it.each([
    ['32 KiB ASCII', 'a'.repeat(32 * 1024)],
    ['surrogate pair at a frame boundary', 'a'.repeat(16_383) + '😀' + 'b'.repeat(8000)],
  ])('chunks %s input into ordered SDK frames without splitting Unicode', async (_label, input) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(session()))),
    );
    const terminal = await createWickAdapter(config).terminal('env_test');
    const iterator = terminal[Symbol.asyncIterator]();
    const socket = sockets[0]!;
    socket.receive({ type: 'ready', environmentId: 'env_test', console: 'terminal' });
    await iterator.next();
    terminal.input(input);
    terminal.input('next command\r');
    const frames = socket.sent.filter((frame) => frame.type === 'input');
    expect(frames.length).toBeGreaterThan(2);
    expect(frames.at(-1)?.data).toBe('next command\r');
    expect(
      frames
        .slice(0, -1)
        .map((frame) => frame.data)
        .join(''),
    ).toBe(input);
    for (const frame of frames) {
      const value = frame.data as string;
      expect(value.length).toBeLessThanOrEqual(16_384);
      expect(value.isWellFormed()).toBe(true);
    }
    terminal.close();
    await iterator.return?.();
  });

  it('checks renewal scope and stops without exposing upstream error details', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              ++calls === 1
                ? session()
                : {
                    ...session(),
                    session: { ...session().session, environmentId: 'other_environment' },
                  },
            ),
          ),
      ),
    );
    const terminal = await createWickAdapter(config).terminal('env_test');
    const socket = sockets[0]!;
    const iterator = terminal[Symbol.asyncIterator]();
    socket.receive({ type: 'ready', environmentId: 'env_test', console: 'terminal' });
    await iterator.next();
    const failure = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await failure).toMatchObject({ message: 'Wick terminal connection failed' });
    expect(socket.sent.filter((frame) => frame.type === 'reauth')).toHaveLength(0);
    expect(socket.readyState).toBe(3);
  });

  it('sanitizes terminal failures and rejects the wrong ready environment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(session()))),
    );
    const terminal = await createWickAdapter(config).terminal('env_test');
    const iterator = terminal[Symbol.asyncIterator]();
    sockets[0]!.receive({ type: 'ready', environmentId: 'wrong_environment', console: 'terminal' });
    await expect(iterator.next()).rejects.toThrow('Wick terminal connection failed');
    expect(sockets[0]!.readyState).toBe(3);
  });

  it('does not send a service key if a malformed session response echoes it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(session(config.wickApiKey)))),
    );
    await expect(createWickAdapter(config).terminal('env_test')).rejects.toThrow();
    expect(sockets).toHaveLength(0);
  });
});
