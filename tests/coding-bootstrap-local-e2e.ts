/** Opt-in local Linux regression for mounted commands with NoNewPrivs=1.
 * Uses only a disposable Docker container/image; no Broker or provider credentials.
 * Requires Docker with privileged containers for the nested namespace test.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(process.env.RUN_CODING_BOOTSTRAP_E2E, '1', 'Set RUN_CODING_BOOTSTRAP_E2E=1.');
const runId = randomUUID();
const container = `wick-coding-bootstrap-${runId}`;
const image = `wick-coding-bootstrap:${runId}`;
const output = resolve('verification-results', `coding-bootstrap-${runId}.json`);
const checks: string[] = [];
const report: Record<string, unknown> = {
  runId,
  passed: false,
  mode: 'actual disposable Debian Linux, unprivileged NoNewPrivs process',
  checks,
};
function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, {
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
try {
  docker(
    ['build', '-q', '-t', image, '-'],
    `FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 git ca-certificates && useradd -m -u 1000 guest
USER 1000:1000
CMD ["sleep", "infinity"]
`,
  );
  docker([
    'run',
    '-d',
    '--privileged',
    '--security-opt',
    'no-new-privileges=true',
    '--name',
    container,
    image,
  ]);
  docker(['cp', 'scripts/coding-guest.py', `${container}:/tmp/coding-guest.py`]);
  const initial = docker([
    'exec',
    container,
    'sh',
    '-c',
    'id; grep NoNewPrivs /proc/self/status; command -v git; ! command -v bwrap',
  ]);
  assert.match(initial, /uid=1000/);
  assert.match(initial, /NoNewPrivs:\s+1/);
  checks.push('actual nonroot NoNewPrivs guest without system bubblewrap');

  function invoke(jobId: string, sequence: number, action: string) {
    const payload = {
      jobId,
      sequence,
      action: { action },
      deadline: Date.now() / 1000 + 150,
      allowBootstrap: true,
      repositoryUrl: 'https://github.com/octocat/Hello-World',
      commitSha: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
      testCommand:
        'test ! -e /workspace && test ! -e /root && test ! -e /tmp/coding-guest.py && ! python3 -c \'import socket; socket.create_connection(("1.1.1.1",443),timeout=1)\' 2>/dev/null && printf isolated',
    };
    return JSON.parse(
      docker([
        'exec',
        container,
        'python3',
        '/tmp/coding-guest.py',
        Buffer.from(JSON.stringify(payload)).toString('base64'),
      ]),
    );
  }
  const jobId = randomUUID();
  const clone = invoke(jobId, 0, 'clone');
  assert.equal(clone.state, 'completed', JSON.stringify(clone));
  checks.push('APT-authenticated download and extraction before a real pinned GitHub clone');
  const test = invoke(jobId, 1, 'test');
  assert.equal(test.state, 'completed', JSON.stringify(test));
  assert.equal(test.result.exitCode, 0, JSON.stringify(test));
  assert.equal(test.result.output, 'isolated');
  checks.push(
    'a new guest process reuses private bubblewrap; host files and network are inaccessible',
  );
  const after = docker([
    'exec',
    container,
    'sh',
    '-c',
    `! command -v bwrap && test -x /tmp/wick-broker-coding/${jobId}/runtime/usr/bin/bwrap && grep NoNewPrivs /proc/self/status`,
  ]);
  assert.match(after, /NoNewPrivs:\s+1/);
  checks.push('system packages untouched and NoNewPrivs remains enabled');

  // Alter only this test-owned container to reproduce a guest without an APT cache.
  docker(['exec', '--user', '0', container, 'sh', '-c', 'rm -rf /var/lib/apt/lists/*']);
  const unsupportedId = randomUUID();
  const unsupported = invoke(unsupportedId, 0, 'clone');
  assert.equal(unsupported.state, 'failed', JSON.stringify(unsupported));
  assert.match(unsupported.error, /Authenticated sandbox package download failed/);
  docker([
    'exec',
    container,
    'test',
    '!',
    '-e',
    `/tmp/wick-broker-coding/${unsupportedId}/repository/.git`,
  ]);
  checks.push('missing authenticated package metadata fails before any clone');
  report.passed = true;
} catch (error) {
  report.error =
    error instanceof Error ? error.message.slice(0, 2000) : 'Bootstrap regression failed';
  process.exitCode = 1;
} finally {
  const cleanup: Record<string, boolean> = {};
  try {
    docker(['rm', '-f', container]);
    cleanup.containerRemoved = true;
  } catch {
    cleanup.containerRemoved = false;
  }
  try {
    docker(['image', 'rm', image]);
    cleanup.imageRemoved = true;
  } catch {
    cleanup.imageRemoved = false;
  }
  report.cleanup = cleanup;
  if (!cleanup.containerRemoved || !cleanup.imageRemoved) {
    report.passed = false;
    process.exitCode = 1;
  }
  mkdirSync(resolve('verification-results'), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...report, report: output }));
}
