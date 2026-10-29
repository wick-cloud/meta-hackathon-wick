#!/usr/bin/env node
import { BrokerClient } from '@wick-cloud/broker-sdk';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';
import { OPERATIONS, operationPath, type Operation } from './operations.js';
import {
  DEFAULT_API_URL,
  normalizeApiUrl,
  removeCredentials,
  resolveCredentials,
  saveCredentials,
  validateBrokerKey,
} from './profile.js';

const VERSION = '0.1.1';
const MAX_INPUT = 65536;
const MAX_TERMINAL_FRAME = 32768;
export interface CliIO {
  input: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => void };
  output: Writable & { isTTY?: boolean; columns?: number; rows?: number };
  error: Writable;
  env: NodeJS.ProcessEnv;
  configDirectory?: string;
  client?: BrokerClient;
}
const defaultIO = (): CliIO => ({
  input: process.stdin,
  output: process.stdout,
  error: process.stderr,
  env: process.env,
});
function line(io: CliIO, value: unknown) {
  io.output.write(`${JSON.stringify(value)}\n`);
}
function help(): string {
  return `Wick Broker ${VERSION}\n\nUsage: wick-broker <command> [id] [options]\n\n${OPERATIONS.map((o) => `  ${o.command}${o.path.includes(':id') ? ' <id>' : ''}`).join('\n')}\n  auth login [--stdin]\n  auth logout\n  vms wait <id>\n  vms terminal <id>\n\nOptions:\n  --file <path|->       JSON request body (maximum 64 KiB)\n  --operation-key <key> Stable key for a mutation; required without a TTY\n  --json               JSON output only; errors also use JSON\n  --wait               Wait for auction outcome without creating another order\n  --timeout <seconds>  Finite wait deadline, default 120, maximum 900\n  --api-url <origin>   Broker API origin; saved keys never cross origins\n  --limit/--cursor      Bounded list pagination\n  --kind/--status/--created  Orders filters\n  --from/--to          Commitment date range\n  --prompt/--strategy/--description  Muse proposal text\n\nCredentials: WICK_BROKER_API_KEY and WICK_BROKER_API_URL.\nWick keys are separate. Do not put API keys in command-line arguments.\n`;
}
async function inputText(input: Readable, limit = MAX_INPUT): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of input) {
    const b = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += b.byteLength;
    if (size > limit) throw new Error('Input exceeds the allowed size.');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readBody(file: string, input: Readable): Promise<Record<string, unknown>> {
  let raw: string;
  if (file === '-') raw = await inputText(input);
  else {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_INPUT + 1),
        result = await handle.read(buffer, 0, buffer.length, 0);
      if (result.bytesRead > MAX_INPUT) throw new Error('Request JSON exceeds 64 KiB.');
      raw = buffer.subarray(0, result.bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('The request file must contain valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('The request file must contain a JSON object.');
  return body as Record<string, unknown>;
}
async function hiddenKey(io: CliIO): Promise<string> {
  if (!io.input.isTTY || !io.input.setRawMode)
    throw new Error('Use auth login --stdin or an interactive terminal.');
  io.error.write('Broker API key (hidden): ');
  const wasRaw = io.input.isRaw ?? false;
  io.input.setRawMode(true);
  io.input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let text = '';
      const cleanup = () => {
        io.input.off('data', data);
        io.input.off('end', end);
        io.input.off('error', failure);
      };
      const failure = () => {
        cleanup();
        reject(new Error('Could not read the Broker key.'));
      };
      const end = () => {
        cleanup();
        reject(new Error('Broker key input ended before Enter.'));
      };
      const data = (chunk: Buffer | string) => {
        for (const char of chunk.toString()) {
          if (char === '\u0003') {
            cleanup();
            reject(new Error('Login canceled.'));
            return;
          }
          if (char === '\r' || char === '\n') {
            cleanup();
            resolve(text.trim());
            return;
          }
          if (char === '\u007f' || char === '\b') text = text.slice(0, -1);
          else if (char >= ' ' && char <= '~') text += char;
          if (text.length > 512) {
            cleanup();
            reject(new Error('Broker key input is too long.'));
            return;
          }
        }
      };
      io.input.on('data', data);
      io.input.once('end', end);
      io.input.once('error', failure);
    });
  } finally {
    io.input.setRawMode(wasRaw);
    io.input.pause();
    io.error.write('\n');
  }
}
function errorResult(error: unknown) {
  const value = error as {
    code?: string;
    status?: number;
    requestId?: string;
    operationKey?: string;
    message?: string;
  };
  const message = (value.message ?? 'Broker operation failed.').replace(
    /wbk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    '[redacted Broker key]',
  );
  return {
    error: message,
    code: value.code ?? 'client_error',
    ...(value.status ? { status: value.status } : {}),
    ...(value.requestId ? { requestId: value.requestId } : {}),
    ...(value.operationKey ? { operationKey: value.operationKey } : {}),
  };
}
function findOperation(positionals: string[]): { operation: Operation; ids: string[] } {
  const found = [...OPERATIONS]
    .sort((a, b) => b.command.split(' ').length - a.command.split(' ').length)
    .find((o) => o.command.split(' ').every((word, i) => positionals[i] === word));
  if (!found) throw new Error('Unknown command. Run wick-broker --help.');
  const ids = positionals.slice(found.command.split(' ').length);
  const expected = (found.path.match(/:[A-Za-z]+/g) ?? []).length;
  if (ids.length !== expected)
    throw new Error(
      `Usage: wick-broker ${found.command}${expected ? ' <id>' : ''}${expected > 1 ? ' <offer-id>' : ''}`,
    );
  return { operation: found, ids };
}
export async function attachTerminal(client: BrokerClient, id: string, io: CliIO): Promise<void> {
  if (!io.input.isTTY || !io.output.isTTY || !io.input.setRawMode)
    throw new Error('Terminal attachment requires an interactive TTY.');
  const terminal = await client.vms.terminal(id, {
    cols: io.output.columns ?? 80,
    rows: io.output.rows ?? 24,
  });
  const wasRaw = io.input.isRaw ?? false;
  const decoder = new StringDecoder('utf8');
  let inputFailure: unknown;
  const failedInput = (error: unknown) => {
    inputFailure = error;
    terminal.close();
  };
  const writeInput = (data: string) => {
    if (data.includes('\u001d')) {
      terminal.close();
      return;
    } // Ctrl-] detaches; Ctrl-C reaches the guest.
    const bytes = Buffer.from(data, 'utf8');
    for (let start = 0; start < bytes.length;) {
      let end = Math.min(start + MAX_TERMINAL_FRAME, bytes.length);
      // Move the boundary before any partial UTF-8 code point. Decoding stdin
      // may join bytes from separate chunks, so its result can exceed one frame.
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      terminal.write(bytes.subarray(start, end).toString('utf8'));
      start = end;
    }
  };
  const onInput = (chunk: Buffer | string) => {
    try {
      writeInput(decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    } catch (error) {
      failedInput(error);
    }
  };
  const onEnd = () => {
    try {
      writeInput(decoder.end());
    } catch (error) {
      failedInput(error);
    } finally {
      terminal.close();
    }
  };
  const resize = () => {
    try {
      terminal.resize(io.output.columns ?? 80, io.output.rows ?? 24);
    } catch (error) {
      failedInput(error);
    }
  };
  const stop = () => terminal.close();
  io.error.write('Attached. Ctrl-] detaches; it does not terminate the VM.\n');
  try {
    io.input.setRawMode(true);
    io.input.resume();
    io.input.on('data', onInput);
    io.input.on('end', onEnd);
    io.input.on('error', failedInput);
    io.output.on('resize', resize);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    process.once('SIGINT', stop);
    for await (const event of terminal) {
      if (event.type === 'output') {
        if (!io.output.write(event.data)) await once(io.output, 'drain');
        terminal.ack(event.data.byteLength);
      }
    }
    if (inputFailure) throw inputFailure;
  } finally {
    terminal.close();
    io.input.off('data', onInput);
    io.input.off('end', onEnd);
    io.input.off('error', failedInput);
    io.output.off('resize', resize);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    process.off('SIGINT', stop);
    io.input.setRawMode(wasRaw);
    io.input.pause();
  }
}
export async function runCli(args: string[], io: CliIO = defaultIO()): Promise<number> {
  let json = args.includes('--json');
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        json: { type: 'boolean' },
        stdin: { type: 'boolean' },
        wait: { type: 'boolean' },
        file: { type: 'string' },
        'operation-key': { type: 'string' },
        'api-url': { type: 'string' },
        timeout: { type: 'string' },
        limit: { type: 'string' },
        cursor: { type: 'string' },
        kind: { type: 'string' },
        status: { type: 'string' },
        created: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        prompt: { type: 'string' },
        strategy: { type: 'string' },
        description: { type: 'string' },
      },
    });
    const { values: flags, positionals } = parsed;
    json = flags.json ?? false;
    if (flags.version) {
      if (json) line(io, { version: VERSION });
      else io.output.write(`${VERSION}\n`);
      return 0;
    }
    if (flags.help || positionals.length === 0) {
      if (json) line(io, { help: help() });
      else io.output.write(help());
      return 0;
    }
    const config = { apiUrl: flags['api-url'], env: io.env, configDirectory: io.configDirectory };
    if (positionals.join(' ') === 'auth logout') {
      await removeCredentials(config);
      line(io, {
        loggedOut: true,
        note: 'Local credentials removed. Revoke the key in the Broker UI if needed.',
      });
      return 0;
    }
    if (positionals.join(' ') === 'auth login') {
      const apiUrl = normalizeApiUrl(
        flags['api-url'] ?? io.env.WICK_BROKER_API_URL ?? DEFAULT_API_URL,
      );
      const apiKey = validateBrokerKey(
        flags.stdin ? (await inputText(io.input, 512)).trim() : await hiddenKey(io),
      );
      const client = io.client ?? new BrokerClient({ baseUrl: apiUrl, apiKey });
      const me = await client.me();
      if (!me.user) throw new Error('The Broker key did not authenticate an account.');
      await saveCredentials({ apiUrl, apiKey }, config);
      line(io, {
        authenticated: true,
        apiUrl,
        account: { email: me.user.email, role: me.user.role },
      });
      return 0;
    }
    const credentials = io.client ? undefined : await resolveCredentials(config);
    const client =
      io.client ?? new BrokerClient({ baseUrl: credentials!.apiUrl, apiKey: credentials!.apiKey });
    if (positionals[0] === 'vms' && positionals[1] === 'terminal') {
      if (positionals.length !== 3 || json)
        throw new Error('Use vms terminal <id> in an interactive terminal without --json.');
      await attachTerminal(client, positionals[2]!, io);
      return 0;
    }
    const timeoutSeconds = Number(flags.timeout ?? 120);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 900)
      throw new Error('Timeout must be greater than zero and no more than 900 seconds.');
    if (positionals[0] === 'vms' && positionals[1] === 'wait') {
      if (positionals.length !== 3) throw new Error('Use vms wait <id>.');
      line(io, await client.vms.wait(positionals[2]!, { timeoutMs: timeoutSeconds * 1000 }));
      return 0;
    }
    const { operation, ids } = findOperation(positionals);
    if (flags.wait && operation.command !== 'orders create' && operation.command !== 'orders get')
      throw new Error(
        '--wait is supported only for auction create/get. Use vms wait for environment readiness.',
      );
    const body = flags.file
      ? await readBody(flags.file, io.input)
      : flags.prompt
        ? { prompt: flags.prompt }
        : flags.strategy
          ? { strategy: flags.strategy }
          : flags.description
            ? { description: flags.description }
            : {};
    if (operation.body && !Object.keys(body).length)
      throw new Error('Supply a JSON body with --file, or the relevant Muse text option.');
    let operationKey =
      flags['operation-key'] ??
      (typeof body.operationKey === 'string' ? body.operationKey : undefined);
    if (flags['operation-key'] && body.operationKey && flags['operation-key'] !== body.operationKey)
      throw new Error('The operation key in the file and command must match.');
    if (operation.mutation && !operationKey) {
      if (!io.input.isTTY || json)
        throw new Error(
          'Noninteractive mutations require --operation-key or operationKey in the JSON file. Reuse the same key when retrying.',
        );
      operationKey = randomUUID();
      io.error.write(`Operation key: ${operationKey}. Reuse it if the result is uncertain.\n`);
    }
    const query: Record<string, string | number | undefined> = {};
    for (const field of ['kind', 'status', 'created', 'cursor', 'from', 'to'] as const)
      if (flags[field] !== undefined) query[field] = flags[field];
    if (flags.limit !== undefined) {
      const n = Number(flags.limit);
      if (!Number.isInteger(n) || n < 1 || n > 100)
        throw new Error('Page limit must be an integer from 1 to 100.');
      query.limit = n;
    }
    const path = operationPath(operation, { id: ids[0], offerId: ids[1] });
    const result = await client.request<Record<string, unknown>>(operation.method, path, {
      ...(operation.method === 'GET' ? { query } : { body }),
      ...(operationKey ? { operationKey } : {}),
    });
    if (flags.wait) {
      if (operation.command !== 'orders create' && operation.command !== 'orders get')
        throw new Error(
          '--wait is supported only for auction create/get. Use vms wait for environment readiness.',
        );
      const id =
        typeof result.id === 'string'
          ? result.id
          : (result.request as { id?: string } | undefined)?.id;
      if (!id) throw new Error('Auction result did not include an order identifier.');
      line(io, await client.orders.wait(id, { timeoutMs: timeoutSeconds * 1000 }));
    } else line(io, result);
    return 0;
  } catch (error) {
    const result = errorResult(error);
    if (json) line(io, result);
    else io.error.write(`${result.error}\n`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
