import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('actual guest file operations and journal (no Linux namespace claim)', () => {
  it('prevents traversal/symlink writes, preserves external edits, and never replays a journaled mutation', () => {
    const id = randomUUID(),
      job = '/tmp/wick-broker-coding/' + id,
      repo = job + '/repository';
    mkdirSync(repo, { recursive: true });
    writeFileSync(repo + '/average.py', 'original');
    writeFileSync(job + '/outside.txt', 'outside-job-secret');
    symlinkSync(job + '/outside.txt', repo + '/link.py');
    function run(sequence: number, action: unknown, deadline = Date.now() / 1000 + 60) {
      const input = { jobId: id, sequence, action, deadline };
      return JSON.parse(
        execFileSync(
          'python3',
          [
            resolve('scripts/coding-guest.py'),
            Buffer.from(JSON.stringify(input)).toString('base64'),
          ],
          { encoding: 'utf8', timeout: 5000 },
        ),
      );
    }
    try {
      expect(run(0, { action: 'write', path: '../outside.txt', content: 'overwrite' }).state).toBe(
        'failed',
      );
      expect(run(1, { action: 'read', path: 'link.py' }).state).toBe('failed');
      expect(run(2, { action: 'write', path: 'average.py', content: 'overwrite' }).state).toBe(
        'failed',
      );
      expect(run(3, { action: 'read', path: 'average.py' }).result.content).toBe('original');
      writeFileSync(repo + '/average.py', 'external edit');
      expect(run(4, { action: 'write', path: 'average.py', content: 'overwrite' }).state).toBe(
        'failed',
      );
      expect(readFileSync(repo + '/average.py', 'utf8')).toBe('external edit');
      expect(run(5, { action: 'read', path: 'average.py' }).state).toBe('completed');
      expect(
        run(6, { action: 'write', path: 'average.py', content: 'accepted change' }).state,
      ).toBe('completed');
      expect(
        run(6, { action: 'write', path: 'average.py', content: 'must not replay' }).state,
      ).toBe('completed');
      expect(readFileSync(repo + '/average.py', 'utf8')).toBe('accepted change');
      writeFileSync(job + '/7.json', JSON.stringify({ state: 'unknown' }));
      expect(run(7, { action: 'write', path: 'new.txt', content: 'must not run' }).state).toBe(
        'unknown',
      );
      expect(run(8, { action: 'write', path: 'late.txt', content: 'late' }, 1).state).toBe(
        'failed',
      );
      expect(readFileSync(job + '/outside.txt', 'utf8')).toBe('outside-job-secret');
    } finally {
      rmSync(job, { recursive: true, force: true });
    }
  });
});
