import { describe, it, expect, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, readFile } from 'node:fs/promises';
import type { AppContext } from '../src/server/context.js';
import { guestStep } from '../src/server/coding/guest.js';

describe('native coding command envelope', () => {
  it('executes the real helper within Wick’s command limit with a large input', async () => {
    const id = randomUUID();
    const job = {
      id,
      environment_id: 'env_fixture',
      repository_url: 'https://github.com/pypa/sampleproject',
      commit_sha: 'a'.repeat(40),
      test_command: 'x'.repeat(500),
      deadline_at: new Date(Date.now() + 60000),
      source_mode: 'real',
    };
    const runCommand = vi.fn(async (_id: string, input: { command: string }) => {
      expect(input.command.length).toBeLessThanOrEqual(16000);
      const result = await promisify(execFile)('/bin/sh', ['-c', input.command], {
        timeout: 15000,
      });
      return { ...result, exitCode: 0 };
    });
    try {
      // The uncompressed executor alone already exceeds the native envelope.
      expect(
        Buffer.from(await readFile('scripts/coding-guest.py')).toString('base64').length,
      ).toBeGreaterThan(16000);
      const result = await guestStep({ wick: { runCommand } } as unknown as AppContext, job, 1, {
        action: 'inspect',
        content: 'x'.repeat(12000),
      });
      expect(result.state).toBe('not_started');
      expect(runCommand).toHaveBeenCalledTimes(1);
    } finally {
      await rm('/tmp/wick-broker-coding/' + id, { recursive: true, force: true });
    }
  });
  it('rejects an oversized incompressible action before native dispatch', async () => {
    const runCommand = vi.fn();
    const result = await guestStep(
      { wick: { runCommand } } as unknown as AppContext,
      { id: randomUUID(), deadline_at: new Date(Date.now() + 60000) },
      1,
      { action: 'write', content: randomBytes(20000).toString('base64') },
    );
    expect(result.state).toBe('failed');
    expect(result.error).toContain('16,000');
    expect(runCommand).not.toHaveBeenCalled();
  });
});
