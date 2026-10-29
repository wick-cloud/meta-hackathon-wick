import { afterEach, describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { BrokerClient } from '../packages/sdk/src/index.js';
const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw Error('Missing local fixture address');
  return {
    server,
    client: new BrokerClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'wbk_test.only_a_fixture',
    }),
  };
}
describe('Broker SDK local terminal protocol', () => {
  it('uses scoped Bearer headers without browser Origin and acknowledges only consumed output', async () => {
    const { server, client } = await fixture();
    const frames: Record<string, unknown>[] = [];
    let auth: string | undefined;
    let origin: string | undefined;
    let requestPath: string | undefined;
    server.on('connection', (socket, request) => {
      auth = request.headers.authorization;
      origin = request.headers.origin;
      requestPath = request.url;
      socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
      socket.send(JSON.stringify({ type: 'ready', mode: 'fixture' }));
      socket.send(
        JSON.stringify({ type: 'output', data: Buffer.from('hello').toString('base64') }),
      );
    });
    const terminal = await client.vms.terminal('owned-vm', { cols: 100, rows: 30 });
    const events = terminal[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual({ type: 'ready', mode: 'fixture' });
    const output = (await events.next()).value;
    expect(output?.type).toBe('output');
    if (output?.type !== 'output') throw Error('Missing output');
    expect(Buffer.from(output.data).toString()).toBe('hello');
    expect(auth).toBe('Bearer wbk_test.only_a_fixture');
    expect(origin).toBeUndefined();
    expect(requestPath).toBe('/api/vms/owned-vm/terminal');
    expect(frames.some((f) => f.type === 'ack')).toBe(false);
    const acknowledged = new Promise<void>((resolve) =>
      server.clients
        .values()
        .next()
        .value!.on('message', (raw) => {
          if (JSON.parse(raw.toString()).type === 'ack') resolve();
        }),
    );
    terminal.ack(5);
    await acknowledged;
    expect(frames).toContainEqual({ type: 'ack', bytes: 5 });
    terminal.write('pwd\n');
    terminal.resize(90, 25);
    expect(() => terminal.write('x'.repeat(32769))).toThrow('32 KiB');
    expect(() => terminal.resize(0, 24)).toThrow('dimensions');
    terminal.close();
    await events.return?.();
  });
  it('rejects upstream terminal URLs/frames rather than forwarding credentials or arbitrary output', async () => {
    const { server, client } = await fixture();
    server.on('connection', (socket) =>
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: 'not-a-public-token',
          terminalWebsocketUrl: 'wss://native.invalid',
        }),
      ),
    );
    await expect(client.vms.terminal('owned-vm')).rejects.toMatchObject({
      code: 'invalid_terminal_response',
    });
  });
  it('drains final output after a normal remote close without treating a late acknowledgement as a failure', async () => {
    const { server, client } = await fixture();
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.send(
        JSON.stringify({ type: 'output', data: Buffer.from('final').toString('base64') }),
      );
      socket.close(1000, 'Done');
    });
    const terminal = await client.vms.terminal('owned-vm');
    await new Promise<void>((resolve) => {
      const check = () => (terminal.closed ? resolve() : setTimeout(check, 1));
      check();
    });
    let result = '';
    for await (const event of terminal) {
      if (event.type === 'output') {
        result += Buffer.from(event.data).toString();
        expect(() => terminal.ack(event.data.byteLength)).not.toThrow();
      }
    }
    expect(result).toBe('final');
  });
  it('returns an explicit overflow error with bounded unacknowledged output', async () => {
    const { server, client } = await fixture();
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      for (let i = 0; i < 5; i++)
        socket.send(
          JSON.stringify({ type: 'output', data: Buffer.alloc(65536, 65).toString('base64') }),
        );
    });
    const terminal = await client.vms.terminal('owned-vm');
    let total = 0;
    await expect(
      (async () => {
        for await (const event of terminal)
          if (event.type === 'output') total += event.data.byteLength;
      })(),
    ).rejects.toMatchObject({ code: 'terminal_overflow' });
    expect(total).toBeLessThanOrEqual(256 * 1024);
  });
});
