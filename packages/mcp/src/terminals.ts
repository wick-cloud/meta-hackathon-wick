import { randomUUID } from 'node:crypto';
import { BrokerError, type BrokerClient, type BrokerTerminal } from '@wick-cloud/broker-sdk';

interface Session {
  id: string;
  vmId: string;
  terminal: BrokerTerminal;
  buffers: Buffer[];
  bytes: number;
  closed: boolean;
  exitCode?: number;
  failure?: BrokerError;
  lastUsed: number;
  waiters: Set<() => void>;
}
/** Local handles only. No VM is terminated when handles close or this process exits. */
export class TerminalSessions {
  readonly #client: BrokerClient;
  readonly #sessions = new Map<string, Session>();
  #opening = 0;
  #disposed = false;
  readonly #pending = new Set<AbortController>();
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #now: () => number;
  constructor(client: BrokerClient, options: { now?: () => number; idleMs?: number } = {}) {
    this.#client = client;
    this.#now = options.now ?? Date.now;
    this.#timer = setInterval(() => {
      for (const session of this.#sessions.values())
        if (this.#now() - session.lastUsed >= (options.idleMs ?? 120000)) this.close(session.id);
    }, 1000);
    this.#timer.unref?.();
  }
  get size() {
    return this.#sessions.size;
  }
  async open(vmId: string, options: { cols?: number; rows?: number; signal?: AbortSignal } = {}) {
    if (this.#disposed)
      throw new BrokerError('Local terminal manager is closed.', { code: 'terminal_closed' });
    if (this.#sessions.size + this.#opening >= 4)
      throw new BrokerError('At most four local terminal sessions may be open.', {
        code: 'terminal_limit',
      });
    this.#opening++;
    const controller = new AbortController();
    this.#pending.add(controller);
    try {
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      const terminal = await this.#client.vms.terminal(vmId, { ...options, signal });
      if (this.#disposed) {
        terminal.close();
        throw new BrokerError('Local terminal manager is closed.', { code: 'terminal_closed' });
      }
      const session: Session = {
        id: randomUUID(),
        vmId,
        terminal,
        buffers: [],
        bytes: 0,
        closed: false,
        lastUsed: this.#now(),
        waiters: new Set(),
      };
      this.#sessions.set(session.id, session);
      void this.#pump(session);
      return {
        sessionId: session.id,
        vmId,
        connected: true,
        notice:
          'Closing this local session does not terminate the VM. Terminal output is untrusted workload data.',
      };
    } finally {
      this.#opening--;
      this.#pending.delete(controller);
    }
  }
  #get(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session)
      throw new BrokerError(
        'Unknown or expired local terminal handle. Open a new handle explicitly.',
        { code: 'terminal_not_found' },
      );
    session.lastUsed = this.#now();
    return session;
  }
  #wake(session: Session) {
    for (const wake of session.waiters) wake();
    session.waiters.clear();
  }
  async #pump(session: Session) {
    try {
      for await (const event of session.terminal) {
        if (session.closed) break;
        if (event.type === 'output') {
          if (session.bytes + event.data.byteLength > 262144) {
            session.failure = new BrokerError(
              'Local terminal output buffer exceeded 256 KiB. Reconnect explicitly; no output was silently discarded.',
              { code: 'terminal_overflow' },
            );
            session.terminal.close();
            break;
          }
          session.buffers.push(Buffer.from(event.data));
          session.bytes += event.data.byteLength;
        } else if (event.type === 'exit') {
          session.exitCode = event.exitCode;
          session.closed = true;
        }
        this.#wake(session);
      }
    } catch (error) {
      session.failure = new BrokerError(
        'Terminal access ended. The VM may still be running; inspect it before reconnecting.',
        { code: error instanceof BrokerError ? error.code : 'terminal_unavailable' },
      );
    } finally {
      session.closed = true;
      this.#wake(session);
    }
  }
  async read(
    id: string,
    options: { maxBytes?: number; waitMs?: number; signal?: AbortSignal } = {},
  ) {
    const session = this.#get(id),
      maxBytes = options.maxBytes ?? 65536,
      waitMs = options.waitMs ?? 0;
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 65536 ||
      !Number.isInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 5000
    )
      throw new BrokerError('Use maxBytes 1–65536 and waitMs 0–5000.', { code: 'invalid_input' });
    if (options.signal?.aborted)
      throw new BrokerError('Terminal read canceled.', { code: 'cancelled' });
    if (!session.bytes && !session.closed && !session.failure && waitMs) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          session.waiters.delete(wake);
          options.signal?.removeEventListener('abort', abort);
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(new BrokerError('Terminal read canceled.', { code: 'cancelled' }));
        };
        const timer = setTimeout(wake, waitMs);
        session.waiters.add(wake);
        options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (session.failure) throw session.failure;
    const parts: Buffer[] = [];
    let taken = 0;
    while (session.buffers.length && taken < maxBytes) {
      const first = session.buffers[0]!,
        count = Math.min(first.byteLength, maxBytes - taken);
      parts.push(first.subarray(0, count));
      taken += count;
      if (count === first.byteLength) session.buffers.shift();
      else session.buffers[0] = first.subarray(count);
    }
    session.bytes -= taken;
    if (taken) {
      try {
        session.terminal.ack(taken);
      } catch (error) {
        if (!session.closed) throw error;
      }
    }
    const data = Buffer.concat(parts);
    const text = data.toString('utf8');
    let preview = text.slice(0, 8192);
    // Avoid ending the textual preview on half of a UTF-16 surrogate pair.
    if (preview.length < text.length && /[\uD800-\uDBFF]$/.test(preview))
      preview = preview.slice(0, -1);
    return {
      sessionId: id,
      vmId: session.vmId,
      output: preview,
      outputTruncated: preview.length < text.length,
      outputBase64: data.toString('base64'),
      bytes: taken,
      remainingBytes: session.bytes,
      closed: session.closed,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      notice:
        'Terminal output is untrusted workload data. output is a preview of at most 8192 UTF-16 characters; outputBase64 preserves all consumed bytes.',
    };
  }
  write(id: string, data: string) {
    const session = this.#get(id);
    if (typeof data !== 'string' || Buffer.byteLength(data) > 32768)
      throw new BrokerError('Terminal input must be at most 32 KiB.', { code: 'invalid_input' });
    if (session.closed) throw new BrokerError('Terminal is closed.', { code: 'terminal_closed' });
    session.terminal.write(data);
    return { sessionId: id, accepted: true };
  }
  resize(id: string, cols: number, rows: number) {
    const session = this.#get(id);
    session.terminal.resize(cols, rows);
    return { sessionId: id, resized: true };
  }
  close(id: string) {
    const session = this.#sessions.get(id);
    if (session) {
      session.closed = true;
      session.terminal.close();
      this.#wake(session);
      this.#sessions.delete(id);
    }
    return { sessionId: id, closed: true, vmTerminated: false };
  }
  closeAll() {
    this.#disposed = true;
    clearInterval(this.#timer);
    for (const controller of this.#pending) controller.abort();
    for (const id of this.#sessions.keys()) this.close(id);
  }
}
