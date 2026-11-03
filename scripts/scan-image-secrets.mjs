#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const image = process.argv[2];
const severities = new Set(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
let directory;
let child;
let interrupted = false;
let killTimer;

function interrupt(signal) {
  interrupted = true;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  child?.kill('SIGTERM');
  killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 5000);
  killTimer.unref();
}
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

async function scan(args) {
  // Do not inherit scan filters, remote scanner endpoints, or unrelated registry tokens.
  const allowedEnv = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => allowedEnv.has(name)),
  );
  return new Promise((resolveScan, reject) => {
    child = spawn('trivy', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Even scanner diagnostics can include file content. Never forward either stream.
    child.stdout.resume();
    child.stderr.resume();
    const timeout = setTimeout(() => child?.kill('SIGKILL'), 660_000);
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('scanner-start'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      child = undefined;
      if (interrupted || signal || ![0, 23].includes(code)) reject(new Error('scanner-incomplete'));
      else resolveScan(code);
    });
  });
}

try {
  if (process.argv.length !== 3 || !/^[a-z0-9][a-z0-9._/:@-]{0,255}$/.test(image ?? ''))
    throw new Error('invalid-image');
  directory = await mkdtemp(join(tmpdir(), 'broker-image-secrets-'));
  await chmod(directory, 0o700);
  const reportPath = join(directory, 'report.json');
  const configPath = join(directory, 'trivy.yaml');
  const cachePath = join(directory, 'cache');
  await mkdir(cachePath, { mode: 0o700 });
  await writeFile(configPath, '{}\n', { mode: 0o600 });
  await writeFile(reportPath, '', { mode: 0o600 });
  if (interrupted) throw new Error('interrupted');
  const code = await scan([
    'image',
    '--config',
    configPath,
    '--cache-dir',
    cachePath,
    '--image-src',
    'docker',
    '--scanners',
    'secret',
    '--image-config-scanners',
    'secret',
    '--secret-config',
    join(root, '.trivy-secret.yaml'),
    '--severity',
    [...severities].join(','),
    '--ignorefile',
    '/dev/null',
    '--format',
    'json',
    '--output',
    reportPath,
    '--exit-code',
    '23',
    '--no-progress',
    '--quiet',
    '--disable-telemetry',
    '--timeout',
    '10m',
    image,
  ]);
  if ((await stat(reportPath)).size > 64 * 1024 * 1024) throw new Error('oversized-report');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (
    report.SchemaVersion !== 2 ||
    report.ArtifactType !== 'container_image' ||
    typeof report.Metadata?.ImageID !== 'string' ||
    !report.Metadata.ImageID ||
    (report.Results !== undefined && !Array.isArray(report.Results))
  )
    throw new Error('invalid-report');
  const findings = [];
  for (const result of report.Results ?? []) {
    if (result.Secrets === undefined) continue;
    if (!Array.isArray(result.Secrets)) throw new Error('invalid-findings');
    for (const finding of result.Secrets) {
      if (
        typeof finding.RuleID !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,160}$/.test(finding.RuleID) ||
        typeof result.Target !== 'string' ||
        !result.Target ||
        result.Target.length > 4096 ||
        !severities.has(finding.Severity) ||
        !Number.isInteger(finding.StartLine) ||
        finding.StartLine < 0
      )
        throw new Error('invalid-finding');
      findings.push({
        rule: finding.RuleID,
        path: result.Target,
        severity: finding.Severity,
        line: finding.StartLine,
      });
    }
  }
  const hasFindings = findings.length > 0;
  if ((code === 23) !== hasFindings) throw new Error('inconsistent-report');
  if (interrupted) throw new Error('interrupted');
  for (const finding of findings) console.error(JSON.stringify(finding));
  console.log(JSON.stringify({ scanner: 'trivy-image-secrets', findings: findings.length }));
  if (findings.length) process.exitCode = 1;
} catch {
  // Never expose scanner output, report contents, or exception strings.
  console.error('Container secret scan did not pass; raw diagnostics and matches are withheld.');
  process.exitCode ||= 1;
} finally {
  clearTimeout(killTimer);
  try {
    if (directory) await rm(directory, { recursive: true, force: true });
  } catch {
    console.error('Container secret scan temporary-data cleanup failed.');
    process.exitCode ||= 1;
  }
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
