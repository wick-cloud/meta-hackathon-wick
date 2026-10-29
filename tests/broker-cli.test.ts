import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { BrokerClient } from '@wick-cloud/broker-sdk';
import { runCli, attachTerminal, type CliIO } from '../packages/cli/src/index.js';
import {
  credentialFile,
  resolveCredentials,
  saveCredentials,
} from '../packages/cli/src/profile.js';
const key = `wbk_12345678-1234-1234-1234-123456789012.${'a'.repeat(43)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temporary() {
  const d = await mkdtemp(join(tmpdir(), 'broker-cli-test-'));
  directories.push(d);
  return d;
}
function io(
  client?: BrokerClient,
  input = '',
): CliIO & { stdout: () => string; stderr: () => string } {
  let stdout = '',
    stderr = '';
  return {
    input: Readable.from([input]),
    output: new Writable({
      write(chunk, _encoding, done) {
        stdout += chunk.toString();
        done();
      },
    }),
    error: new Writable({
      write(chunk, _encoding, done) {
        stderr += chunk.toString();
        done();
      },
    }),
    env: {},
    client,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
describe('Broker CLI credentials', () => {
  it('keeps private credentials bound to one origin and never falls back to a Wick key', async () => {
    const configDirectory = await temporary();
    await saveCredentials({ apiUrl: 'https://broker.example', apiKey: key }, { configDirectory });
    expect(await resolveCredentials({ configDirectory, env: {} })).toEqual({
      apiUrl: 'https://broker.example',
      apiKey: key,
    });
    await expect(
      resolveCredentials({ configDirectory, apiUrl: 'https://other.example', env: {} }),
    ).rejects.toThrow('origin');
    expect((await stat(credentialFile({ configDirectory }))).mode & 0o777).toBe(0o600);
    await expect(
      resolveCredentials({
        configDirectory: await temporary(),
        env: { WICK_API_KEY: 'upstream-key' },
      }),
    ).rejects.toThrow('No Broker credential');
  });
  it('rejects credential-bearing or insecure remote origins', async () => {
    for (const apiUrl of [
      'http://remote.example',
      'https://key:secret@broker.example',
      'https://broker.example/path',
    ])
      await expect(
        saveCredentials({ apiUrl, apiKey: key }, { configDirectory: await temporary() }),
      ).rejects.toThrow('HTTPS origin');
  });
  it('reads a key from stdin, verifies identity, and never prints it', async () => {
    const mock = {
      me: vi.fn(async () => ({ user: { email: 'buyer@test.invalid', role: 'buyer' } })),
    } as unknown as BrokerClient;
    const output = io(mock, key + '\n');
    output.configDirectory = await temporary();
    expect(
      await runCli(
        ['auth', 'login', '--stdin', '--api-url', 'https://broker.example', '--json'],
        output,
      ),
    ).toBe(0);
    expect(JSON.parse(output.stdout()).authenticated).toBe(true);
    expect(output.stdout() + output.stderr()).not.toContain(key);
    expect(JSON.parse(await readFile(credentialFile(output), 'utf8')).apiKey).toBe(key);
    expect(await runCli(['auth', 'logout', '--json'], output)).toBe(0);
    await expect(readFile(credentialFile(output))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
describe('Broker CLI machine operations', () => {
  it('runs through the installed executable symlink', async () => {
    const result = await promisify(execFile)(process.execPath, [
      resolve('node_modules/.bin/wick-broker'),
      '--version',
      '--json',
    ]);
    expect(JSON.parse(result.stdout)).toEqual({ version: '0.1.0' });
    expect(result.stderr).toBe('');
  });
  it('provides help and version without a credential', async () => {
    const help = io();
    expect(await runCli(['--help'], help)).toBe(0);
    expect(help.stdout()).toContain('WICK_BROKER_API_KEY');
    const version = io();
    expect(await runCli(['--version'], version)).toBe(0);
    expect(version.stdout().trim()).toBe('0.1.0');
  });
  it('rejects noninteractive mutations before any request without a stable key', async () => {
    const request = vi.fn();
    const output = io({ request } as unknown as BrokerClient);
    expect(await runCli(['vms', 'terminate', 'vm-one', '--json'], output)).toBe(1);
    expect(JSON.parse(output.stdout()).error).toContain('--operation-key');
    expect(request).not.toHaveBeenCalled();
  });
  it('emits only JSON and forwards exact mutation operation keys', async () => {
    const request = vi.fn(async () => ({ accepted: true }));
    const output = io({ request } as unknown as BrokerClient);
    expect(
      await runCli(
        ['vms', 'terminate', 'vm-one', '--operation-key', 'cleanup-001', '--json'],
        output,
      ),
    ).toBe(0);
    expect(JSON.parse(output.stdout())).toEqual({ accepted: true });
    expect(output.stderr()).toBe('');
    expect(request).toHaveBeenCalledWith('POST', '/api/vms/vm-one/terminate', {
      body: {},
      operationKey: 'cleanup-001',
    });
  });
  it('does not perform a mutation before rejecting unsupported --wait', async () => {
    const request = vi.fn();
    const output = io({ request } as unknown as BrokerClient);
    expect(
      await runCli(
        ['vms', 'terminate', 'vm-one', '--operation-key', 'cleanup-001', '--wait', '--json'],
        output,
      ),
    ).toBe(1);
    expect(request).not.toHaveBeenCalled();
  });
  it('preserves pending wait results without another create or cancellation', async () => {
    const request = vi.fn(async () => ({ id: 'auction-one' })),
      wait = vi.fn(async () => ({ id: 'auction-one', state: 'pending' }));
    const output = io(
      { request, orders: { wait } } as unknown as BrokerClient,
      JSON.stringify({ description: 'approved spec' }),
    );
    expect(
      await runCli(
        ['orders', 'create', '--file', '-', '--operation-key', 'create-001', '--wait', '--json'],
        output,
      ),
    ).toBe(0);
    expect(JSON.parse(output.stdout()).state).toBe('pending');
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith('auction-one', { timeoutMs: 120000 });
  });
  it('acknowledges consumed terminal output and restores raw mode', async () => {
    const input = new PassThrough() as CliIO['input'];
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = vi.fn();
    const output = io();
    output.input = input;
    output.output.isTTY = true;
    const terminal = {
      write: vi.fn(),
      resize: vi.fn(),
      ack: vi.fn(),
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'output', data: Buffer.from('hello') };
        yield { type: 'exit', exitCode: 0 };
      },
    };
    await attachTerminal(
      { vms: { terminal: vi.fn(async () => terminal) } } as unknown as BrokerClient,
      'vm-one',
      output,
    );
    expect(output.stdout()).toBe('hello');
    expect(terminal.ack).toHaveBeenCalledWith(5);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(terminal.close).toHaveBeenCalled();
  });
  it.each([
    {
      label: 'UTF-8 split at every byte',
      chunks: [...Buffer.from('echo café 😀\r')].map((byte) => Buffer.from([byte])),
      expected: 'echo café 😀\r',
    },
    {
      label: 'a pending character joined to a full input frame',
      chunks: [
        Buffer.from('😀').subarray(0, 2),
        Buffer.concat([Buffer.from('😀').subarray(2), Buffer.from('a'.repeat(32766))]),
      ],
      expected: '😀' + 'a'.repeat(32766),
    },
    {
      label: 'a multibyte paste larger than one frame',
      chunks: [Buffer.from('é😀'.repeat(12000))],
      expected: 'é😀'.repeat(12000),
    },
    {
      label: 'an incomplete UTF-8 character at EOF',
      chunks: [Buffer.from([0xe2, 0x82])],
      expected: '\ufffd',
    },
    {
      label: 'Ctrl-C forwarding and Ctrl-] detachment',
      chunks: [Buffer.from('\u0003'), Buffer.from('\u001d')],
      expected: '\u0003',
      detach: true,
    },
  ])('preserves $label and restores the TTY', async ({ chunks, expected, detach }) => {
    const input = new PassThrough() as PassThrough & CliIO['input'];
    input.isTTY = true;
    input.isRaw = true;
    input.setRawMode = vi.fn();
    const output = io();
    output.input = input;
    output.output.isTTY = true;
    let finish!: () => void, started!: () => void;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const terminal = {
      write: vi.fn((_data: string) => {}),
      resize: vi.fn(),
      ack: vi.fn(),
      close: vi.fn(() => finish()),
      async *[Symbol.asyncIterator]() {
        started();
        yield { type: 'ready' };
        await ended;
      },
    };
    const attached = attachTerminal(
      { vms: { terminal: vi.fn(async () => terminal) } } as unknown as BrokerClient,
      'vm-one',
      output,
    );
    await ready;
    for (const chunk of chunks) input.write(chunk);
    if (!detach) input.end();
    await attached;
    const frames = terminal.write.mock.calls.map(([data]) => data);
    expect(frames.join('')).toBe(expected);
    expect(frames.every((frame) => Buffer.byteLength(frame) <= 32768)).toBe(true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(true);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
    expect(input.isPaused()).toBe(true);
    expect(terminal.close).toHaveBeenCalled();
  });
});
