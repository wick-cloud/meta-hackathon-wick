import type { FastifyInstance, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { HttpError, type AppContext } from '../context.js';
import type { WickSession } from './types.js';

const MAX_CLIENT_FRAME = 32 * 1024;
const MAX_BUFFER = 256 * 1024;
const MAX_SESSIONS = 64;
const MAX_SHELLS_PER_VM = 2;
const VALIDATE_EVERY_MS = 2000;
const RENEW_AFTER_MS = 240_000;
type ClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; bytes: number }
  | { type: 'ping' };
type Rental = {
  id: string;
  buyer_id: string;
  status: string;
  environment_id: string;
  expires_at: Date | string;
  source_mode?: string;
};

export function parseTerminalInput(value: unknown): ClientFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid terminal frame');
  const frame = value as Record<string, unknown>;
  if (
    frame.type === 'input' &&
    typeof frame.data === 'string' &&
    Buffer.byteLength(frame.data) <= MAX_CLIENT_FRAME
  ) {
    return { type: 'input', data: frame.data };
  }
  if (
    frame.type === 'resize' &&
    Number.isInteger(frame.cols) &&
    Number.isInteger(frame.rows) &&
    (frame.cols as number) >= 2 &&
    (frame.cols as number) <= 500 &&
    (frame.rows as number) >= 1 &&
    (frame.rows as number) <= 200
  ) {
    return { type: 'resize', cols: frame.cols as number, rows: frame.rows as number };
  }
  if (
    frame.type === 'ack' &&
    Number.isInteger(frame.bytes) &&
    (frame.bytes as number) >= 0 &&
    (frame.bytes as number) <= MAX_BUFFER
  ) {
    return { type: 'ack', bytes: frame.bytes as number };
  }
  if (frame.type === 'ping') return { type: 'ping' };
  // Browser-supplied URLs, IDs, tokens and reauthentication frames are never forwarded.
  throw new Error('Unsupported terminal frame');
}
function decoded(raw: RawData): string {
  return Buffer.isBuffer(raw)
    ? raw.toString('utf8')
    : Buffer.from(raw as ArrayBuffer).toString('utf8');
}

export async function registerTerminal(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const allowedOrigin = new URL(ctx.config.appUrl).origin;
  const approved = new WeakMap<FastifyRequest, Rental>();
  const open = new Map<string, Set<WebSocket>>();
  const disconnects = new Map<WebSocket, () => void>();
  let total = 0;

  async function authorize(request: FastifyRequest): Promise<Rental> {
    if (request.headers.origin !== allowedOrigin)
      throw new HttpError(403, 'Terminal origin is not allowed');
    const actor = await ctx.requireActor(request, ['buyer']);
    const id = (request.params as { id: string }).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new HttpError(404, 'VM not found');
    const { rows } = await ctx.pool.query<Rental>(
      `SELECT id,buyer_id,status,environment_id,expires_at,COALESCE(catalog_snapshot->>'sourceMode','fixture') AS source_mode FROM broker_vms WHERE id=$1 AND buyer_id=$2`,
      [id, actor.id],
    );
    const rental = rows[0];
    if (!rental) throw new HttpError(404, 'VM not found');
    if ((rental.source_mode ?? 'fixture') !== ctx.wick.mode)
      throw new HttpError(409, 'Rental belongs to a different Wick integration mode');
    if (
      rental.status !== 'running' ||
      !rental.environment_id ||
      !rental.expires_at ||
      new Date(rental.expires_at).getTime() <= Date.now()
    ) {
      throw new HttpError(409, 'Terminal requires an active, ready rental');
    }
    return rental;
  }

  app.get(
    '/api/vms/:id/terminal',
    {
      websocket: true,
      preValidation: async (request) => {
        const rental = await authorize(request);
        if (total >= MAX_SESSIONS || (open.get(rental.id)?.size ?? 0) >= MAX_SHELLS_PER_VM)
          throw new HttpError(429, 'Terminal connection limit reached');
        approved.set(request, rental);
      },
    },
    (socket, request) => {
      const rental = approved.get(request);
      if (!rental) {
        socket.close(1008, 'Authorization required');
        return;
      }
      const sockets = open.get(rental.id) ?? new Set<WebSocket>();
      if (total >= MAX_SESSIONS || sockets.size >= MAX_SHELLS_PER_VM) {
        socket.close(1008, 'Terminal connection limit reached');
        return;
      }
      sockets.add(socket);
      open.set(rental.id, sockets);
      total++;
      let upstream: WebSocket | undefined;
      let finished = false;
      let validating = false;
      let ready = false;
      let pending: string[] = [];
      let pendingBytes = 0;
      let renewTimer: ReturnType<typeof setTimeout> | undefined;
      let windowStart = Date.now();
      let windowFrames = 0;
      let windowAcks = 0;
      let line = ''; // Ephemeral fixture line editor only; no shell transcript is retained.

      const send = (value: object) => {
        if (finished || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > MAX_BUFFER) {
          close(1013, 'Terminal output buffer exceeded');
          return;
        }
        socket.send(JSON.stringify(value));
      };
      const output = (data: string) =>
        send({ type: 'output', data: Buffer.from(data, 'utf8').toString('base64') });
      function close(code: number, reason: string): void {
        if (finished) return;
        finished = true;
        clearInterval(validationTimer);
        clearTimeout(expiryTimer);
        clearTimeout(renewTimer);
        pending = [];
        pendingBytes = 0;
        line = '';
        sockets.delete(socket);
        disconnects.delete(socket);
        if (!sockets.size) open.delete(rental!.id);
        total--;
        if (upstream && upstream.readyState !== WebSocket.CLOSED)
          upstream.close(1000, 'Broker connection closed');
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
          socket.close(code, reason);
        // A peer that ignores close frames must not keep a revoked shell or application shutdown alive.
        const closingUpstream = upstream;
        const forcedClose = setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
          if (closingUpstream && closingUpstream.readyState !== WebSocket.CLOSED)
            closingUpstream.terminate();
        }, 2000);
        forcedClose.unref();
        // Metadata only: do not log frames, command text, upstream URL, token, or request headers.
        request.log.info(
          { vmId: rental!.id, mode: ctx.wick.mode, reason },
          'Terminal disconnected',
        );
      }
      const validationTimer = setInterval(() => {
        if (validating || finished) return;
        validating = true;
        void authorize(request)
          .then((current) => {
            if (current.environment_id !== rental.environment_id) close(1008, 'Rental changed');
          })
          .catch(() => close(1008, 'Rental access ended'))
          .finally(() => {
            validating = false;
          });
      }, VALIDATE_EVERY_MS);
      const expiryTimer = setTimeout(
        () => close(1008, 'Rental expired'),
        Math.max(1, new Date(rental.expires_at).getTime() - Date.now()),
      );
      disconnects.set(socket, () => close(1001, 'Application restarting'));

      const fixtureCommand = (command: string) => {
        const trimmed = command.trim();
        if (!trimmed) return;
        if (trimmed === 'help')
          output(
            'Simulated demo terminal. No commands run on a real VM.\r\nTry: help, pwd, whoami, ls, date, echo <text>, clear, exit.\r\n',
          );
        else if (trimmed === 'pwd') output('/workspace (simulated)\r\n');
        else if (trimmed === 'whoami') output('demo-customer (simulated)\r\n');
        else if (trimmed === 'ls') output('This simulated workspace has no real files.\r\n');
        else if (trimmed === 'date') output(`${new Date().toISOString()} (broker clock)\r\n`);
        else if (trimmed === 'clear') output('\x1b[2J\x1b[H');
        else if (trimmed.startsWith('echo ')) output(`${trimmed.slice(5)}\r\n`);
        else if (trimmed === 'exit') {
          send({ type: 'exit', exitCode: 0 });
          close(1000, 'Terminal disconnected');
        } else
          output(
            'Simulation only: this command was not executed. Type help for available demo interactions.\r\n',
          );
      };
      const fixtureInput = (data: string) => {
        let echo = '';
        const flush = () => {
          if (echo) {
            output(echo);
            echo = '';
          }
        };
        for (const character of data) {
          if (finished) return;
          if (character === '\r' || character === '\n') {
            echo += '\r\n';
            flush();
            fixtureCommand(line);
            line = '';
            if (!finished) output('\x1b[32mwick-demo\x1b[0m $ ');
          } else if (character === '\x03') {
            line = '';
            echo += '^C\r\n\x1b[32mwick-demo\x1b[0m $ ';
          } else if (character === '\x04') {
            flush();
            send({ type: 'exit', exitCode: 0 });
            close(1000, 'Terminal disconnected');
          } else if (character === '\x7f' || character === '\b') {
            if (line.length) {
              line = line.slice(0, -1);
              echo += '\b \b';
            }
          } else if (character >= ' ' && character !== '\x7f') {
            if (Buffer.byteLength(line) > 8192) {
              close(1009, 'Input line too long');
              return;
            }
            line += character;
            echo += character;
          }
        }
        flush();
      };

      // Attach message handlers synchronously so early browser resize/input frames cannot be lost.
      socket.on('message', (raw, binary) => {
        try {
          if (binary || Buffer.byteLength(decoded(raw)) > MAX_CLIENT_FRAME + 1024)
            throw new Error('Oversized terminal frame');
          const frame = parseTerminalInput(JSON.parse(decoded(raw)) as unknown);
          if (Date.now() - windowStart >= 1000) {
            windowStart = Date.now();
            windowFrames = 0;
            windowAcks = 0;
          }
          // Output acknowledgements have a separate allowance so a busy shell does not consume
          // the customer's keystroke/resize budget. Both directions remain bounded.
          if (frame.type === 'ack' ? ++windowAcks > 2000 : ++windowFrames > 150) {
            close(1008, 'Terminal input rate exceeded');
            return;
          }
          if (Date.now() >= new Date(rental.expires_at).getTime()) {
            close(1008, 'Rental expired');
            return;
          }
          if (ctx.wick.mode === 'fixture') {
            if (frame.type === 'input') fixtureInput(frame.data);
            else if (frame.type === 'ping') send({ type: 'pong' });
            return;
          }
          const serialized = JSON.stringify(frame);
          if (!ready) {
            pendingBytes += Buffer.byteLength(serialized);
            if (pendingBytes > MAX_BUFFER) {
              close(1013, 'Terminal connection buffer exceeded');
              return;
            }
            pending.push(serialized);
          } else if (upstream?.readyState === WebSocket.OPEN) {
            if (upstream.bufferedAmount > MAX_BUFFER) {
              close(1013, 'Terminal input buffer exceeded');
              return;
            }
            upstream.send(serialized);
          }
        } catch {
          send({ type: 'error', message: 'Invalid terminal message' });
          close(1008, 'Invalid terminal frame');
        }
      });
      socket.on('close', () => close(1000, 'Browser disconnected'));
      socket.on('error', () => close(1011, 'Browser connection failed'));
      request.log.info({ vmId: rental.id, mode: ctx.wick.mode }, 'Terminal connected');

      if (ctx.wick.mode === 'fixture') {
        ready = true;
        send({ type: 'ready', mode: 'fixture' });
        output(
          '\x1b[1mWick Broker · simulated demo terminal\x1b[0m\r\nNo real VM is allocated. Commands here are simulated; nothing runs on the app server.\r\nYour rental clock continues when you disconnect. Type help to explore.\r\n\r\n\x1b[32mwick-demo\x1b[0m $ ',
        );
        return;
      }

      const scheduleRenewal = (session: WickSession) => {
        clearTimeout(renewTimer);
        const delay = Math.min(RENEW_AFTER_MS, Date.parse(session.expiresAt) - Date.now() - 30_000);
        if (delay < 1000) {
          close(1011, 'Upstream session lifetime is too short');
          return;
        }
        renewTimer = setTimeout(() => {
          void (async () => {
            await authorize(request);
            const refreshed = await ctx.wick.session(rental.environment_id);
            if (finished || upstream?.readyState !== WebSocket.OPEN) return;
            upstream.send(JSON.stringify({ type: 'reauth', token: refreshed.token }));
            scheduleRenewal(refreshed);
          })().catch(() => {
            send({ type: 'error', message: 'Terminal authorization could not be renewed' });
            close(1008, 'Upstream authorization ended');
          });
        }, delay);
      };
      void (async () => {
        const session = await ctx.wick.session(rental.environment_id);
        await authorize(request);
        if (finished) return;
        const endpoint = new URL(session.terminalWebsocketUrl);
        if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password)
          throw new Error('Invalid upstream terminal transport');
        // Only the server-issued scoped session is used; the service API key never reaches this socket.
        upstream = new WebSocket(endpoint, {
          headers: { Authorization: `Bearer ${session.token}` },
          maxPayload: MAX_BUFFER,
          perMessageDeflate: false,
          followRedirects: false,
          handshakeTimeout: 12_000,
        });
        upstream.on('open', () => {
          if (finished) {
            upstream?.close();
            return;
          }
          ready = true;
          for (const frame of pending) upstream!.send(frame);
          pending = [];
          pendingBytes = 0;
          scheduleRenewal(session);
        });
        upstream.on('message', (raw, binary) => {
          try {
            if (binary) throw new Error('Unexpected binary upstream frame');
            const frame = JSON.parse(decoded(raw)) as Record<string, unknown>;
            if (
              frame.type === 'output' &&
              typeof frame.data === 'string' &&
              /^[A-Za-z0-9+/]*={0,2}$/.test(frame.data) &&
              frame.data.length % 4 === 0
            )
              send({ type: 'output', data: frame.data });
            else if (frame.type === 'ready') send({ type: 'ready', mode: 'real' });
            else if (frame.type === 'exit' && Number.isInteger(frame.exitCode)) {
              send({ type: 'exit', exitCode: frame.exitCode });
              close(1000, 'Upstream shell exited');
            } else if (frame.type === 'error') {
              send({ type: 'error', message: 'Wick reported a terminal error' });
              close(1011, 'Upstream terminal error');
            } else if (frame.type === 'pong') send({ type: 'pong' });
            else throw new Error('Unsupported upstream terminal frame');
          } catch {
            send({ type: 'error', message: 'Wick terminal protocol could not be read' });
            close(1011, 'Invalid upstream terminal frame');
          }
        });
        upstream.on('close', () => close(1000, 'Upstream terminal disconnected'));
        upstream.on('error', () => {
          send({ type: 'error', message: 'Wick terminal connection failed' });
          close(1011, 'Upstream terminal connection failed');
        });
      })().catch(() => {
        send({ type: 'error', message: 'Terminal session could not be established' });
        close(1011, 'Terminal session unavailable');
      });
    },
  );

  app.addHook('preClose', async () => {
    for (const disconnect of [...disconnects.values()]) disconnect();
  });
}
