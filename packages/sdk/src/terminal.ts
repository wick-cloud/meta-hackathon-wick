import WebSocket from 'ws';
import { BrokerError } from './errors.js';

export type TerminalEvent =
  | { type: 'ready'; mode?: 'fixture' | 'real' }
  | { type: 'output'; data: Uint8Array }
  | { type: 'exit'; exitCode: number }
  | { type: 'pong' };
export interface TerminalOptions {
  cols?: number;
  rows?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}
const MAX_BUFFER = 256 * 1024;

/** A customer-owned Broker PTY. Closing this handle never terminates the VM. */
export class BrokerTerminal implements AsyncIterable<TerminalEvent> {
  #socket: WebSocket;
  #queue: TerminalEvent[] = [];
  #buffered = 0;
  #outstanding = 0;
  #closed = false;
  #error: BrokerError | undefined;
  #waiter: (() => void) | undefined;
  #readyResolve!: () => void;
  #readyReject!: (e: BrokerError) => void;
  #ready = false;
  readonly ready: Promise<void>;
  private constructor(socket: WebSocket, options: TerminalOptions) {
    this.#socket = socket;
    this.ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    const fail = (error: BrokerError) => {
      this.#error = error;
      this.#readyReject(error);
      this.close();
    };
    const timer = setTimeout(
      () =>
        fail(
          new BrokerError('Broker terminal did not become ready before the deadline.', {
            code: 'terminal_timeout',
          }),
        ),
      Math.min(Math.max(options.timeoutMs ?? 15000, 1), 60000),
    );
    timer.unref?.();
    const abort = () =>
      fail(new BrokerError('Broker terminal connection was cancelled.', { code: 'cancelled' }));
    options.signal?.addEventListener('abort', abort, { once: true });
    socket.on('message', (raw, binary) => {
      try {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
        if (binary || bytes.byteLength > 360000) throw new Error();
        const value = JSON.parse(bytes.toString()) as Record<string, unknown>;
        let event: TerminalEvent;
        if (value.type === 'ready') {
          event = {
            type: 'ready',
            ...(value.mode === 'real' || value.mode === 'fixture' ? { mode: value.mode } : {}),
          };
          this.#ready = true;
          clearTimeout(timer);
          this.#readyResolve();
          this.resize(options.cols ?? 80, options.rows ?? 24);
        } else if (value.type === 'output' && typeof value.data === 'string') {
          if (
            value.data.length > Math.ceil(MAX_BUFFER / 3) * 4 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
          )
            throw new Error();
          const data = Buffer.from(value.data, 'base64');
          if (
            data.byteLength > MAX_BUFFER ||
            this.#buffered + data.byteLength > MAX_BUFFER ||
            this.#outstanding + data.byteLength > MAX_BUFFER
          ) {
            fail(
              new BrokerError(
                'Broker terminal output exceeded its buffer. Reconnect explicitly to continue.',
                { code: 'terminal_overflow' },
              ),
            );
            return;
          }
          this.#buffered += data.byteLength;
          this.#outstanding += data.byteLength;
          event = { type: 'output', data };
        } else if (value.type === 'exit' && Number.isSafeInteger(value.exitCode))
          event = { type: 'exit', exitCode: value.exitCode as number };
        else if (value.type === 'pong') event = { type: 'pong' };
        else if (value.type === 'error') {
          fail(
            new BrokerError('Broker could not continue this terminal session.', {
              code: 'terminal_error',
            }),
          );
          return;
        } else throw new Error();
        if (this.#queue.length >= 1024) {
          fail(
            new BrokerError('Broker terminal event queue exceeded its bound.', {
              code: 'terminal_overflow',
            }),
          );
          return;
        }
        this.#queue.push(event);
        this.#waiter?.();
      } catch {
        fail(
          new BrokerError('Broker returned an invalid terminal message.', {
            code: 'invalid_terminal_response',
          }),
        );
      }
    });
    socket.on('error', () =>
      fail(new BrokerError('Broker terminal connection failed.', { code: 'terminal_unavailable' })),
    );
    socket.on('unexpected-response', (_req, response) => {
      response.resume();
      fail(
        new BrokerError('Broker rejected terminal access.', {
          status: response.statusCode ?? 0,
          code:
            response.statusCode === 401
              ? 'unauthorized'
              : response.statusCode === 403
                ? 'forbidden'
                : 'terminal_unavailable',
        }),
      );
    });
    socket.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      this.#closed = true;
      if (!this.#ready)
        this.#readyReject(
          new BrokerError('Broker terminal closed before becoming ready.', {
            code: 'terminal_unavailable',
          }),
        );
      if (code !== 1000 && code !== 1001 && !this.#error)
        this.#error = new BrokerError('Broker terminal access ended.', { code: 'terminal_closed' });
      this.#waiter?.();
    });
    if (options.signal?.aborted) abort();
  }
  static async connect(
    url: URL,
    apiKey: string,
    options: TerminalOptions = {},
  ): Promise<BrokerTerminal> {
    if (options.signal?.aborted)
      throw new BrokerError('Broker terminal connection was cancelled.', { code: 'cancelled' });
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      followRedirects: false,
      maxPayload: 360000,
      perMessageDeflate: false,
      handshakeTimeout: Math.min(options.timeoutMs ?? 15000, 60000),
    });
    const terminal = new BrokerTerminal(socket, options);
    try {
      await terminal.ready;
      return terminal;
    } catch (error) {
      terminal.close();
      throw error;
    }
  }
  get closed() {
    return this.#closed;
  }
  #send(value: object) {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN)
      throw new BrokerError('Broker terminal is closed.', { code: 'terminal_closed' });
    if (this.#socket.bufferedAmount > MAX_BUFFER) {
      this.close();
      throw new BrokerError('Broker terminal input buffer exceeded its bound.', {
        code: 'terminal_overflow',
      });
    }
    this.#socket.send(JSON.stringify(value));
  }
  write(data: string) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 32768)
      throw new BrokerError('Terminal input must be at most 32 KiB.', { code: 'invalid_input' });
    this.#send({ type: 'input', data });
  }
  input(data: string) {
    this.write(data);
  }
  resize(cols: number, rows: number) {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 2 ||
      cols > 500 ||
      rows < 1 ||
      rows > 200
    )
      throw new BrokerError('Terminal dimensions must be 2–500 columns and 1–200 rows.', {
        code: 'invalid_input',
      });
    this.#send({ type: 'resize', cols, rows });
  }
  /** Acknowledge output only after the consumer has displayed or read it. */
  ack(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BUFFER)
      throw new BrokerError('Invalid terminal acknowledgement.', { code: 'invalid_input' });
    const consumed = Math.min(bytes, this.#outstanding);
    if (consumed > 0) {
      this.#outstanding -= consumed;
      // A final output frame can be drained after a normal remote close. There is
      // no upstream credit to grant then, but local consumption must still succeed.
      if (!this.#closed && this.#socket.readyState === WebSocket.OPEN)
        this.#send({ type: 'ack', bytes: consumed });
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
    else this.#socket.close();
    this.#waiter?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<TerminalEvent> {
    try {
      for (;;) {
        const event = this.#queue.shift();
        if (event) {
          if (event.type === 'output') this.#buffered -= event.data.byteLength;
          yield event;
          continue;
        }
        if (this.#error) throw this.#error;
        if (this.#closed) return;
        await new Promise<void>((resolve) => {
          this.#waiter = resolve;
        });
        this.#waiter = undefined;
      }
    } finally {
      this.close();
    }
  }
}
