import type { FastifyInstance, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { HttpError, type AppContext } from '../context.js';
import type { WickTerminal } from './types.js';
import { demoTerminalActor } from '../demo/access.js';

const MAX_CLIENT_FRAME = 32 * 1024;
const MAX_BUFFER = 256 * 1024;
const MAX_SESSIONS = 64;
const MAX_SHELLS_PER_VM = 2;
const VALIDATE_EVERY_MS = 2000;
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
    if (request.headers.origin !== undefined && request.headers.origin !== allowedOrigin)
      throw new HttpError(403, 'Terminal origin is not allowed');
    const id = (request.params as { id: string }).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new HttpError(404, 'VM not found');
    // Demo cookies authorize only their own ready terminal. They never create a normal
    // account session, and an explicit Bearer credential always retains its own authority.
    const actor =
      request.headers.authorization !== undefined
        ? await ctx.requireActor(request, ['buyer'])
        : await demoTerminalActor(ctx, request, id).catch((error: unknown) => {
            if (error instanceof HttpError && [401, 403].includes(error.statusCode))
              return ctx.requireActor(request, ['buyer']);
            throw error;
          });
    if (!actor.apiKey && request.headers.origin !== allowedOrigin)
      throw new HttpError(403, 'Terminal origin is not allowed');
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
      let upstream: WickTerminal | undefined;
      const terminalAbort = new AbortController();
      let finished = false;
      let validating = false;
      let ready = false;
      let pending: ClientFrame[] = [];
      let pendingBytes = 0;
      let outstandingBytes = 0;
      let windowStart = Date.now();
      let windowFrames = 0;
      let windowAcks = 0;

      const send = (value: object) => {
        if (finished || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > MAX_BUFFER) {
          close(1013, 'Terminal output buffer exceeded');
          return;
        }
        socket.send(JSON.stringify(value));
      };
      function close(code: number, reason: string): void {
        if (finished) return;
        finished = true;
        clearInterval(validationTimer);
        clearTimeout(expiryTimer);
        terminalAbort.abort();
        pending = [];
        pendingBytes = 0;
        sockets.delete(socket);
        disconnects.delete(socket);
        if (!sockets.size) open.delete(rental!.id);
        total--;
        upstream?.close();
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
          socket.close(code, reason);
        // A peer that ignores close frames must not keep a revoked shell or application shutdown alive.
        const forcedClose = setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
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

      const forward = (frame: ClientFrame) => {
        if (!upstream) return;
        if (frame.type === 'input') upstream.input(frame.data);
        else if (frame.type === 'resize') upstream.resize(frame.cols, frame.rows);
        else if (frame.type === 'ack') {
          // A browser cannot grant credit for output that it has not received.
          const consumed = Math.min(frame.bytes, outstandingBytes);
          if (consumed > 0) {
            upstream.ack(consumed);
            outstandingBytes -= consumed;
          }
        }
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
          if (frame.type === 'ping') {
            send({ type: 'pong' });
            return;
          }
          // SDK may emit output before ready; its acknowledgements must not wait for readiness.
          if (frame.type === 'ack') {
            forward(frame);
            return;
          }
          if (!ready) {
            pendingBytes += Buffer.byteLength(JSON.stringify(frame));
            if (pendingBytes > MAX_BUFFER) {
              close(1013, 'Terminal connection buffer exceeded');
              return;
            }
            pending.push(frame);
          } else forward(frame);
        } catch {
          send({ type: 'error', message: 'Invalid terminal message' });
          close(1008, 'Invalid terminal frame');
        }
      });
      socket.on('close', () => close(1000, 'Browser disconnected'));
      socket.on('error', () => close(1011, 'Browser connection failed'));
      request.log.info({ vmId: rental.id, mode: ctx.wick.mode }, 'Terminal connected');

      void (async () => {
        const handle = await ctx.wick.terminal(rental.environment_id, {
          signal: terminalAbort.signal,
        });
        upstream = handle;
        if (finished) {
          handle.close();
          return;
        }
        await authorize(request);
        for await (const event of handle) {
          if (finished) break;
          if (event.type === 'ready') {
            await authorize(request);
            ready = true;
            send({ type: 'ready', mode: ctx.wick.mode });
            for (const frame of pending) forward(frame);
            pending = [];
            pendingBytes = 0;
          } else if (event.type === 'output') {
            outstandingBytes += event.data.byteLength;
            if (outstandingBytes > MAX_BUFFER) {
              close(1013, 'Terminal output buffer exceeded');
              return;
            }
            send({ type: 'output', data: Buffer.from(event.data).toString('base64') });
          } else if (event.type === 'exit') {
            send({ type: 'exit', exitCode: event.exitCode });
            close(1000, 'Upstream shell exited');
          } else if (event.type === 'pong') send({ type: 'pong' });
        }
        close(1000, 'Upstream terminal disconnected');
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
