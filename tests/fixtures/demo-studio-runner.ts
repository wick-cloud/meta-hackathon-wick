import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoStudioRunnerSource } from '../../src/server/demo/studio-script.js';

export type StudioRunnerReceipt = {
  runId: string;
  attempt: number;
  sha256: string;
  valid: boolean;
  stdout: string;
  exitCode: number | null;
  errorCode: string | null;
};

/** Executes the production command and child Python locally. Its fixed workspace
 * is substituted. Darwin cannot set RLIMIT_AS; skip only that unsupported limit
 * in this local fixture, without claiming Linux/native resource qualification. */
export function localStudioRunner() {
  const directory = mkdtempSync(join(tmpdir(), 'wick-demo-studio-test-'));
  const original = demoStudioRunnerSource();
  const marker = 'BASE = pathlib.Path("/workspace")';
  if (!original.includes(marker)) throw new Error('Runner workspace contract changed.');
  let local = original.replace(marker, `BASE = pathlib.Path(${JSON.stringify(directory)})`);
  if (process.platform === 'darwin') {
    const memoryLimit = 'resource.setrlimit(resource.RLIMIT_AS,(64*1024*1024,64*1024*1024))';
    if (!local.includes(memoryLimit)) throw new Error('Runner memory-limit contract changed.');
    local = local.replace(memoryLimit, 'pass # Darwin-only fixture: RLIMIT_AS is unsupported');
  }
  return {
    directory,
    execute(command: string): StudioRunnerReceipt {
      const encoded = Buffer.from(original).toString('base64');
      if (!command.includes(encoded))
        throw new Error('Expected the production guided runner command.');
      const actual = command.replace(encoded, Buffer.from(local).toString('base64'));
      try {
        return JSON.parse(
          execFileSync('/bin/sh', ['-c', actual], {
            encoding: 'utf8',
            timeout: 7000,
            maxBuffer: 16384,
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
        );
      } catch (error) {
        const failure = error as Error & { stderr?: string; status?: number };
        throw new Error(
          `Local guided runner failed (${failure.status ?? 'unknown'}): ${String(failure.stderr ?? '').slice(-1200)}`,
        );
      }
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
