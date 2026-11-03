#!/usr/bin/env node
// Keep scanner installation and reports outside the repository; print metadata only.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '8.30.1';
// SHA-256 digests published for the official v8.30.1 release assets.
const digests = {
  darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
const options = new Set(process.argv.slice(2));
const envOption = [...options].find((arg) => arg.startsWith('--known-env='));
for (const option of options)
  if (!['--source-only', '--self-test'].includes(option) && option !== envOption)
    throw Error(`Unknown option: ${option.split('=')[0]}`);
const scratch = await mkdtemp(join(tmpdir(), 'wick-secret-scan-'));
await chmod(scratch, 0o700);
let failures = 0;
let scanConfig = join(root, '.gitleaks.toml');
const isArchive = (path) => /\.(?:tgz|tar(?:\.gz)?|zip)$/i.test(path);
function expandArchive(path) {
  run('python3', [join(root, 'scripts/secret-scan-archives.py'), path, `${path}.contents`]);
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    ...extra,
  });
  if (result.error || result.signal || result.status !== 0)
    throw Error(
      `${command === 'git' ? 'Git' : 'Tool'} operation failed (${result.status ?? result.signal ?? 'spawn error'}).`,
    );
  return result.stdout;
}

async function installScanner() {
  const platform = `${process.platform}_${process.arch}`;
  const digest = digests[platform];
  if (!digest)
    throw Error(`Unsupported platform ${platform}; use a supported Linux or macOS runner.`);
  const asset = `gitleaks_${version}_${platform}.tar.gz`;
  const response = await fetch(
    `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}`,
    {
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok) throw Error(`Pinned scanner download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw Error('Pinned scanner archive checksum mismatch.');
  const archive = join(scratch, asset);
  await writeFile(archive, bytes, { mode: 0o600 });
  run('tar', ['-xzf', archive, '-C', scratch, 'gitleaks']);
  const binary = join(scratch, 'gitleaks');
  await chmod(binary, 0o700);
  if (run(binary, ['version']).trim() !== version) throw Error('Unexpected scanner version.');
  return binary;
}

let reportNumber = 0;
async function scan(binary, mode, target, { config = true, history = false } = {}) {
  const report = join(scratch, `report-${reportNumber++}.json`);
  const args = [
    mode,
    target,
    '--redact=100',
    '--no-banner',
    '--no-color',
    '--ignore-gitleaks-allow',
    '--gitleaks-ignore-path',
    join(scratch, 'empty.ignore'),
    '--exit-code=23',
    '--max-archive-depth=4',
    '--max-decode-depth=5',
    '--timeout=300',
    '--report-format=json',
    '--report-path',
    report,
  ];
  if (config) args.push('--config', scanConfig);
  else args.push('--config', join(scratch, 'defaults.toml'));
  if (history) args.push('--log-opts=--all --full-history');
  // Do not forward tool output: even a redacted match may contain another secret.
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 360000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.signal || ![0, 23].includes(result.status))
    throw Error(
      `Secret scan failed to complete (${mode}; ${result.status ?? result.signal ?? 'spawn error'}).`,
    );
  const findings = JSON.parse(await readFile(report, 'utf8'));
  if (!Array.isArray(findings) || (result.status === 23 && !findings.length))
    throw Error('Secret scanner returned an inconsistent report.');
  return findings;
}

function reportFindings(label, findings) {
  for (const finding of findings) {
    const file = finding.File.startsWith(scratch + sep)
      ? relative(scratch, finding.File)
      : finding.File;
    console.error(
      JSON.stringify({
        scope: label,
        rule: finding.RuleID,
        file,
        line: finding.StartLine,
        ...(finding.Commit ? { commit: finding.Commit.slice(0, 12) } : {}),
      }),
    );
  }
  failures += findings.length;
  console.log(`${label}: ${findings.length} secret-scanner finding(s).`);
}

async function selfTest(binary) {
  run('python3', ['-B', join(root, 'scripts/secret-scan-archives.test.py')]);
  const dir = join(scratch, 'self-test');
  await mkdir(dir);
  const fake = `gh${'p_'}${randomBytes(20).toString('hex')}`;
  await writeFile(join(dir, 'canary.txt'), `token=${fake}\n`);
  if (!(await scan(binary, 'dir', dir, { config: false })).length)
    throw Error('Scanner self-test failed: plaintext canary was not detected.');
  run('git', ['init', '-q', dir]);
  run('git', ['-C', dir, 'add', 'canary.txt']);
  run('git', [
    '-C',
    dir,
    '-c',
    'user.name=Scanner self-test',
    '-c',
    'user.email=scanner@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'Synthetic scanner canary',
  ]);
  await writeFile(join(dir, 'canary.txt'), 'removed\n');
  run('git', ['-C', dir, 'add', 'canary.txt']);
  run('git', [
    '-C',
    dir,
    '-c',
    'user.name=Scanner self-test',
    '-c',
    'user.email=scanner@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'Remove synthetic canary',
  ]);
  if (!(await scan(binary, 'git', dir, { config: false, history: true })).length)
    throw Error('Scanner self-test failed: deleted history canary was not detected.');
  await writeFile(join(dir, 'canary.txt'), `token=${fake}\n`);
  const archive = join(scratch, 'canary.tgz');
  run('tar', ['-czf', archive, '-C', dir, 'canary.txt']);
  expandArchive(archive);
  if (!(await scan(binary, 'dir', `${archive}.contents`, { config: false })).length)
    throw Error('Scanner self-test failed: archive canary was not detected.');
  console.log('Scanner self-test passed: plaintext, deleted history, and archive canaries.');
}

async function knownSecrets() {
  if (!envOption) return [];
  const env = await readFile(resolve(envOption.slice('--known-env='.length)), 'utf8');
  const values = [];
  for (const line of env.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !/(?:SECRET|PASSWORD|TOKEN|API_KEY|CREDENTIAL|DATABASE_URL)/.test(match[1]))
      continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (value.length >= 12) values.push(Buffer.from(value));
  }
  if (!values.length)
    throw Error('Known-secret comparison requested, but no eligible private values were found.');
  return values;
}

function compareKnown(bytes, path, values) {
  if (values.some((value) => bytes.includes(value))) {
    failures++;
    console.error(JSON.stringify({ scope: 'known-private-value', file: path }));
  }
}

async function stageFile(path, target, values) {
  const source = resolve(root, path);
  if (!source.startsWith(root + sep)) throw Error('Refusing a path outside the repository.');
  const stat = await lstat(source);
  if (!stat.isFile()) throw Error(`Release scan requires a regular file: ${path}`);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  if (values.length) compareKnown(await readFile(target), path, values);
  if (isArchive(path)) expandArchive(target);
}

async function stageTree(path, target, values) {
  const stat = await lstat(resolve(root, path));
  if (!stat.isDirectory()) throw Error(`Expected build directory: ${path}`);
  let count = 0;
  for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error(`Refusing a build symlink: ${join(path, entry.name)}`);
    const child = join(path, entry.name),
      destination = join(target, entry.name);
    if (entry.isDirectory()) count += await stageTree(child, destination, values);
    else {
      await stageFile(child, destination, values);
      count++;
    }
  }
  return count;
}

try {
  await writeFile(join(scratch, 'empty.ignore'), '');
  await writeFile(join(scratch, 'defaults.toml'), '[extend]\nuseDefault = true\n');
  const binary = await installScanner();
  await selfTest(binary);
  if (!options.has('--self-test')) {
    if (run('git', ['rev-parse', '--is-shallow-repository']).trim() !== 'false')
      throw Error('Full-history scan requires an unshallow checkout (CI fetch-depth: 0).');
    const values = await knownSecrets();
    if (values.length) {
      scanConfig = join(scratch, 'known-private-values.toml');
      const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await writeFile(
        scanConfig,
        `[extend]\npath = ${JSON.stringify(join(root, '.gitleaks.toml'))}\n` +
          values
            .map(
              (value, index) =>
                `\n[[rules]]\nid = "known-private-value-${index}"\nregex = ${JSON.stringify(escapeRegex(value.toString()))}\n`,
            )
            .join(''),
        { mode: 0o600 },
      );
    }
    const stage = join(scratch, 'public-tree');
    await mkdir(stage);
    const paths = [
      ...new Set(
        run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
          .split('\0')
          .filter(Boolean),
      ),
    ];
    let sourceFiles = 0;
    for (const path of paths) {
      try {
        await stageFile(path, join(stage, path), values);
        sourceFiles++;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      } // Deleted tracked files remain covered by history.
    }
    let builtFiles = 0;
    if (!options.has('--source-only'))
      for (const path of ['dist', 'packages/sdk/dist', 'packages/cli/dist', 'packages/mcp/dist']) {
        const count = await stageTree(path, join(stage, path), values);
        if (!count) throw Error(`Build artifact directory is empty: ${path}`);
        builtFiles += count;
      }
    reportFindings('history', await scan(binary, 'git', root, { history: true }));
    reportFindings('public worktree and build artifacts', await scan(binary, 'dir', stage));
    const archiveRoot = join(scratch, 'historical-archives');
    await mkdir(archiveRoot);
    const objects = run('git', ['rev-list', '--objects', '--all']).trim().split('\n');
    let archives = 0,
      comparedBlobs = 0;
    for (const entry of objects) {
      const split = entry.indexOf(' ');
      if (split < 0) continue;
      const oid = entry.slice(0, split),
        path = entry.slice(split + 1);
      const archive = isArchive(path);
      if (!archive && !values.length) continue;
      if (run('git', ['cat-file', '-t', oid]).trim() !== 'blob') continue;
      const bytes = run('git', ['cat-file', 'blob', oid], { encoding: null });
      if (values.length) {
        compareKnown(bytes, `git:${oid.slice(0, 12)}:${path}`, values);
        comparedBlobs++;
      }
      if (archive) {
        const destination = join(archiveRoot, oid, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { mode: 0o600 });
        expandArchive(destination);
        archives++;
      }
    }
    reportFindings('historical archive contents', await scan(binary, 'dir', archiveRoot));
    console.log(
      JSON.stringify({
        scanner: `gitleaks ${version}`,
        commit: run('git', ['rev-parse', 'HEAD']).trim(),
        reachableCommits: Number(run('git', ['rev-list', '--all', '--count']).trim()),
        sourceFiles,
        builtFiles,
        historicalArchives: archives,
        ...(values.length
          ? { knownPrivateValues: values.length, comparedHistoricalBlobs: comparedBlobs }
          : {}),
        findings: failures,
      }),
    );
    if (failures) process.exitCode = 1;
  }
} catch (error) {
  // Avoid raw subprocess output, fetch URLs, or environment values in failures.
  console.error(
    `Secret scan stopped: ${error instanceof Error ? error.message : 'unknown failure'}`,
  );
  process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
