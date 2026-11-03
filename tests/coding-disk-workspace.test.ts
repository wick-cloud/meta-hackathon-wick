import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// Runs actual guest file/journal operations. Only the mount location changes so
// these tests never need to mount or write /workspace on the developer machine.
// This does not qualify any provider's filesystem or Linux namespace support.
describe('persistent guest workspace files and separate task journals', () => {
  it('keeps saved files across jobs, uses a fresh journal and detects external deletion', () => {
    const base = mkdtempSync(join(tmpdir(), 'wick-disk-'));
    const workspaceId = randomUUID();
    const repository = join(base, 'workspaces', workspaceId, 'repository');
    const jobs = [randomUUID(), randomUUID()];
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(repository, 'saved.txt'), 'previous task');
    const script = readFileSync(resolve('scripts/coding-guest.py'), 'utf8').replace(
      'mount = Path("/workspace")',
      `mount = Path(${JSON.stringify(base)})`,
    );
    const run = (jobId: string, sequence: number, action: unknown) =>
      JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            script,
            Buffer.from(
              JSON.stringify({
                jobId,
                workspaceId,
                continuingWorkspace: true,
                sequence,
                action,
                deadline: Date.now() / 1000 + 60,
              }),
            ).toString('base64'),
          ],
          { encoding: 'utf8', timeout: 5000 },
        ),
      );
    try {
      expect(run(jobs[0]!, 0, { action: 'read', path: 'saved.txt' }).result.content).toBe(
        'previous task',
      );
      expect(
        run(jobs[0]!, 1, { action: 'write', path: 'saved.txt', content: 'retained change' }).state,
      ).toBe('completed');
      // Same sequence belongs to a different job: it observes disk contents,
      // rather than replaying the previous task's read receipt.
      expect(run(jobs[1]!, 0, { action: 'read', path: 'saved.txt' }).result.content).toBe(
        'retained change',
      );
      unlinkSync(join(repository, 'saved.txt'));
      expect(
        run(jobs[1]!, 1, {
          action: 'write',
          path: 'saved.txt',
          content: 'would overwrite external deletion',
        }).state,
      ).toBe('failed');
      expect(
        run(jobs[1]!, 2, { action: 'write', path: '../other.txt', content: 'escape' }).state,
      ).toBe('failed');
      expect(readFileSync(join('/tmp/wick-broker-coding', jobs[0]!, '0.json'), 'utf8')).toContain(
        'previous task',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
      for (const id of jobs)
        rmSync(join('/tmp/wick-broker-coding', id), { recursive: true, force: true });
    }
  });

  it('prepares a continued Git checkout without resetting tracked or untracked work and exports bounded results', () => {
    const base = mkdtempSync(join(tmpdir(), 'wick-disk-'));
    const workspaceId = randomUUID(),
      jobId = randomUUID();
    const repository = join(base, 'workspaces', workspaceId, 'repository');
    mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '-q', repository]);
    writeFileSync(join(repository, 'saved.txt'), 'pinned original');
    execFileSync('git', ['-C', repository, 'add', 'saved.txt']);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'Pinned fixture',
    ]);
    const commitSha = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(repository, 'saved.txt'), 'uncommitted previous change');
    writeFileSync(join(repository, 'untracked.txt'), 'previous output');
    // The real Git/files/journals run locally. This test replaces only the Linux
    // namespace transport and its probe; it makes no namespace-isolation claim.
    const harness = `import shlex
resource.setrlimit = lambda *args: None
original_execute = execute
sandbox = lambda command: ["/bin/sh", "-c", "cd " + shlex.quote(str(repo)) + " && " + command]
def local_execute(args, cwd=None, seconds=90):
    if args[-1].endswith("printf isolated"):
        return {"exitCode": 0, "output": "isolated"}
    return original_execute(args, cwd, seconds)
execute = local_execute
print(json.dumps(main()))`;
    const script = readFileSync(resolve('scripts/coding-guest.py'), 'utf8')
      .replace('mount = Path("/workspace")', `mount = Path(${JSON.stringify(base)})`)
      .replace('print(json.dumps(main()))', harness.replaceAll('\n', '\n    '));
    const run = (sequence: number, action: unknown, continuingWorkspace = true) =>
      JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            script,
            Buffer.from(
              JSON.stringify({
                jobId,
                workspaceId,
                sequence,
                action,
                continuingWorkspace,
                repositoryUrl: 'https://github.com/example/public',
                commitSha,
                testCommand: "printf 'all tests passed'",
                deadline: Date.now() / 1000 + 60,
              }),
            ).toString('base64'),
          ],
          { encoding: 'utf8', timeout: 5000 },
        ),
      );
    try {
      const prepared = run(0, { action: 'clone' });
      expect(prepared.state, JSON.stringify(prepared)).toBe('completed');
      expect(prepared.result.files.sort()).toEqual(['saved.txt', 'untracked.txt']);
      expect(prepared.result.continuingWorkspace).toBe(true);
      expect(readFileSync(join(repository, 'saved.txt'), 'utf8')).toBe(
        'uncommitted previous change',
      );
      expect(readFileSync(join(repository, 'untracked.txt'), 'utf8')).toBe('previous output');
      expect(
        execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      ).toBe(commitSha);
      expect(run(1, { action: 'test' }).state).toBe('completed');
      const receipt = JSON.parse(
        readFileSync(
          join(base, 'workspaces', workspaceId, 'artifacts', `${jobId}.test.1.json`),
          'utf8',
        ),
      );
      expect(receipt.result).toMatchObject({ exitCode: 0, output: 'all tests passed' });
      expect(run(2, { action: 'diff', summary: 'Continued previous work' }).state).toBe(
        'completed',
      );
      expect(
        readFileSync(join(base, 'workspaces', workspaceId, 'artifacts', `${jobId}.patch`), 'utf8'),
      ).toContain('+uncommitted previous change');
      expect(
        JSON.parse(
          readFileSync(join(base, 'workspaces', workspaceId, 'artifacts', `${jobId}.json`), 'utf8'),
        ),
      ).toMatchObject({ baseCommit: commitSha, summary: 'Continued previous work' });
      expect(run(3, { action: 'clone' }, false).state).toBe('failed');
      expect(readFileSync(join(repository, 'saved.txt'), 'utf8')).toBe(
        'uncommitted previous change',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(join('/tmp/wick-broker-coding', jobId), { recursive: true, force: true });
    }
  });

  it('binds only the selected repository into the sandbox', () => {
    const base = mkdtempSync(join(tmpdir(), 'wick-disk-'));
    const workspaceId = randomUUID(),
      jobId = randomUUID();
    const repository = join(base, 'workspaces', workspaceId, 'repository');
    mkdirSync(repository, { recursive: true });
    const script = readFileSync(resolve('scripts/coding-guest.py'), 'utf8')
      .replace('mount = Path("/workspace")', `mount = Path(${JSON.stringify(base)})`)
      .replace(
        'print(json.dumps(main()))',
        'shutil.which = lambda *args, **kwargs: "/usr/bin/bwrap"; print(json.dumps(sandbox("true")))',
      );
    try {
      const command = JSON.parse(
        execFileSync(
          'python3',
          ['-c', script, Buffer.from(JSON.stringify({ jobId, workspaceId })).toString('base64')],
          { encoding: 'utf8' },
        ),
      );
      const binding = command.indexOf('--bind');
      expect(command.slice(binding, binding + 3)).toEqual(['--bind', repository, '/repo']);
      expect(command).not.toContain(base);
      expect(command).not.toContain('/workspace');
      expect(command).toContain('--unshare-all');
      expect(command).toContain('--clearenv');
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(join('/tmp/wick-broker-coding', jobId), { recursive: true, force: true });
    }
  });

  it('rejects a saved workspace symlink before reading another directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'wick-disk-'));
    const workspaceId = randomUUID(),
      jobId = randomUUID();
    mkdirSync(join(base, 'workspaces'));
    mkdirSync(join(base, 'outside', 'repository'), { recursive: true });
    writeFileSync(join(base, 'outside', 'repository', 'secret.txt'), 'outside workspace');
    symlinkSync(join(base, 'outside'), join(base, 'workspaces', workspaceId));
    const script = readFileSync(resolve('scripts/coding-guest.py'), 'utf8').replace(
      'mount = Path("/workspace")',
      `mount = Path(${JSON.stringify(base)})`,
    );
    try {
      expect(() =>
        execFileSync(
          'python3',
          [
            '-c',
            script,
            Buffer.from(
              JSON.stringify({
                jobId,
                workspaceId,
                sequence: 0,
                action: { action: 'read', path: 'secret.txt' },
                deadline: Date.now() / 1000 + 60,
              }),
            ).toString('base64'),
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      ).toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(join('/tmp/wick-broker-coding', jobId), { recursive: true, force: true });
    }
  });
});
