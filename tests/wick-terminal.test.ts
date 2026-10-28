import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { parseTerminalInput, registerTerminal } from '../src/server/integrations/terminal.js';
import type { WickTerminal, WickTerminalOptions } from '../src/server/integrations/types.js';
import { fixtureTerminal } from '../src/server/integrations/terminal-fixture.js';
import { HttpError, type AppContext } from '../src/server/context.js';

const vmId = '00000000-0000-4000-8000-000000000001';
const instances: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

async function harness(
  mode: 'fixture' | 'real' = 'fixture',
  terminal: (options?: WickTerminalOptions) => WickTerminal = fixtureTerminal,
) {
  const state = {
    authenticated: true,
    owner: 'buyer-one',
    status: 'running',
    expiresAt: new Date(Date.now() + 60_000),
    sourceMode: mode as string,
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof HttpError ? error.statusCode : 500)
      .send({ error: error instanceof Error ? error.message : 'Unknown failure' }),
  );
  await app.register(websocket, { options: { maxPayload: 33792 } });
  await registerTerminal(app, {
    config: { appUrl: 'http://localhost:3000' },
    wick: {
      mode,
      terminal: async (_id: string, options: WickTerminalOptions) => terminal(options),
    },
    requireActor: async () => {
      if (!state.authenticated) throw new HttpError(401, 'Sign in required');
      return { id: 'buyer-one', role: 'buyer' };
    },
    pool: {
      query: async (_query: string, params: string[]) => ({
        rows:
          params[1] === state.owner
            ? [
                {
                  id: vmId,
                  buyer_id: state.owner,
                  status: state.status,
                  expires_at: state.expiresAt,
                  environment_id: 'fixture_environment',
                  source_mode: state.sourceMode,
                },
              ]
            : [],
      }),
    },
  } as unknown as AppContext);
  await app.listen({ port: 0, host: '127.0.0.1' });
  instances.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const endpoint = `ws://127.0.0.1:${address.port}/api/vms/${vmId}/terminal`;
  const connect = (origin = 'http://localhost:3000') => {
    const socket = new WebSocket(endpoint, { origin });
    sockets.push(socket);
    return socket;
  };
  return { app, state, connect };
}
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}
function rejected(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    socket.once('open', () => reject(new Error('Unexpected acceptance')));
    socket.once('error', () => undefined);
  });
}
function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

describe('terminal protocol validation', () => {
  it('permits bounded protocol fields and removes browser-injected endpoints', () => {
    expect(
      parseTerminalInput({
        type: 'resize',
        cols: 80,
        rows: 24,
        url: 'wss://attacker.invalid',
        token: 'x',
      }),
    ).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(
      parseTerminalInput({ type: 'input', data: 'echo hello\r', environmentId: 'some-other-vm' }),
    ).toEqual({ type: 'input', data: 'echo hello\r' });
  });
  it.each([
    { type: 'reauth', token: 'x' },
    { type: 'resize', cols: 9999, rows: 24 },
    { type: 'ack', bytes: -1 },
    { type: 'input', data: 'x'.repeat(32769) },
    null,
  ])('rejects unsupported frames', (frame) => {
    expect(() => parseTerminalInput(frame)).toThrow();
  });
});
describe('same-origin terminal bridge', () => {
  it('requires matching Origin and current buyer ownership', async () => {
    const { connect, state } = await harness();
    expect(await rejected(connect('https://attacker.invalid'))).toBe(403);
    state.owner = 'another-buyer';
    expect(await rejected(connect())).toBe(404);
  });
  it('denies an expired or terminating rental before upgrade', async () => {
    const { connect, state } = await harness();
    state.status = 'terminating';
    expect(await rejected(connect())).toBe(409);
    state.status = 'running';
    state.expiresAt = new Date(Date.now() - 1);
    expect(await rejected(connect())).toBe(409);
  });
  it('does not cross fixture and real integration modes when attaching a terminal', async () => {
    const { connect, state } = await harness();
    state.sourceMode = 'real';
    expect(await rejected(connect())).toBe(409);
  });
  it('labels fixture output, never executes arbitrary commands, and does not expose upstream tokens', async () => {
    const { connect } = await harness();
    const socket = connect();
    const frames: Record<string, unknown>[] = [];
    const received = new Promise<void>((resolve) =>
      socket.on('message', (raw) => {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        frames.push(value);
        if (
          value.type === 'output' &&
          Buffer.from(String(value.data), 'base64')
            .toString()
            .includes('this command was not executed')
        )
          resolve();
      }),
    );
    await opened(socket);
    socket.send(JSON.stringify({ type: 'input', data: 'cat /etc/passwd\r' }));
    await received;
    expect(frames).toContainEqual({ type: 'ready', mode: 'fixture' });
    expect(JSON.stringify(frames)).not.toContain('token');
    const output = frames
      .filter((frame) => frame.type === 'output')
      .map((frame) => Buffer.from(String(frame.data), 'base64').toString())
      .join('');
    expect(output).toContain('simulated demo terminal');
    expect(output).not.toContain('root:x:');
  });
  it('bridges decoded real output exactly, waits for ready, returns pong, and acknowledges only consumed bytes', async () => {
    const bytes = Buffer.from([0, 255, 195, 169, 13, 10]);
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const input = vi.fn(),
      resize = vi.fn(),
      ack = vi.fn();
    const { connect } = await harness('real', () => ({
      input,
      resize,
      ack,
      close: finish,
      async *[Symbol.asyncIterator]() {
        yield { type: 'output' as const, data: bytes };
        yield { type: 'ready' as const };
        await ended;
      },
    }));
    const socket = connect();
    const frames: Record<string, unknown>[] = [];
    const ready = new Promise<void>((resolve) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === 'ready') resolve();
      }),
    );
    await opened(socket);
    await ready;
    expect(frames).toContainEqual({ type: 'ready', mode: 'real' });
    expect(frames).toContainEqual({ type: 'output', data: bytes.toString('base64') });
    const pong = new Promise<void>((resolve) =>
      socket.on('message', (raw) => {
        if ((JSON.parse(raw.toString()) as { type: string }).type === 'pong') resolve();
      }),
    );
    socket.send(JSON.stringify({ type: 'ack', bytes: bytes.length }));
    socket.send(JSON.stringify({ type: 'input', data: 'user-command\r' }));
    socket.send(JSON.stringify({ type: 'resize', cols: 90, rows: 25 }));
    socket.send(JSON.stringify({ type: 'ping' }));
    await pong;
    expect(ack).toHaveBeenCalledExactlyOnceWith(bytes.length);
    expect(input).toHaveBeenCalledExactlyOnceWith('user-command\r');
    expect(resize).toHaveBeenCalledExactlyOnceWith(90, 25);
    expect(JSON.stringify(frames)).not.toContain('token');
  });
  it('closes an established session when authentication is revoked', async () => {
    const { connect, state } = await harness();
    const socket = connect();
    await opened(socket);
    const ended = closed(socket);
    state.authenticated = false;
    expect(await ended).toBe(1008);
  }, 5000);
  it('bounds simultaneous shells on the same VM', async () => {
    const { connect } = await harness();
    const one = connect();
    await opened(one);
    const two = connect();
    await opened(two);
    expect(await rejected(connect())).toBe(429);
  });
  it('keeps output acknowledgements separate from the keystroke budget', async () => {
    const { connect } = await harness();
    const socket = connect();
    await opened(socket);
    const response = new Promise<void>((resolve) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; data?: string };
        if (
          frame.type === 'output' &&
          Buffer.from(frame.data!, 'base64').toString().includes('ack-budget-ok')
        )
          resolve();
      }),
    );
    for (let i = 0; i < 200; i++) socket.send(JSON.stringify({ type: 'ack', bytes: 10 }));
    socket.send(JSON.stringify({ type: 'input', data: 'echo ack-budget-ok\r' }));
    await response;
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
  it('disconnects exactly at rental expiry while leaving lifecycle changes to the marketplace', async () => {
    const { connect, state } = await harness();
    state.expiresAt = new Date(Date.now() + 150);
    const socket = connect();
    const ended = closed(socket);
    await opened(socket);
    expect(await ended).toBe(1008);
    expect(state.status).toBe('running');
  });
  it('bounds shutdown when a client stops processing close frames', async () => {
    const { app, connect } = await harness();
    const socket = connect();
    await opened(socket);
    socket.pause();
    const start = Date.now();
    await app.close();
    // The browser can ignore its close handshake; the server still forces the socket closed.
    await expect.poll(() => app.websocketServer.clients.size, { timeout: 3000 }).toBe(0);
    expect(Date.now() - start).toBeLessThan(5000);
    socket.resume();
  }, 6000);
});
