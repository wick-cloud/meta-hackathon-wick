import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import type { Row } from '../marketplace/data.js';

const receiptSchema = z.object({
  state: z.enum(['completed', 'failed', 'running', 'unknown', 'not_started']).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(500).optional(),
  stopRequested: z.boolean().optional(),
});
export async function guestStep(
  ctx: AppContext,
  job: Row,
  sequence: number,
  action: Record<string, unknown>,
) {
  if (!ctx.wick.runCommand)
    throw new HttpError(409, 'This VM adapter does not expose structured command execution.');
  const script = await readFile(resolve('scripts/coding-guest.py'), 'utf8');
  const input = {
    jobId: job.id,
    allowBootstrap: Boolean(job.studio_task_id),
    sequence,
    action,
    repositoryUrl: job.repository_url,
    commitSha: job.commit_sha,
    testCommand: job.test_command,
    deadline: new Date(job.deadline_at).getTime() / 1000,
  };
  // Wick accepts at most 16,000 command characters. Compress both the executor
  // and its input so ordinary file actions also fit the native API envelope.
  const encodedScript = deflateSync(Buffer.from(script)).toString('base64');
  const encodedInput = deflateSync(Buffer.from(JSON.stringify(input))).toString('base64');
  const command = `env -i PATH=/usr/local/bin:/usr/bin:/bin python3 -I -c 'import base64,zlib,sys;sys.argv[1]=base64.b64encode(zlib.decompress(base64.b64decode(sys.argv[1]))).decode();exec(zlib.decompress(base64.b64decode("${encodedScript}")))' '${encodedInput}'`;
  if (command.length > 16000)
    return {
      state: 'failed' as const,
      error: 'Coding action exceeds Wick’s 16,000-character command limit.',
    };
  const result = await ctx.wick.runCommand(job.environment_id, { command });
  if (result.exitCode === 127)
    return {
      state: 'failed' as const,
      error: 'This VM requires Python 3 to run the coding executor.',
    };
  if (result.exitCode !== 0 || (result.simulated && job.source_mode === 'real'))
    throw new HttpError(409, 'Wick did not return a valid coding command receipt.');
  try {
    return receiptSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new HttpError(409, 'The coding command outcome needs reconciliation.');
  }
}
